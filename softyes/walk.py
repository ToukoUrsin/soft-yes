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

from . import graph
from .cala import BudgetExceeded, Cala, CalaError, Ledger

FOLLOW_CAP = 20     # followed rounds walked per soft-yes investor (most recently reported first)
PULSE_TOP = 12      # leads whose own record is read
VERIFY_TOP = 5      # leads whose most recent led rounds are opened to get the real date
VERIFY_ROUNDS = 2
RING2_TOP = 6       # co-investors checked for "sat beside you and leads elsewhere"
RECENT_MONTHS = 24
SOFT_LED_ROUNDS = 3  # a soft yes's own most recent led rounds, opened for the follower profile

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


def _plural(n: int, word: str) -> str:
    return f"{n} {word}" if n == 1 else f"{n} {word}s"


def _names(names: list[str]) -> str:
    return names[0] if len(names) == 1 else ", ".join(names[:-1]) + " or " + names[-1]


def _why(e: dict, want_stage: str | None) -> list[dict]:
    """Short reasons for a lead's place, each one a count over Cala facts. tone: good | warn | plain."""
    out = []
    softs = sorted({w for d in e["evidence"] for w in d["with"]})
    n = len(e["evidence"])
    if e["ring"] == 1:
        out.append({"tone": "good", "text": f"Led {_plural(n, 'round')} that {_names(softs)} joined"})
    else:
        out.append({"tone": "plain", "text": f"Sat in {_plural(n, 'round')} with {_names(softs)} without leading"})
    p = e.get("pulse")
    if p:
        if p["led_recent"]:
            out.append({"tone": "good", "text": f"Led {_plural(p['led_recent'], 'round')} in the last {p['recent_months']} months"})
        elif p["rounds"]:
            out.append({"tone": "warn", "text": f"No lead dated in the last {p['recent_months']} months in Cala"})
        if p["rounds"]:
            out.append({"tone": "plain", "text": f"Leads {p['led']} of its {p['rounds']} rounds in Cala" + ("+" if p["capped"] else "")})
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
    if not s.get("found") or n == 0:
        return "unknown", f"Cala has no funding rounds for {name}, so there is nothing to walk from it."
    cap = " (the first 50 Cala returns)" if s.get("capped") else ""
    if n < 4:
        return "thin", f"Cala has only {_plural(n, 'round')} for {name}; it led {led}. Too few to call a habit."
    rate = led / n
    if rate >= 0.5:
        return "leads", (f"{name} led {led} of its {n} rounds in Cala{cap}. It leads more often than it follows: "
                         f"ask what would make it lead yours.")
    if rate >= 0.25:
        return "mixed", f"{name} led {led} of its {n} rounds in Cala{cap}. It does lead sometimes: worth asking what is missing."
    return "follows", (f"{name} led {led} of its {n} rounds in Cala{cap}. It follows by habit, so the lead has to come "
                       f"from someone else.")


def _headline(softs: list[dict], leads: list[dict]) -> str:
    names = _names([s["name"] for s in softs])
    if not leads:
        return f"Cala shows no outside investor leading a round that {names} joined."
    top = leads[0]
    line = f"{_plural(len(leads), 'investor')} led rounds that {names} joined. Start with {top['name']}"
    p = top.get("pulse")
    if p and p["led_recent"]:
        line += f": it led {_plural(len(top['evidence']), 'of them').replace(' of thems', ' of them')} and {_plural(p['led_recent'], 'round')} in the last {p['recent_months']} months."
    else:
        line += "."
    return line


