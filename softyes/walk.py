"""The Soft Yes walk.

A founder names the investors who said "we're in if you find a lead".
We walk the Cala graph:   investor -> rounds it joined but did not lead -> who led them
and then check each lead: lead -> its own rounds -> how often, how recently, at what stage it leads.

The ranking is plain arithmetic on Cala facts. No model takes part in it.
"""
from __future__ import annotations

import asyncio
import collections
import hashlib
import json
import time
from datetime import date
from typing import Awaitable, Callable

from . import graph, knowledge
from .cala import BudgetExceeded, Cala, CalaError, Ledger

FOLLOW_CAP = 20     # followed rounds walked per soft-yes investor (most recently reported first)
PULSE_TOP = 12      # leads whose own record is read
VERIFY_TOP = 5      # leads whose most recent led rounds are opened to get the real date
VERIFY_ROUNDS = 2
RING2_TOP = 6       # co-investors checked for "sat beside you and leads elsewhere"
RECENT_MONTHS = 24
THIN_FOLLOWED = 3    # below this many followed rounds, also walk the soft yes's cap tables
CAP_COMPANIES = 8    # portfolio companies opened on that path
CAP_ROUNDS = 2       # most recent rounds opened per portfolio company
CAP_WEIGHT = 0.6     # "led a round in a company you both back" counts less than "led a round you joined"
SOFT_LED_ROUNDS = 3  # a soft yes's own most recent led rounds, opened for the follower profile
DEEP_BELOW = 8       # fewer followed rounds than this in the graph: also ask Cala's knowledge search

Emit = Callable[[dict], Awaitable[None]]


def run_id(inputs: dict) -> str:
    key = {"s": sorted(sorted(s["ids"]) for s in inputs["soft_yeses"]), "stage": inputs.get("stage"),
           "company": (inputs.get("company") or {}).get("id")}
    return hashlib.sha256(json.dumps(key, sort_keys=True).encode()).hexdigest()[:10]


def _recency(iso: str | None) -> float:
    y = graph.years_ago(iso)
    return 0.4 if y is None else 0.5 ** (max(y, 0) / 3)


def _stage_weight(stage: str | None, want: str | None) -> float:
    if not want or not stage or stage not in graph.STAGE_ORDER or want not in graph.STAGE_ORDER:
        return 1.0 if not want else 0.6
    gap = abs(graph.STAGE_ORDER.index(stage) - graph.STAGE_ORDER.index(want))
    return 1.0 if gap == 0 else 0.7 if gap == 1 else 0.45


def _months_ago(iso: str | None) -> float | None:
    y = graph.years_ago(iso)
    return None if y is None else y * 12


def _round_brief(rd: dict) -> dict:
    return {"id": rd["id"], "issuer": rd["issuer"], "stage": rd["stage"], "stage_name": rd["stage_name"],
            "date": rd["date"], "amount": rd["amount"], "currency": rd["currency"]}


def _pulse(inv: dict) -> dict:
    """What an investor's own round list says about how it behaves. Dates here are first-report dates."""
    rounds = inv["rounds"]
    led = [r for r in rounds if r["is_lead"]]
    by_year: dict[str, dict] = {}
    for r in rounds:
        y = (r["reported"] or "")[:4]
        if not y:
            continue
        slot = by_year.setdefault(y, {"year": int(y), "joined": 0, "led": 0})
        slot["joined"] += 1
        slot["led"] += r["is_lead"]
    years = sorted(by_year.values(), key=lambda s: s["year"])
    this_year = date.today().year
    filled = []
    if years:
        have = {s["year"]: s for s in years}
        for y in range(max(years[0]["year"], this_year - 7), this_year + 1):
            filled.append(have.get(y, {"year": y, "joined": 0, "led": 0}))
    led_recent = sum(1 for r in led if (_months_ago(r["reported"]) or 999) <= RECENT_MONTHS)
    stages = collections.Counter(r["label"] for r in led if r["label"])
    return {"rounds": len(rounds), "led": len(led), "lead_rate": round(len(led) / len(rounds), 2) if rounds else None,
            "led_recent": led_recent, "recent_months": RECENT_MONTHS, "by_year": filled,
            "led_stages": [{"stage": s, "n": n} for s, n in stages.most_common(5)],
            "capped": inv["capped"], "portfolio_size": len(inv["portfolio"])}


def _merge(invs: list[dict]) -> dict:
    """One investor from the several Cala entities that are it: rounds and portfolio de-duplicated."""
    rounds, portfolio, seen_r, seen_c = [], [], set(), set()
    for inv in invs:
        for r in inv["rounds"]:
            if r["id"] not in seen_r:
                seen_r.add(r["id"])
                rounds.append(r)
        for c in inv["portfolio"]:
            if c["id"] not in seen_c:
                seen_c.add(c["id"])
                portfolio.append(c)
    return {**invs[0], "rounds": rounds, "portfolio": portfolio, "capped": any(i["capped"] for i in invs)}


def _same_company(a: str, b: str) -> bool:
    """'corteaai' and 'cortea' are one company: one normalised name starts the other."""
    return a == b or (min(len(a), len(b)) >= 4 and (a.startswith(b) or b.startswith(a)))


def _same_deal(a: dict, b: dict) -> bool:
    """Cala sometimes holds one deal as two round entities (one per report). Same company, and the same
    day, or the same stage in the same month, or the same stage and amount."""
    if not a.get("issuer") or not b.get("issuer"):
        return False
    ia, ib = a["issuer"], b["issuer"]
    if not ((ia.get("id") and ia.get("id") == ib.get("id")) or _same_company(graph.norm(ia["name"]), graph.norm(ib["name"]))):
        return False
    da, db = a.get("date") or "", b.get("date") or ""
    if da and da[:10] == db[:10]:
        return True
    stage = a.get("stage") == b.get("stage") or not a.get("stage") or not b.get("stage")
    if stage and da and da[:7] == db[:7]:
        return True
    return bool(a.get("stage") and a.get("stage") == b.get("stage") and a.get("amount") and a.get("amount") == b.get("amount")
                and a.get("currency") == b.get("currency"))


def _merge_deals(rounds: dict[str, dict], joined: dict, backed: dict) -> collections.Counter:
    """Fold duplicate round entities into one deal: investors and sources united, a lead flag from either kept.
    Returns, per soft yes, how many of its followed rounds were the same deal twice."""
    kept: list[str] = []
    folded: collections.Counter = collections.Counter()
    # graph rounds first, fullest first, so the entity with the most participants is the one that stays
    for rid in sorted(rounds, key=lambda r: (rounds[r].get("via") == "knowledge", -len(rounds[r]["investors"]))):
        rd = rounds[rid]
        twin = next((k for k in kept if _same_deal(rounds[k], rd)), None)
        if not twin:
            kept.append(rid)
            continue
        base = rounds[twin]
        have = {graph.norm(i["name"]): i for i in base["investors"]}
        for i in rd["investors"]:
            mine = have.get(graph.norm(i["name"]))
            if mine:
                mine["is_lead"] = mine["is_lead"] or i["is_lead"]
                mine["sources"] = (mine["sources"] + [x for x in i["sources"] if x["url"] not in {y["url"] for y in mine["sources"]}])[:6]
                mine["id"] = mine["id"] or i["id"]
            else:
                base["investors"].append(i)
        base["sources"] = (base["sources"] + [x for x in rd["sources"] if x["url"] not in {y["url"] for y in base["sources"]}])[:6]
        for k in ("stage", "amount", "currency", "date"):
            base[k] = base.get(k) or rd.get(k)
        if base["stage"]:
            base["stage_name"] = graph.STAGE_NAMES.get(base["stage"], base["stage_name"])
        base["also"] = base.get("also", []) + [rid]
        for k in joined.get(rid, set()) & joined.get(twin, set()):
            folded[k] += 1
        folded["_all"] += 1
        joined[twin] |= joined.pop(rid, set())
        backed[twin] |= backed.pop(rid, set())
    for rid in [r for r in rounds if r not in kept]:
        del rounds[rid]
    return folded


def _plural(n: int, word: str) -> str:
    return f"{n} {word}" if n == 1 else f"{n} {word}s"


def _names(names: list[str]) -> str:
    return names[0] if len(names) == 1 else ", ".join(names[:-1]) + " or " + names[-1]