async def walk(cala: Cala, inputs: dict, emit: Emit) -> dict:
    t0 = time.time()
    ledger = Ledger()
    notes: list[str] = []
    state = {"cache_only": False}
    want_stage = inputs.get("stage")

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
        merged = {"id": s["ids"][0], "name": s["name"], "rounds": all_rounds, "portfolio": [],
                  "capped": any(i["capped"] for i in invs)}
        s.update({"found": bool(invs), "rounds_in_cala": len(all_rounds), "led": len(led), "followed": len(followed),
                  "lead_rate": round(len(led) / len(all_rounds), 2) if all_rounds else None,
                  "walked": len(todo), "capped": merged["capped"], "pulse": _pulse(merged),
                  "description": next((i["description"] for i in invs if i.get("description")), None)})
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

        recent_led = sorted(led, key=lambda r: r["reported"] or "", reverse=True)[:SOFT_LED_ROUNDS]
        await asyncio.gather(*(open_round(r) for r in todo), *(open_led(r) for r in recent_led))
        s["led_rounds"] = sorted(own, key=lambda d: d["date"] or "", reverse=True)

    await asyncio.gather(*(walk_soft(s) for s in softs))

    # 2. Who led those rounds, and who else sat in them.
    leads: dict[str, dict] = {}
    cos: dict[str, dict] = {}
    for rid, rd in rounds.items():
        with_keys = sorted(joined[rid])
        for i in rd["investors"]:
            key = graph.norm(i["name"])
            if i["id"] in soft_ids or key in soft_keys or not key:
                continue
            book = leads if i["is_lead"] else cos
            e = book.setdefault(key, {"key": key, "name": i["name"], "ids": [], "kind": i["kind"], "rounds": {}})
            if i["id"] not in e["ids"]:
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
                        "co_leads": [i["name"] for i in rd["investors"] if i["is_lead"] and graph.norm(i["name"]) != e["key"]],
                        "investors": len(rd["investors"]), "sources": srcs[:4]})
        out.sort(key=lambda d: d["date"] or "", reverse=True)
        return out

    def base_score(ev: list[dict]) -> float:
        s = sum(_recency(d["date"]) * _stage_weight(d["stage"], want_stage) for d in ev)
        return s * (1 + 0.35 * (len({k for d in ev for k in d["with_keys"]}) - 1))

    for e in leads.values():
        e["evidence"] = evidence(e)
        e["ring"] = 1
        e["score"] = base_score(e["evidence"]) * (0.75 if e["kind"] == "person" else 1.0)
    order = sorted(leads.values(), key=lambda e: e["score"], reverse=True)
    await emit({"t": "leads", "count": len(order), "top": [{"key": e["key"], "name": e["name"]} for e in order[:12]]})

    # 3. Each lead's own record: does it lead often, recently, at this stage?
    async def read_pulse(e: dict):
        inv = await guarded(graph.investor, e["ids"][0])
        if not inv:
            return
        e["_inv"] = inv
        e["pulse"] = _pulse(inv)
        e["portfolio"] = inv["portfolio"][:50]
        await emit({"t": "pulse", "key": e["key"], "name": e["name"], "rounds": e["pulse"]["rounds"],
                    "led": e["pulse"]["led"], **ledger.as_dict()})

    await asyncio.gather(*(read_pulse(e) for e in order[:PULSE_TOP]))

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
        # A lead that keeps leading counts for more; one whose own record was not read counts as unproven.
        e["score"] *= 0.6 + min(1.0, pulse["led_recent"] / 4) * 0.8 if pulse else 0.6
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
        return {"key": e["key"], "id": e["ids"][0], "ids": e["ids"], "name": e["name"], "kind": e["kind"],
                "ring": e["ring"], "score": round(e["score"], 3), "evidence": ev, "ask": ask[0] if ask else None,
                "asks": ask, "pulse": pulse, "recent_leads": led_known[:4], "last_led": last_led, "fit": fit,
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
                                                "lead_rate", "walked", "capped", "pulse", "description", "led_rounds")}
                        | {"usual_leads": [{"name": n, "deals": c} for n, c in counts.most_common(5)],
                           "followed_rounds": sorted(
                               ({**_round_brief(rd), "leads": [i["name"] for i in rd["investors"] if i["is_lead"]],
                                 "sources": rd["sources"][:2]}
                                for rid, rd in rounds.items() if s["key"] in joined[rid]),
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
        "rounds_walked": len(rounds),
        "ledger": ledger.as_dict() | {"facts": facts, "sources": len(urls), "seconds": round(time.time() - t0, 1),
                                      "llm_facts": 0},
        "notes": notes,
    }
    await tick()
    return result