def _why(e: dict, want_stage: str | None) -> list[dict]:
    """Short reasons for a lead's place, each one a count over Cala facts. tone: good | warn | plain."""
    out = []
    softs = sorted({w for d in e["evidence"] for w in d["with"]})
    n = len(e["evidence"])
    same = [d for d in e["evidence"] if d["relation"] == "round"]
    cap = [d for d in e["evidence"] if d["relation"] == "cap_table"]
    if e["ring"] == 1:
        if same:
            out.append({"tone": "good", "text": f"Led {_plural(len(same), 'round')} that "
                                                f"{_names(sorted({w for d in same for w in d['with']}))} joined"})
        if cap:
            out.append({"tone": "good" if not same else "plain",
                        "text": f"Led {_plural(len(cap), 'round')} in companies "
                                f"{_names(sorted({w for d in cap for w in d['with']}))} backs"})
    else:
        out.append({"tone": "plain", "text": f"Sat in {_plural(n, 'round')} with {_names(softs)} without leading"})
    p = e.get("pulse")
    recent = e.get("led_recent") or 0
    if recent:
        out.append({"tone": "good", "text": f"Led {_plural(recent, 'round')} in the last {RECENT_MONTHS} months"})
    elif p and p["rounds"]:
        out.append({"tone": "warn", "text": f"No lead dated in the last {RECENT_MONTHS} months in Cala"})
    if p and p["rounds"] >= 3:
        out.append({"tone": "plain", "text": f"Leads {p['led']} of its {p['rounds']} rounds in Cala's graph" + ("+" if p["capped"] else "")})
    elif p and p["rounds"]:
        out.append({"tone": "plain", "text": f"Cala's graph lists only {_plural(p['rounds'], 'round')} for it"})
    elif e.get("record") == "missing" or (p and not p["rounds"]):
        out.append({"tone": "plain", "text": "No rounds under this name in Cala's graph; known from reports"})
    else:
        out.append({"tone": "plain", "text": "Own record not read (outside the top of this walk)"})
    f = e.get("fit")
    if f:
        out.append({"tone": "good", "text": f"Has led at {f['stage_name']}"} if f["match"] else
                   {"tone": "warn", "text": f"No {f['stage_name']} lead in Cala"})
    return out


def _verdict(s: dict) -> tuple[str, str]:
    """Is the soft yes a follower by habit, or could it lead? Counted, never guessed."""
    n, led, name = s.get("rounds_in_cala") or 0, s.get("led") or 0, s["name"]
    k = (s.get("knowledge") or {}).get("added") or 0
    more = (f" Cala's knowledge search adds {_plural(k, 'round')} it joined that someone else led, "
            f"each checked against the page that reports it.") if k else ""
    if not s.get("found") or n == 0:
        if k:
            return "thin", f"Cala's graph holds no funding rounds for {name}.{more}"
        return "unknown", f"Cala has no funding rounds for {name}, so there is nothing to walk from it."
    cap = " (the first 50 Cala returns)" if s.get("capped") else ""
    if n + k < 4:
        return "thin", (f"Cala's graph holds only {_plural(n, 'round')} for {name}; it led {led}. "
                        f"Too few to call a habit.{more}")
    count = f"{led} of the {n + k} rounds Cala knows for it ({n} in its graph, {k} more in reports)" if k else \
        f"{led} of its {n} rounds in Cala{cap}"
    rate = led / (n + k)
    if rate >= 0.5:
        return "leads", f"{name} led {count}. It leads more often than it follows: ask what would make it lead yours."
    if rate >= 0.25:
        return "mixed", f"{name} led {count}. It does lead sometimes: worth asking what is missing."
    return "follows", f"{name} led {count}. It follows by habit, so the lead has to come from someone else."


def _headline(softs: list[dict], leads: list[dict]) -> str:
    names = _names([s["name"] for s in softs])
    if not leads:
        return f"Cala shows no outside investor leading a round that {names} joined."
    top = leads[0]
    same = any(d["relation"] == "round" for e in leads for d in e["evidence"])
    cap = any(d["relation"] == "cap_table" for e in leads for d in e["evidence"])
    where = (f"rounds that {names} joined" + (" or in companies they back" if cap else "")) if same else \
        f"rounds in companies that {names} back{'s' if len(softs) == 1 else ''}"
    line = f"{_plural(len(leads), 'investor')} led {where}. Start with {top['name']}"
    n = len(top["evidence"])
    if top.get("led_recent"):
        line += (f": it led {n} of those rounds and {_plural(top['led_recent'], 'round')} "
                 f"in the last {RECENT_MONTHS} months.")
    else:
        line += "."
    return line


async def walk(cala: Cala, inputs: dict, emit: Emit, aliases: Callable[[str], list[str]] | None = None,
               deep: set[str] | None = None) -> dict:
    """`aliases(key)` may return further Cala entity ids already known to be the same investor.

    `deep` names the soft yeses (by key) to also read through Cala's knowledge search. That takes about a
    minute, so the caller runs the graph walk first, shows it, and then walks again with `deep` set.
    """
    t0 = time.time()
    ledger = Ledger()
    notes: list[str] = []
    state = {"cache_only": False}
    want_stage = inputs.get("stage")
    deep = deep or set()

    async def guarded(fn, *args):
        """Run one Cala read. When credits run out, fall back to what is already cached."""
        try:
            return await fn(cala, *args, ledger=ledger, cache_only=state["cache_only"])
        except BudgetExceeded:
            if not state["cache_only"]:
                state["cache_only"] = True
                notes.append("Live reads from Cala are paused (credit cap). Showing what is already walked.")
                await emit({"t": "note", "text": notes[-1]})
            return await fn(cala, *args, ledger=ledger, cache_only=True)
        except CalaError as exc:
            notes.append(f"Cala could not answer one read ({exc}).")
            return None

    async def tick():
        await emit({"t": "ledger", **ledger.as_dict()})

    softs = []
    for s in inputs["soft_yeses"]:
        softs.append({"key": graph.norm(s["name"]), "name": s["name"], "ids": list(dict.fromkeys(s["ids"])),
                      "kind": s.get("kind", "fund")})
    soft_keys = {s["key"] for s in softs}
    soft_ids = {i for s in softs for i in s["ids"]}
    await emit({"t": "start", "soft_yeses": [{"key": s["key"], "name": s["name"]} for s in softs]})

    # 1. Each soft yes: its rounds, then every round it joined without leading.
    rounds: dict[str, dict] = {}            # round id -> round
    joined: dict[str, set[str]] = collections.defaultdict(set)   # round id -> soft keys that followed in it
    backed: dict[str, set[str]] = collections.defaultdict(set)   # round id -> soft keys that back the company (cap table)

    async def walk_soft(s: dict):
        invs = [i for i in await asyncio.gather(*(guarded(graph.investor, uid) for uid in s["ids"])) if i]
        all_rounds, seen = [], set()
        for inv in invs:
            for r in inv["rounds"]:
                if r["id"] not in seen:
                    seen.add(r["id"])
                    all_rounds.append(r)
        led = [r for r in all_rounds if r["is_lead"]]
        followed = sorted((r for r in all_rounds if not r["is_lead"]), key=lambda r: r["reported"] or "", reverse=True)
        todo = followed[:FOLLOW_CAP]
        portfolio, seen_co = [], set()
        for inv in invs:
            for c in inv["portfolio"]:
                if c["id"] not in seen_co:
                    seen_co.add(c["id"])
                    portfolio.append(c)
        merged = {"id": s["ids"][0], "name": s["name"], "rounds": all_rounds, "portfolio": portfolio,
                  "capped": any(i["capped"] for i in invs)}
        s.update({"found": bool(invs), "rounds_in_cala": len(all_rounds), "led": len(led), "followed": len(followed),
                  "lead_rate": round(len(led) / len(all_rounds), 2) if all_rounds else None,
                  "walked": len(todo), "capped": merged["capped"], "pulse": _pulse(merged),
                  "description": next((i["description"] for i in invs if i.get("description")), None),
                  # Cala may hold one firm as several entities; say which ones were read as this investor
                  "entities": [{"id": i["id"], "name": i["name"], "rounds": len(i["rounds"]),
                                "portfolio": len(i["portfolio"])} for i in invs if i["rounds"] or i["portfolio"]]})
        await emit({"t": "investor", "key": s["key"], "name": s["name"], "rounds": len(all_rounds), "led": len(led),
                    "followed": len(followed), "walking": len(todo), **ledger.as_dict()})

        async def open_round(r):
            rd = await guarded(graph.funding_round, r["id"])
            if not rd:
                return
            if not rd["date"]:
                rd["date"] = r["reported"]
                rd["date_is_report"] = True
            rounds[rd["id"]] = rd
            joined[rd["id"]].add(s["key"])
            leads = [i for i in rd["investors"] if i["is_lead"] and i["id"] not in soft_ids
                     and graph.norm(i["name"]) not in soft_keys]
            await emit({"t": "round", "soft": s["key"], "round": _round_brief(rd),
                        "leads": [{"key": graph.norm(i["name"]), "name": i["name"], "kind": i["kind"]} for i in leads],
                        "others": len(rd["investors"]) - len(leads), **ledger.as_dict()})

        own = []

        async def open_led(r):
            rd = await guarded(graph.funding_round, r["id"])
            if rd:
                if not rd["date"]:
                    rd["date"] = r["reported"]
                own.append({**_round_brief(rd), "sources": (r["sources"] or rd["sources"])[:3]})

        # Second pass: put the same question to Cala's knowledge search, which reads the reports themselves.
        thin = len(followed) < THIN_FOLLOWED
        asked = None
        if s["key"] in deep:
            await emit({"t": "knowledge", "soft": s["key"], "name": s["name"], "state": "asking",
                        "graph_rounds": len(all_rounds), **ledger.as_dict()})
            asked = asyncio.create_task(guarded(knowledge.followed, s["name"], s["key"]))

        recent_led = sorted(led, key=lambda r: r["reported"] or "", reverse=True)[:SOFT_LED_ROUNDS]
        await asyncio.gather(*(open_round(r) for r in todo), *(open_led(r) for r in recent_led))
        s["led_rounds"] = sorted(own, key=lambda d: d["date"] or "", reverse=True)

        s["knowledge"] = None
        if asked:
            k = await asked
            added = 0
            for row in (k or {}).get("rows", []):
                issuer = graph.norm(row["company"])
                if any(rd.get("issuer") and _same_company(graph.norm(rd["issuer"]["name"]), issuer)
                       and (rd["stage"] == row["stage"] or (rd["date"] or "")[:7] == (row["date"] or "x")[:7])
                       for rid, rd in rounds.items() if s["key"] in joined[rid]):
                    continue  # the graph already holds this round
                rd = {"id": row["id"], "stage": row["stage"], "via": "knowledge",
                      "stage_name": graph.STAGE_NAMES.get(row["stage"] or "", "Round"),
                      "date": row["date"], "amount": row["amount"], "currency": row["currency"],
                      "issuer": {"id": None, "name": row["company"]}, "sources": row["sources"],
                      "investors": [{"id": None, "name": graph.pretty(n), "type": None, "kind": "fund", "is_lead": True,
                                     "sources": row["sources"]} for n in row["leads"]]}
                rounds.setdefault(rd["id"], rd)
                joined[rd["id"]].add(s["key"])
                added += 1
                await emit({"t": "round", "soft": s["key"], "via": "knowledge", "round": _round_brief(rd),
                            "leads": [{"key": graph.norm(i["name"]), "name": i["name"], "kind": i["kind"]}
                                      for i in rd["investors"] if graph.norm(i["name"]) not in soft_keys],
                            "others": 0, **ledger.as_dict()})
            if k:
                s["knowledge"] = {"question": k["question"], "read": k["read"], "kept": len(k["rows"]), "added": added,
                                  "dropped": k["dropped"], "passages": k["passages"]}
            await emit({"t": "knowledge", "soft": s["key"], "name": s["name"], "state": "done", "rows": added,
                        "dropped": (k or {}).get("dropped", 0), **ledger.as_dict()})

        # Still thin: Cala often knows the investor's portfolio better than its rounds.
        # Walk the cap tables too: portfolio company -> its rounds -> who led them.
        s["cap_companies"] = 0
        if thin and s["key"] in deep and (s["knowledge"] or {}).get("added", 0) < THIN_FOLLOWED and portfolio:
            own_ids = {r["id"] for r in all_rounds}
            issuers = {rd["issuer"]["id"] for rd in rounds.values() if rd.get("issuer")}
            pick = [c for c in sorted(portfolio, key=lambda c: max((x["date"] or "" for x in c["sources"]), default=""),
                                      reverse=True) if c["id"] not in issuers][:CAP_COMPANIES]
            s["cap_companies"] = len(pick)
            await emit({"t": "captable", "soft": s["key"], "name": s["name"], "companies": len(pick), **ledger.as_dict()})

            async def open_company(c):
                listed = await guarded(graph.company_rounds, c["id"])
                recent = sorted((r for r in listed or [] if r["id"] not in own_ids),
                                key=lambda r: r["reported"] or "", reverse=True)[:CAP_ROUNDS]

                async def open_cap_round(r):
                    rd = await guarded(graph.funding_round, r["id"])
                    if not rd:
                        return
                    if not rd["date"]:
                        rd["date"] = r["reported"]
                        rd["date_is_report"] = True
                    if not rd["issuer"]:
                        rd["issuer"] = {"id": c["id"], "name": c["name"]}
                    rounds.setdefault(rd["id"], rd)
                    in_round = any(i["id"] in s["ids"] or graph.norm(i["name"]) == s["key"] for i in rd["investors"])
                    (joined if in_round else backed)[rd["id"]].add(s["key"])
                    leads = [i for i in rd["investors"] if i["is_lead"] and i["id"] not in soft_ids
                             and graph.norm(i["name"]) not in soft_keys]
                    await emit({"t": "round", "soft": s["key"], "via": "round" if in_round else "cap_table",
                                "round": _round_brief(rd),
                                "leads": [{"key": graph.norm(i["name"]), "name": i["name"], "kind": i["kind"]} for i in leads],
                                "others": len(rd["investors"]) - len(leads), **ledger.as_dict()})

                await asyncio.gather(*(open_cap_round(r) for r in recent))

            await asyncio.gather(*(open_company(c) for c in pick))

    await asyncio.gather(*(walk_soft(s) for s in softs))
    folded = _merge_deals(rounds, joined, backed)
    for s in softs:   # a deal Cala holds twice counts once
        n = folded[s["key"]]
        if n and s.get("rounds_in_cala"):
            s["rounds_in_cala"] -= n
            s["followed"] -= n
            s["duplicates"] = n
            s["lead_rate"] = round(s["led"] / s["rounds_in_cala"], 2) if s["rounds_in_cala"] else None

    # 2. Who led those rounds, and who else sat in them.
    leads: dict[str, dict] = {}
    cos: dict[str, dict] = {}
    for rid, rd in rounds.items():
        with_keys = sorted(joined[rid] | backed[rid])
        for i in rd["investors"]:
            key = graph.norm(i["name"])
            if i["id"] in soft_ids or key in soft_keys or not key:
                continue
            book = leads if i["is_lead"] else cos
            e = book.setdefault(key, {"key": key, "name": i["name"], "ids": [], "kind": i["kind"], "rounds": {}})
            if i["id"] and i["id"] not in e["ids"]:
                e["ids"].append(i["id"])
            if len(i["name"]) and not i["name"].isupper() and e["name"].isupper():
                e["name"] = i["name"]
            e["rounds"][rid] = {"with": with_keys, "sources": i["sources"]}

    def evidence(e: dict) -> list[dict]:
        out = []
        for rid, link in e["rounds"].items():
            rd = rounds[rid]
            srcs = link["sources"] or rd["sources"]
            out.append({**_round_brief(rd), "date_is_report": rd.get("date_is_report", False),
                        "with": [next(s["name"] for s in softs if s["key"] == k) for k in link["with"]],
                        "with_keys": link["with"],
                        # "round": the soft yes was in this round. "cap_table": it backs the company, round not on record.
                        "relation": "round" if any(k in joined[rid] for k in link["with"]) else "cap_table",
                        "co_leads": [i["name"] for i in rd["investors"] if i["is_lead"] and graph.norm(i["name"]) != e["key"]],
                        # "graph": a funding-round entity in Cala. "knowledge": a report Cala's knowledge search read.
                        "via": rd.get("via", "graph"),
                        "investors": None if rd.get("via") == "knowledge" else len(rd["investors"]),
                        "sources": srcs[:4]})
        out.sort(key=lambda d: d["date"] or "", reverse=True)
        return out

    def base_score(ev: list[dict]) -> float:
        s = sum(_recency(d["date"]) * _stage_weight(d["stage"], want_stage) *
                (1.0 if d["relation"] == "round" else CAP_WEIGHT) for d in ev)
        return s * (1 + 0.35 * (len({k for d in ev for k in d["with_keys"]}) - 1))

    for e in list(leads.values()) + list(cos.values()):
        for uid in (aliases(e["key"]) if aliases else []):
            if uid not in e["ids"]:
                e["ids"].append(uid)
    for e in leads.values():
        e["evidence"] = evidence(e)
        e["ring"] = 1
        e["score"] = base_score(e["evidence"]) * (0.75 if e["kind"] == "person" else 1.0)
    order = sorted(leads.values(), key=lambda e: e["score"], reverse=True)
    await emit({"t": "leads", "count": len(order), "top": [{"key": e["key"], "name": e["name"]} for e in order[:12]]})

    # 3. Each lead's own record: does it lead often, recently, at this stage?
    async def read_pulse(e: dict, free: bool = False):
        """Cala sometimes holds one investor as two or three entities: read each and merge.
        `free` reads only what is already cached, for leads below the top of the list."""
        if free:
            got = [await graph.investor(cala, uid, ledger=ledger, cache_only=True) for uid in e["ids"][:3]]
            invs = [i for i in got if i]
            if invs:
                e["_inv"] = _merge(invs)
                e["pulse"] = _pulse(e["_inv"])
                e["portfolio"] = e["_inv"]["portfolio"][:50]
            return
        if not e["ids"]:
            # named in a report, not yet tied to a Cala entity: look the name up
            found = await guarded(graph.search, e["name"]) or []
            same = [f for f in found if graph.norm(f["name"]) == e["key"]]
            if not same:
                fam = graph.family(e["name"]) or e["key"]
                same = [f for f in found if f["type"] != "Person" and (graph.family(f["name"]) == fam or graph.norm(f["name"]) == fam)
                        and graph.INVESTOR_WORDS.search(f"{f['name']} {f.get('description') or ''}")]
            e["ids"] = [f["id"] for f in same][:3]
            if same and all(f["type"] == "Person" for f in same):
                e["kind"] = "person"
            if not e["ids"]:
                e["record"] = "missing"
        invs = [i for i in await asyncio.gather(*(guarded(graph.investor, uid) for uid in e["ids"][:3])) if i]
        if not invs:
            return
        inv = _merge(invs)
        e["_inv"] = inv
        e["pulse"] = _pulse(inv)
        e["portfolio"] = inv["portfolio"][:50]
        await emit({"t": "pulse", "key": e["key"], "name": e["name"], "rounds": e["pulse"]["rounds"],
                    "led": e["pulse"]["led"], **ledger.as_dict()})

    await asyncio.gather(*(read_pulse(e) for e in order[:PULSE_TOP]), *(read_pulse(e, free=True) for e in order[PULSE_TOP:]))

    # 4. Second ring: investors who sat in those rounds without leading, but lead elsewhere.
    ring2 = sorted((c for k, c in cos.items() if k not in leads and c["kind"] == "fund"),
                   key=lambda c: (len(c["rounds"]), max((rounds[r]["date"] or "") for r in c["rounds"])), reverse=True)
    await asyncio.gather(*(read_pulse(c) for c in ring2[:RING2_TOP]))
    second = []
    for c in ring2[:RING2_TOP]:
        p = c.get("pulse")
        if p and p["led"] >= 2 and (p["lead_rate"] or 0) >= 0.34:
            c["evidence"] = evidence(c)
            c["ring"] = 2
            c["score"] = 0.3 * min(len(c["rounds"]), 3) * p["lead_rate"]
            second.append(c)

    # 5. Open the most recent rounds each top lead led, to state "last led" with a real date and source.
    async def verify(e: dict):
        inv = e.get("_inv")
        if not inv:
            return
        known = set(e["rounds"])
        todo = sorted((r for r in inv["rounds"] if r["is_lead"] and r["id"] not in known),
                      key=lambda r: r["reported"] or "", reverse=True)[:VERIFY_ROUNDS]
        got = []

        async def one(r):
            rd = await guarded(graph.funding_round, r["id"])
            if rd:
                if not rd["date"]:
                    rd["date"] = r["reported"]
                got.append({**_round_brief(rd), "sources": (r["sources"] or rd["sources"])[:3]})
                await emit({"t": "verify", "key": e["key"], "round": _round_brief(rd), **ledger.as_dict()})

        await asyncio.gather(*(one(r) for r in todo))
        e["_verified"] = got

    final_order = sorted(order[:PULSE_TOP], key=lambda e: e["score"], reverse=True)
    await asyncio.gather(*(verify(e) for e in final_order[:VERIFY_TOP] + second[:2]))

    # 6. Final shape.
    def finish(e: dict) -> dict:
        ev = e["evidence"]
        pulse = e.get("pulse")
        led_known = [{k: d[k] for k in ("id", "issuer", "stage", "stage_name", "date", "amount", "currency", "sources")}
                     for d in ev] if e["ring"] == 1 else []
        led_known += e.get("_verified", [])
        led_known.sort(key=lambda d: d["date"] or "", reverse=True)
        last_led = next((d for d in led_known if d["date"]), None)
        # Rounds it led in the last two years: the graph's count, or the dated rounds in hand if those are more.
        in_hand = sum(1 for d in led_known if (_months_ago(d["date"]) or 999) <= RECENT_MONTHS) if e["ring"] == 1 else 0
        led_recent = max((pulse or {}).get("led_recent") or 0, in_hand)
        # A lead that keeps leading counts for more; one with no recent lead on record counts as unproven.
        e["score"] *= 0.6 + min(1.0, led_recent / 4) * 0.8
        per_soft = collections.defaultdict(list)
        for d in ev:
            for k, name in zip(d["with_keys"], d["with"]):
                per_soft[(k, name)].append(d)
        ask = sorted(({"key": k, "name": name, "deals": len(ds), "last": ds[0]} for (k, name), ds in per_soft.items()),
                     key=lambda a: (a["deals"], a["last"]["date"] or ""), reverse=True)
        stages = collections.Counter(d["stage"] for d in led_known if d["stage"])
        fit = None
        if want_stage:
            n = stages.get(want_stage, 0)
            listed = next((s["n"] for s in (pulse or {}).get("led_stages", [])
                           if (s["stage"] or "").upper().replace("-", "_").replace(" ", "_") == want_stage), 0)
            fit = {"stage": want_stage, "stage_name": graph.STAGE_NAMES.get(want_stage, want_stage),
                   "led_at_stage": max(n, listed), "match": max(n, listed) > 0}
        amounts = sorted(d["amount"] for d in led_known if d["amount"] and d["currency"] in ("EUR", "USD"))
        return {"key": e["key"], "id": e["ids"][0] if e["ids"] else None, "ids": e["ids"], "name": e["name"], "kind": e["kind"],
                "ring": e["ring"], "score": round(e["score"], 3), "evidence": ev, "ask": ask[0] if ask else None,
                "asks": ask, "pulse": pulse, "led_recent": led_recent, "record": e.get("record"),
                "recent_leads": led_known[:4], "last_led": last_led, "fit": fit,
                "typical_round": {"min": amounts[0], "max": amounts[-1], "n": len(amounts)} if amounts else None,
                "portfolio": e.get("portfolio", [])}

    first = sorted((finish(e) for e in leads.values()), key=lambda e: e["score"], reverse=True)
    for n, e in enumerate(first, 1):
        e["rank"] = n
    second_out = sorted((finish(c) for c in second), key=lambda e: e["score"], reverse=True)
    for e in first + second_out:
        e["why"] = _why(e, want_stage)

    soft_out = []
    for s in softs:
        counts = collections.Counter()
        for e in leads.values():
            n = sum(1 for link in e["rounds"].values() if s["key"] in link["with"])
            if n:
                counts[e["name"]] = n
        soft_out.append({k: s.get(k) for k in ("key", "name", "ids", "kind", "found", "rounds_in_cala", "led", "followed",
                                                "lead_rate", "walked", "capped", "pulse", "description", "led_rounds", "cap_companies",
                                                "entities", "knowledge", "duplicates")}
                        | {"usual_leads": [{"name": n, "deals": c} for n, c in counts.most_common(5)],
                           "followed_rounds": sorted(
                               ({**_round_brief(rd), "leads": [i["name"] for i in rd["investors"] if i["is_lead"]],
                                 "relation": "round" if s["key"] in joined[rid] else "cap_table",
                                 "via": rd.get("via", "graph"), "sources": rd["sources"][:2]}
                                for rid, rd in rounds.items() if s["key"] in joined[rid] or s["key"] in backed[rid]),
                               key=lambda d: d["date"] or "", reverse=True)})

    for s in soft_out:
        s["verdict"], s["insight"] = _verdict(s)

    urls = set()
    facts = 0
    for rd in rounds.values():
        facts += 3 + len(rd["investors"])
        for i in rd["investors"]:
            urls.update(s["url"] for s in i["sources"])
        urls.update(s["url"] for s in rd["sources"])
    for e in first + second_out:
        for d in e["recent_leads"]:
            urls.update(s["url"] for s in d.get("sources", []))
        if e["pulse"]:
            facts += e["pulse"]["rounds"]
    result = {
        "run_id": run_id(inputs), "created": time.time(),
        "input": {"soft_yeses": [{"name": s["name"], "ids": s["ids"]} for s in softs], "stage": want_stage,
                  "stage_name": graph.STAGE_NAMES.get(want_stage or "", None), "company": inputs.get("company")},
        "headline": _headline(soft_out, first),
        "soft_yeses": soft_out, "leads": first, "second_ring": second_out,
        "rounds_walked": len(rounds), "duplicates_folded": folded["_all"],
        "ledger": ledger.as_dict() | {"facts": facts, "sources": len(urls), "seconds": round(time.time() - t0, 1),
                                      "llm_facts": 0},
        "notes": notes,
    }
    await tick()
    return result
