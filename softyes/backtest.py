"""Backtest of the walk: does it find the investor who leads?

Take a past round R that Cala holds with a lead L and a follower F (an investor in R that did not lead it).
Hide R and everything dated on or after it, walk from F the way the product does (the earlier rounds F joined
without leading, and who led each), and see whether L is on that list and how high.

Everything is read from the cache (`data/cache.db`). No call goes to Cala: each read passes `cache_only=True`.

    uv run -q python -m softyes.backtest        # computes, prints, stores the result under blob "backtest:v1"
"""
from __future__ import annotations

import asyncio
import collections
import copy
import itertools
import json
import math
import random
import re
import statistics
import sys
import time
from datetime import date

from . import cala as cala_mod, extras, graph, walk
from .cala import Ledger

BLOB = "backtest:v1"
MIN_HISTORY = 3      # a follower needs this many earlier rounds; below it the round is counted as "too little history"
SEED = 20261114      # fixed, so the same cache gives the same numbers
DRAWS = 500          # random investors drawn per tested round for the base rate
RULES = ("count_then_recent", "recent", "decayed", "decayed_stage")
PRIMARY = "count_then_recent"

# Why a round Cala holds was not tested. The keys are shown as they are.
X_NO_INVESTORS = "No investors on the round in the cache"
X_NO_DATE = "Round has no date in Cala"
X_NO_LEAD = "Cala marks no lead on the round"
X_NO_COMPANY = "Cala holds the round without its company"
X_NOT_A_NAME = "The lead is not a name (\"undisclosed\", \"angels\")"
X_DUPLICATE = "Same deal held twice in Cala (folded into one)"
X_NO_FOLLOWER = "No follower of the round has a record in the cache"
X_LEAD_IS_FOLLOWER = "The only follower with a record is the lead itself"
X_PAGE_OTHER = "The cited page says Cala's lead did not lead the round"


def _day(d: str | None, late: bool = False) -> str | None:
    """A date as YYYY-MM-DD. A date Cala holds as a year or a month becomes its first day, or its last when `late`,
    so a comparison never treats an unclear date as earlier than it may be."""
    d = (d or "").strip()
    if re.match(r"\d{4}-\d{2}-\d{2}", d):
        return d[:10]
    if re.fullmatch(r"\d{4}-\d{2}", d):
        return d + ("-31" if late else "-01")
    if re.fullmatch(r"\d{4}", d):
        return d + ("-12-31" if late else "-01-01")
    return None


def _years(a: str, b: str) -> float:
    try:
        return (date.fromisoformat(b) - date.fromisoformat(a)).days / 365.25
    except ValueError:
        return 0.0


def _known_before(srcs: list[dict], cutoff: str) -> bool:
    """Could this fact be read before `cutoff`? Yes unless every dated page behind it is from that day or later."""
    dated = [s["date"][:10] for s in srcs if s.get("date")]
    return not dated or min(dated) < cutoff


class _Firms:
    """One firm from the several names and entities Cala holds it under, by the product's own rules: the same entity
    id, the same `graph.norm` name, or the same `graph.family` ('Seaya Ventures II, FCR' and 'Seaya Growth Tech')."""

    def __init__(self) -> None:
        self.parent: dict[str, str] = {}

    def _find(self, x: str) -> str:
        self.parent.setdefault(x, x)
        while self.parent[x] != x:
            self.parent[x] = self.parent[self.parent[x]]
            x = self.parent[x]
        return x

    def _link(self, a: str, b: str) -> None:
        a, b = self._find(a), self._find(b)
        if a != b:
            self.parent[max(a, b)] = min(a, b)

    def add(self, name: str, uid: str | None, typ: str | None) -> None:
        key = graph.norm(name)
        if not key:
            return
        if uid:
            self._link("n:" + key, "i:" + uid)
        fam = graph.family(name) if typ != "Person" else None
        if fam:
            self._link("n:" + key, "n:" + fam)

    def of(self, name: str, uid: str | None = None) -> str | None:
        key = graph.norm(name)
        if key:
            return self._find("n:" + key)
        return self._find("i:" + uid) if uid else None


class _Graph:
    """What the cache holds, in the shapes the walk uses."""

    def __init__(self, invs: dict[str, dict], rounds: dict[str, dict], runs: list[tuple], pages: bool = True) -> None:
        """`pages`: count a lead the way the product does, after the page check. An investor the cited page lists
        under another lead is a follower of that round, and the lead that page names is its lead. Without it, Cala's
        flag alone decides."""
        rounds = copy.deepcopy(rounds)   # folding deals changes them
        self.records = {uid: inv for uid, inv in invs.items() if inv["rounds"]}
        self.rounds_read = len(rounds)
        self.firms = _Firms()
        for uid, inv in invs.items():
            self.firms.add(inv["name"], uid, inv["type"])
        for rd in rounds.values():
            for i in rd["investors"]:
                self.firms.add(i["name"], i["id"], i["type"])
        self.excluded: collections.Counter = collections.Counter()
        own_date = {rid: rd["date"] for rid, rd in rounds.items()}
        self.excluded[X_NO_INVESTORS] = sum(1 for rd in rounds.values() if not rd["investors"])
        deals = {rid: rd for rid, rd in rounds.items() if rd["investors"]}
        # One deal Cala holds as two round entities is one deal: the product's own fold.
        folded = walk._merge_deals(deals, collections.defaultdict(set), collections.defaultdict(set))
        self.excluded[X_DUPLICATE] = folded["_all"]
        self.deals = deals
        self.canon = {rid: rid for rid in deals} | {also: rid for rid, rd in deals.items() for also in rd.get("also", [])}
        for rid, rd in deals.items():
            held = [own_date[x] for x in [rid] + rd.get("also", [])]
            lo, hi = [_day(d) for d in held if _day(d)], [_day(d, True) for d in held if _day(d)]
            rd["first"], rd["last"] = (min(lo), max(hi)) if lo else (None, None)   # every date the deal is held under
        # A firm's cached records, and the rounds it joined without leading (by its own record, as the walk reads it).
        self.records_of: dict[str, list[dict]] = collections.defaultdict(list)
        for uid, inv in self.records.items():
            self.records_of[self.firms.of(inv["name"], uid)].append(inv)
        self.followed: dict[str, dict[str, list[dict]]] = {}
        self.walk_opens: dict[str, set[str]] = {}
        self.listed: dict[str, list[tuple]] = {}
        led_rows: dict[str, list[dict]] = {}
        for firm, recs in self.records_of.items():
            inv = walk._merge(recs)
            mine = [r for r in inv["rounds"] if not r["is_lead"]]
            book: dict[str, list[dict]] = {}
            for r in mine:
                if r["id"] in self.canon:
                    book.setdefault(self.canon[r["id"]], []).extend(r["sources"])
            self.followed[firm] = book
            led_rows[firm] = [r for r in inv["rounds"] if r["is_lead"] and r["id"] in self.canon]
            recent = sorted(mine, key=lambda r: r["reported"] or "", reverse=True)[:walk.FOLLOW_CAP]
            self.walk_opens[firm] = {self.canon[r["id"]] for r in recent if r["id"] in self.canon}
            self.listed[firm] = [(r["reported"], r["id"] in self.canon) for r in mine]
        # What the stored walks read on the cited pages: (deal, investor name) -> outcome, the latest reading kept.
        self.claims: dict[tuple, str] = {}
        self.walked: set[str] = set()
        for _, inputs, result in sorted(runs, key=lambda r: r[0] or 0):
            for s in (inputs or {}).get("soft_yeses", []):
                for uid in s.get("ids", []):
                    self.walked.add(self.firms._find("i:" + uid))
                if s.get("name") and self.firms.of(s["name"]):
                    self.walked.add(self.firms.of(s["name"]))
            for rid, key, status in ((result or {}).get("page_check") or {}).get("claims") or []:
                at = (self.canon.get(rid, rid), key)
                if status not in ("unread", "off") or at not in self.claims:
                    self.claims[at] = status
        for rd in deals.values():
            for i in rd["investors"]:
                said = self.claims.get((rd["id"], graph.norm(i["name"]))) if pages else None
                i["led"] = (i["is_lead"] and said != "follower") or said == "lead"
        for firm, rows in led_rows.items() if pages else ():
            for r in rows:   # its record says it led, the page says it joined: a round it followed, as in the walk
                E = deals[self.canon[r["id"]]]
                mine = [i for i in E["investors"] if self.firm(i) == firm]
                if any(self.claims.get((E["id"], graph.norm(i["name"]))) == "follower" for i in mine) and \
                        not any(i["led"] for i in mine):
                    self.followed[firm].setdefault(E["id"], []).extend(r["sources"])
        # Who led what, for the base rates.
        self.led: list[tuple[str, str, str]] = []   # (deal's last date, deal's year, firm)
        self.led_at: dict[str, list[tuple]] = collections.defaultdict(list)   # firm -> (deal's last date, stage) of each round it led
        for rd in deals.values():
            if rd["first"]:
                for k in sorted({self.firm(i) for i in rd["investors"] if i["led"] and self.real(i)}):
                    self.led.append((rd["last"], rd["first"][:4], k))
                    self.led_at[k].append((rd["last"], rd.get("stage")))
        self._history: dict[tuple, tuple] = {}

    def firm(self, i: dict) -> str | None:
        return self.firms.of(i["name"], i["id"])

    @staticmethod
    def real(i: dict) -> bool:
        return bool(graph.norm(i["name"])) and not walk._no_name(i["name"])

    def history(self, firm: str, R: dict, strict: bool, other_companies: bool) -> tuple[list[dict], collections.Counter]:
        """The rounds `firm` joined without leading that could be read before R. Returns them, most recent first,
        and why the others were hidden."""
        at = (firm, R["id"], strict, other_companies)
        if at in self._history:
            return self._history[at]
        cutoff, usable, hidden = R["first"], [], collections.Counter()
        for did, srcs in self.followed.get(firm, {}).items():
            E = self.deals[did]
            if did == R["id"]:
                hidden["the tested round itself"] += 1
            elif walk._same_deal(E, R):
                hidden["the same deal as the tested round, held twice"] += 1
            elif not E["first"]:
                hidden["no date in Cala"] += 1
            elif E["last"] >= cutoff:
                hidden["dated on or after the tested round"] += 1
            elif not (E.get("issuer") or {}).get("name"):
                hidden["held without its company"] += 1
            elif other_companies and _same_company(E, R):
                hidden["an earlier round of the same company"] += 1
            elif strict and not _known_before(srcs + [x for i in E["investors"] if self.firm(i) == firm for x in i["sources"]], cutoff):
                hidden["the follower's part in it is only reported on or after the tested round"] += 1
            else:
                usable.append(E)
        usable.sort(key=lambda E: E["last"], reverse=True)
        hidden["beyond the 20 most recent the walk opens"] += max(0, len(usable) - walk.FOLLOW_CAP)
        self._history[at] = (usable[:walk.FOLLOW_CAP], hidden)
        return self._history[at]

    def shortlist(self, softs: list[str], R: dict, strict: bool, other_companies: bool) -> tuple[dict, collections.Counter]:
        """Who led the earlier rounds the followers joined: firm -> {name, deals, softs}."""
        entries: dict[str, dict] = {}
        hidden: collections.Counter = collections.Counter()
        for f in softs:
            usable, why = self.history(f, R, strict, other_companies)
            hidden.update(why)
            for E in usable:
                for i in E["investors"]:
                    k = self.firm(i)
                    if not i["led"] or not k or k in softs or not self.real(i):
                        continue
                    if strict and not _known_before(i["sources"], R["first"]):
                        hidden["a lead only reported on or after the tested round"] += 1
                        continue
                    e = entries.setdefault(k, {"name": i["name"], "deals": {}, "softs": set(), "ids": set()})
                    e["deals"][E["id"]] = E
                    e["softs"].add(f)
                    if i["id"]:
                        e["ids"].add(i["id"])
        return entries, hidden


def _same_company(a: dict, b: dict) -> bool:
    ia, ib = a.get("issuer") or {}, b.get("issuer") or {}
    if ia.get("id") and ia.get("id") == ib.get("id"):
        return True
    return bool(ia.get("name") and ib.get("name")) and walk._same_company(graph.norm(ia["name"]), graph.norm(ib["name"]))


def _ranks(entries: dict, R: dict, led_at: dict | None = None) -> dict[str, dict[str, int]]:
    """Each rule's place for every investor on the list, using only what was dated before R. Ties take the worst
    place of the tie, so a place is never better than the rule can tell."""
    keys = {}
    stage = R.get("stage") if R.get("stage") in graph.STAGE_ORDER else None
    for k, e in entries.items():
        ds = list(e["deals"].values())
        last = max(d["last"] for d in ds)
        # the product's recency weight (half as much every three years), counted back from R instead of from today
        decayed = sum(0.5 ** (max(_years(d["last"], R["first"]), 0) / 3) for d in ds) * (1 + 0.35 * (len(e["softs"]) - 1))
        # the product's stage count: the rounds this lead led before R, anywhere in the cache, at the tested round's
        # stage. More for each such round up to five; less for a lead with three led rounds and none at that stage.
        staged = decayed
        if stage:
            before = [st for when, st in (led_at or {}).get(k, []) if when < R["first"]]
            n = sum(1 for st in before if st == stage)
            staged *= (1 + 0.1 * min(n, 5)) if n else 0.6 if len(before) >= 3 else 0.8
        keys[k] = {"count_then_recent": (len(ds), last), "recent": (last,), "decayed": (round(decayed, 9),),
                   "decayed_stage": (round(staged, 9),)}
    return {rule: {k: sum(1 for o in keys.values() if o[rule] >= keys[k][rule]) for k in keys} for rule in RULES}


def _tests(g: _Graph, strict: bool = True, other_companies: bool = False) -> dict:
    """One test per round: from two followers when two have enough history, else from the one that has."""
    excluded: collections.Counter = collections.Counter()
    tests, thin, singles, pairs = [], [], [], []
    for rid in sorted(g.deals):
        R = g.deals[rid]
        leads = [i for i in R["investors"] if i["led"]]
        if not R["first"]:
            excluded[X_NO_DATE] += 1
            continue
        if not leads:
            excluded[X_PAGE_OTHER if any(i["is_lead"] for i in R["investors"]) else X_NO_LEAD] += 1
            continue
        if not (R.get("issuer") or {}).get("name"):
            excluded[X_NO_COMPANY] += 1
            continue
        truth = {g.firm(i): i for i in leads if g.real(i)}
        if not truth:
            excluded[X_NOT_A_NAME] += 1
            continue
        followers: dict[str, dict] = {}
        own = 0
        for i in R["investors"]:
            k = g.firm(i)
            if i["led"] or not k or k not in g.records_of:
                continue
            if k in truth:
                own += 1   # Cala holds it in the round twice, once as lead: it is not a follower here
                continue
            followers.setdefault(k, i)
        if not followers:
            excluded[X_LEAD_IS_FOLLOWER if own else X_NO_FOLLOWER] += 1
            continue
        depth = {k: len(g.history(k, R, strict, other_companies)[0]) for k in followers}
        enough = sorted(k for k, n in depth.items() if n >= MIN_HISTORY)
        for k in enough:
            singles.append(_one(g, R, [k], followers, truth, strict, other_companies))
        if not enough:
            best = max(sorted(depth), key=lambda k: depth[k])
            thin.append(_one(g, R, [best], followers, truth, strict, other_companies) | {"earlier_rounds": depth[best]})
            continue
        # which two, when more than two qualify: drawn per round from a fixed seed, so no pair is chosen for its result
        softs = sorted(random.Random(f"{SEED}:{rid}").sample(enough, 2)) if len(enough) >= 2 else enough
        t = _one(g, R, softs, followers, truth, strict, other_companies)
        if len(softs) == 2:   # the same round from the first of the two alone, to see what the second adds
            t["alone"] = _one(g, R, softs[:1], followers, truth, strict, other_companies)
            pairs += [_one(g, R, list(two), followers, truth, strict, other_companies) for two in itertools.combinations(enough, 2)]
        tests.append(t)
    return {"tests": tests, "thin": thin, "singles": singles, "pairs": pairs, "excluded": excluded}


def _one(g: _Graph, R: dict, softs: list[str], followers: dict, truth: dict, strict: bool, other_companies: bool) -> dict:
    entries, hidden = g.shortlist(softs, R, strict, other_companies)
    ranks = _ranks(entries, R, g.led_at)
    found = [k for k in truth if k in entries]
    best = min(found, key=lambda k: ranks[PRIMARY][k]) if found else None
    on_page = {k for k, i in truth.items() if g.claims.get((R["id"], graph.norm(i["name"]))) == "lead"}
    return {"R": R, "softs": softs, "followers": [followers[k] for k in softs], "truth": truth, "entries": entries,
            "size": len(entries), "hit": best,
            "rank": {rule: min((ranks[rule][k] for k in found), default=None) for rule in RULES},
            "ranks": ranks[PRIMARY], "hidden": hidden,
            # the same question with only the leads a cited page confirms as the truth
            "page": {"leads": on_page, "rank": min((ranks[PRIMARY][k] for k in found if k in on_page), default=None)},
            "same_company_only": bool(best) and all(_same_company(E, R) for E in entries[best]["deals"].values()),
            "by_name": bool(best) and not ({i["id"] for i in [truth[best]] if i["id"]} & entries[best]["ids"]),
            # the product's walk from these followers opens this round whoever led it
            "unselected": all(k in g.walked and R["id"] in g.walk_opens.get(k, ()) for k in softs)}


def _tally(tests: list[dict], rule: str = PRIMARY) -> dict:
    ranks = [t["rank"][rule] for t in tests]
    return {"tested": len(tests), "hit": sum(1 for r in ranks if r), "top5": sum(1 for r in ranks if r and r <= 5),
            "top10": sum(1 for r in ranks if r and r <= 10)}


def _brief(tests: list[dict]) -> dict:
    t = _tally(tests)
    return {"tested": t["tested"], "hit": t["hit"], "top5": t["top5"]}


def _base(g: _Graph, tests: list[dict]) -> dict:
    """How often investors drawn at random would be on the same lists. Each tested round draws as many investors as
    it has leads, from those who led a round in the cache dated in the same year. `uniform`: every such investor is
    equally likely. `by_rounds_led`: an investor that led five rounds that year is five times as likely.
    `most_active`: no walk at all, just the five investors with the most rounds led before the tested round."""
    rng = random.Random(SEED)
    by_year: dict[str, list[str]] = collections.defaultdict(list)
    for _, year, k in g.led:
        by_year[year].append(k)
    pool = [len(set(by_year[t["R"]["first"][:4]])) for t in tests]
    odds = {"uniform": [], "by_rounds_led": []}   # per tested round: (share of draws on the list, share in its top 5)
    active = 0
    for t in tests:
        R, softs, n = t["R"], set(t["softs"]), len(t["truth"])
        weighted = [k for k in by_year[R["first"][:4]] if k not in softs]
        distinct = sorted(set(weighted))
        for name, draw in (("uniform", lambda: rng.sample(distinct, min(n, len(distinct)))),
                           ("by_rounds_led", lambda: [rng.choice(weighted) for _ in range(n)])):
            on = top = 0
            for _ in range(DRAWS):
                got = [t["ranks"][k] for k in draw() if k in t["ranks"]]
                on += bool(got)
                top += bool(got) and min(got) <= 5
            odds[name].append((on / DRAWS, top / DRAWS))
        before = collections.Counter(k for last, _, k in g.led if last < R["first"] and k not in softs)
        latest: dict[str, str] = {}
        for last, _, k in g.led:
            if last < R["first"]:
                latest[k] = max(latest.get(k, ""), last)
        top5 = sorted(before, key=lambda k: (before[k], latest[k], k), reverse=True)[:5]
        active += any(k in t["truth"] for k in top5)
    n = max(1, len(tests))
    out = {name: {"on_list": round(sum(o[0] for o in v) / n, 4), "top5": round(sum(o[1] for o in v) / n, 4)}
           for name, v in odds.items()}
    hard = max(out, key=lambda name: out[name]["on_list"])   # the harder of the two is the one the lift is measured against
    hits, tops = sum(1 for t in tests if t["hit"]), sum(1 for t in tests if (t["rank"][PRIMARY] or 99) <= 5)
    luck = [0, 0]
    for _ in range(20000):   # how often random investors do at least as well over the whole test
        luck[0] += sum(rng.random() < o[0] for o in odds[hard]) >= hits
        luck[1] += sum(rng.random() < o[1] for o in odds[hard]) >= tops
    return out | {"used": hard, "rate": out[hard]["on_list"], "top5_rate": out[hard]["top5"],
                  "chance_random_does_as_well": round(luck[0] / 20000, 4), "chance_random_does_as_well_top5": round(luck[1] / 20000, 4),
                  "most_active_top5": round(active / n, 4), "draws_per_round": DRAWS, "seed": SEED,
                  "investors_to_draw_from": statistics.median(pool) if pool else 0}


def _wilson(k: int, n: int) -> list[float] | None:
    """95% interval for a share of k in n."""
    if not n:
        return None
    z, p = 1.96, k / n
    mid, half = (p + z * z / (2 * n)) / (1 + z * z / n), z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / (1 + z * z / n)
    return [round(max(0.0, mid - half), 4), round(min(1.0, mid + half), 4)]


def _ceiling(g: _Graph, tests: list[dict]) -> int:
    """With no time split at all (everything but the tested round visible, which leaks): in how many tested rounds
    did the lead ever lead another cached round next to these followers. The walk cannot do better on this cache."""
    n = 0
    for t in tests:
        led = {g.firm(i) for f in t["softs"] for did in g.followed[f] if did != t["R"]["id"] and not walk._same_deal(g.deals[did], t["R"])
               for i in g.deals[did]["investors"] if i["led"]}
        n += any(k in led for k in t["truth"])
    return n


def _example(g: _Graph, t: dict) -> dict:
    R, k = t["R"], t["hit"]
    earlier = None
    if k:
        E = max(t["entries"][k]["deals"].values(), key=lambda E: E["last"])
        earlier = {"company": E["issuer"]["name"], "date": E["first"]}
    names = [t["truth"][k]["name"]] if k else [i["name"] for i in t["truth"].values()][:2]
    return {"company": R["issuer"]["name"], "stage_name": R["stage_name"], "date": R["first"], "lead": " and ".join(names),
            "followers": [i["name"] for i in t["followers"]], "rank": t["rank"][PRIMARY], "list_size": t["size"],
            "earlier": earlier, "confirmed_on_page": bool(k in t["page"]["leads"]) if k else bool(t["page"]["leads"])}


def _examples(g: _Graph, tests: list[dict]) -> list[dict]:
    """Up to 12 hits and 6 misses, firms only. Hits: the lead confirmed on the page and met in another company first,
    then the best place, then the most recent. No follower or lead appears more than twice."""
    firms_only = [t for t in tests if not any(i["type"] == "Person" or i["kind"] == "person"
                                              for i in list(t["truth"].values()) + t["followers"])]
    hits = sorted((t for t in firms_only if t["hit"]),
                  key=lambda t: (t["hit"] not in t["page"]["leads"], t["same_company_only"], t["rank"][PRIMARY] > 5,
                                 t["size"] < 5, -int(t["R"]["first"].replace("-", "")), t["R"]["id"]))
    misses = sorted((t for t in firms_only if not t["hit"]),
                    key=lambda t: (not t["page"]["leads"], t["size"] < 5, -int(t["R"]["first"].replace("-", "")), t["R"]["id"]))
    out = []
    for group, limit in ((hits, 12), (misses, 6)):
        seen: collections.Counter = collections.Counter()
        took = 0
        for t in group:
            who = t["softs"] + ([t["hit"]] if t["hit"] else list(t["truth"]))
            if took >= limit or any(seen[k] >= 2 for k in who):
                continue
            seen.update(who)
            took += 1
            out.append(_example(g, t))
    return out


async def _load(cala: cala_mod.Cala, ledger: Ledger) -> tuple[dict, dict, list]:
    """Every investor record and round record ever read from Cala, parsed by the product's own readers, and the
    stored walks (for what they read on the cited pages)."""
    with cala.dblock:
        rows = cala.db.execute("select url, body from calls where method='POST' and url like '%/entities/%'").fetchall()
        try:
            runs = cala.db.execute("select created, inputs, result from runs").fetchall()
        except Exception:   # no walk stored yet
            runs = []
    invs, rounds = {}, {}
    for url, body in rows:
        uid = url.rsplit("/", 1)[1]
        try:
            asked = json.loads(body) if body else None
        except ValueError:
            continue
        if asked == graph.INVESTOR_BODY:
            inv = await graph.investor(cala, uid, ledger=ledger, cache_only=True)
            if inv:
                invs[uid] = inv
        elif asked == graph.ROUND_BODY:
            rd = await graph.funding_round(cala, uid, ledger=ledger, cache_only=True)
            if rd:
                rounds[uid] = rd
    parsed = []
    for created, inputs, result in runs:
        try:
            parsed.append((created, json.loads(inputs or "null"), json.loads(result or "null")))
        except ValueError:
            continue
    return invs, rounds, parsed


def _pct(n: int, of: int) -> float | None:
    return round(n / of, 4) if of else None


async def compute(cala: cala_mod.Cala | None = None) -> dict:
    """The backtest over what the cache holds now. Reads the cache only."""
    cala = cala or cala_mod.get()
    ledger = Ledger()
    invs, rounds, runs = await _load(cala, ledger)
    g = _Graph(invs, rounds, runs)
    main = _tests(g)
    tests = main["tests"]
    total = _tally(tests)
    base = _base(g, tests)
    base_rate, base_top5 = base["rate"], base["top5_rate"]
    hit_rate = total["hit"] / total["tested"] if total["tested"] else 0.0
    one = [t for t in tests if len(t["softs"]) == 1]
    two = [t for t in tests if len(t["softs"]) == 2]
    flags = _tests(_Graph(invs, rounds, runs, pages=False))["tests"]

    def lifted(part: list[dict]) -> dict:
        b = _base(g, part)
        rate = sum(1 for t in part if t["hit"]) / len(part) if part else 0.0
        return _brief(part) | {"base_rate": b["rate"], "lift": round(rate / b["rate"], 1) if b["rate"] else None,
                               "median_list": statistics.median(t["size"] for t in part) if part else 0}
    paged = [t for t in tests if t["page"]["leads"]]
    flagged = [t for t in tests if not t["page"]["leads"]]
    page_ranks = [t["page"]["rank"] for t in paged]
    confirmed = {"tested": len(paged), "hit": sum(1 for r in page_ranks if r),
                 "top5": sum(1 for r in page_ranks if r and r <= 5)} if g.claims else None
    hidden: collections.Counter = collections.Counter()
    for t in tests:
        hidden.update(t["hidden"])
    cover = []
    for t in tests:
        rows = [x for k in t["softs"] for x in g.listed[k] if x[0] and x[0][:10] < t["R"]["first"]]
        if rows:
            cover.append(sum(1 for x in rows if x[1]) / len(rows))
    years = collections.Counter(t["R"]["first"][:4] for t in tests)
    hits = [t for t in tests if t["hit"]]
    loose = _tests(g, strict=False)["tests"]
    fresh = _tests(g, other_companies=True)
    unselected = [t for t in tests if t["unselected"]]
    excluded = {k: v for k, v in (g.excluded + main["excluded"]).items() if v}
    result = {
        "computed": int(time.time()),
        "method": (
            "For every past round Cala holds with a date, a lead and a follower whose own record we have read, we hid "
            "that round and every round dated on or after it, then walked from the follower as the product does: the "
            "earlier rounds it joined without leading, and who led each. "
            "The list is ranked by how many of those earlier rounds an investor led, then by how recent the latest is, "
            "and a hit means the round's real lead is on the list. "
            "The base rate is how often an investor drawn at random from those who led a round in the same year, among "
            f"the rounds we hold, is on the same list ({DRAWS} draws per round, fixed seed)."),
        "tested": total["tested"], "hit": total["hit"], "top5": total["top5"], "top10": total["top10"],
        "median_list": statistics.median(t["size"] for t in tests) if tests else 0,
        "base_rate": round(base_rate, 4), "lift": round(hit_rate / base_rate, 2) if base_rate else None,
        "one_follower": _brief(one), "two_followers": _brief(two),
        "confirmed_on_page": confirmed,
        "too_little_history": len(main["thin"]),
        "excluded": excluded,
        "examples": _examples(g, tests),
        # Everything below is extra: the checks behind the headline.
        "detail": {
            "reading": (
                f"The real lead was on the list in {total['hit']} of {total['tested']} rounds and in its top 5 in {total['top5']}. "
                f"An investor drawn at random from the {base['investors_to_draw_from']:.0f} or so that led a round we hold from "
                f"the same year is on it {100 * base_rate:.0f}% of the time and in its top 5 {100 * base_top5:.0f}% of the time. "
                + ("Random draws do as well over the whole test in "
                   f"{100 * base['chance_random_does_as_well']:.1f}% of trials, so the difference "
                   + ("is unlikely to be chance. " if base["chance_random_does_as_well"] < 0.01 else
                      "is borderline and may be chance. " if base["chance_random_does_as_well"] < 0.10 else "could well be chance. "))
                + f"The cache holds at most the {walk.FOLLOW_CAP} most recent rounds of a follower, so the walk had less "
                  "history here than it has live."),
            "cache": {"investor_records": len(g.records), "round_records": g.rounds_read, "deals_after_folding": len(g.deals),
                      "deals_with_date_and_lead": sum(1 for d in g.deals.values() if d["first"] and any(i["is_lead"] for i in d["investors"])),
                      "page_check_claims": len(g.claims), "cala_calls_made": ledger.fresh, "cache_reads": ledger.calls},
            "rates": {"hit": _pct(total["hit"], total["tested"]), "top5": _pct(total["top5"], total["tested"]),
                      "top10": _pct(total["top10"], total["tested"]), "hit_95": _wilson(total["hit"], total["tested"]),
                      "top5_95": _wilson(total["top5"], total["tested"])},
            "lead_is": "Cala's lead flag after the product's page check: an investor the cited page lists under another "
                       "lead counts as a follower of that round, and the lead that page names counts as its lead",
            "cala_flags_only": _tally(flags) | {"note": "the same test with Cala's lead flag alone, no page check"},
            "no_time_split": {"hit": _ceiling(g, tests), "tested": total["tested"],
                              "note": "upper bound that leaks: every other round visible, also later ones. The lead led "
                                      "another cached round next to these followers at some point in this many rounds"},
            "one_follower": lifted(one), "two_followers": lifted(two),
            "rules": {"stored": PRIMARY,
                      "count_then_recent": "rounds led next to the followers before the tested round, then the most recent of them",
                      "recent": "the most recent such round only",
                      "decayed": "the product's recency weight counted back from the tested round, more for a lead met by both followers",
                      "decayed_stage": "the same weight times the product's stage count: more for each round the lead led before "
                                       "the tested round at that round's stage, less for a lead with a record and no such round",
                      "results": {rule: _tally(tests, rule) for rule in RULES},
                      "ties": "a tie takes the worst place in the tie"},
            "base": base | {"top5_rate": round(base_top5, 4),
                            "top5_lift": round((total["top5"] / total["tested"]) / base_top5, 1) if tests and base_top5 else None,
                            "note": "The random investors come from the cache, which is the neighbourhood of the investors "
                                    "people walked. Against all of Cala the base rate would be lower."},
            "flagged_only": _brief(flagged),
            "leads_per_round": round(statistics.mean(len(t["truth"]) for t in tests), 2) if tests else None,
            "hits_only_through_the_same_company": sum(1 for t in hits if t["same_company_only"]),
            "hits_matched_by_name_not_entity_id": sum(1 for t in hits if t["by_name"]),
            "other_companies_only": _tally(fresh["tests"]) | {"too_little_history": len(fresh["thin"]),
                                                               "note": "earlier rounds of the tested round's own company hidden too"},
            "without_source_date_rule": _tally(loose) | {
                "note": "keeps earlier rounds and leads whose every dated page is from the tested round's day or later"},
            "round_the_walk_opens_anyway": _tally(unselected) | {
                "note": "tested rounds the product's walk from these followers opens whoever led them, so the lead did "
                        "not decide that the round is in the cache"},
            "two_followers_from_one_alone": _brief([t["alone"] for t in two]),
            "two_followers_every_pair": _brief(main["pairs"]) | {
                "note": "every pair of followers with enough history, not the one pair drawn per round, so rounds repeat"},
            "every_follower_alone": _tally(main["singles"]) | {"note": "one test per round and follower, so rounds repeat"},
            "too_little_history": _tally([t for t in main["thin"] if t["earlier_rounds"]]) | {
                "with_no_earlier_round": sum(1 for t in main["thin"] if not t["earlier_rounds"]),
                "note": f"followers with 1 or 2 earlier rounds, tested apart (under {MIN_HISTORY} is not in the headline)"},
            "list_sizes": {"min": min((t["size"] for t in tests), default=0), "max": max((t["size"] for t in tests), default=0),
                           "empty": sum(1 for t in tests if not t["size"]), "under_5": sum(1 for t in tests if t["size"] < 5)},
            "earlier_rounds_hidden": dict(hidden),
            "history_in_cache": {"median_share": round(statistics.median(cover), 2) if cover else None,
                                 "note": "share of the followers' earlier joined rounds (by report date) whose record is in the cache"},
            "years": dict(sorted(years.items())),
            "followers_tested": len({k for t in tests for k in t["softs"]}),
            "leads_tested": len({k for t in tests for k in t["truth"]}),
        },
    }
    if ledger.fresh:   # cannot happen: every read above is cache-only
        raise RuntimeError("the backtest must not call Cala")
    return result


def summary(r: dict) -> str:
    n, d = r["tested"], r["detail"]
    pct = lambda x, of=n: f"{x}/{of} ({100 * x / of:.0f}%)" if of else f"{x}/0"  # noqa: E731
    part = lambda p: f"{p['hit']}/{p['tested']} on the list, {p['top5']} in the top 5"  # noqa: E731
    lines = [
        f"Cache: {d['cache']['investor_records']} investor records with rounds, {d['cache']['round_records']} round records, "
        f"{d['cache']['deals_with_date_and_lead']} deals with a date and a lead.",
        f"Rounds tested: {n} ({d['followers_tested']} followers, {d['leads_tested']} leads, {min(d['years'], default='-')}"
        f" to {max(d['years'], default='-')})",
        f"Real lead on the list: {pct(r['hit'])}   top 5: {pct(r['top5'])}   top 10: {pct(r['top10'])}",
        f"Median list size: {r['median_list']}   lists under 5 names: {d['list_sizes']['under_5']}, empty: {d['list_sizes']['empty']}",
        f"Random investor on the list: {100 * r['base_rate']:.1f}%   lift: {r['lift']}x   "
        f"(uniform {100 * d['base']['uniform']['on_list']:.1f}%, by rounds led {100 * d['base']['by_rounds_led']['on_list']:.1f}%; "
        f"drawn from about {d['base']['investors_to_draw_from']:.0f} investors)",
        f"Random investor in the top 5: {100 * d['base']['top5_rate']:.1f}%   lift: {d['base']['top5_lift']}x   "
        f"the 5 most active leads of the time, no walk: {100 * d['base']['most_active_top5']:.0f}%",
        f"95% interval of the hit rate: {100 * d['rates']['hit_95'][0]:.0f}% to {100 * d['rates']['hit_95'][1]:.0f}%.   Chance that random "
        f"investors hit as often: {100 * d['base']['chance_random_does_as_well']:.1f}% (top 5: "
        f"{100 * d['base']['chance_random_does_as_well_top5']:.1f}%)",
        f"No time split (leaks, the ceiling on this cache): {d['no_time_split']['hit']}/{n}",
        f"Base rate and lift, one follower: {100 * d['one_follower']['base_rate']:.1f}%, {d['one_follower']['lift']}x (median list "
        f"{d['one_follower']['median_list']});  two: {100 * d['two_followers']['base_rate']:.1f}%, {d['two_followers']['lift']}x "
        f"(median list {d['two_followers']['median_list']})",
        f"One follower: {part(r['one_follower'])}",
        f"Two followers: {part(r['two_followers'])}   (the same rounds from one of the two: {part(d['two_followers_from_one_alone'])};"
        f" every pair instead of the drawn one: {part(d['two_followers_every_pair'])})",
        (f"Lead confirmed on the cited page: {part(r['confirmed_on_page'])}   only flagged by Cala: {part(d['flagged_only'])}   "
         f"with Cala's flags alone, no page check: {part(d['cala_flags_only'])} of {d['cala_flags_only']['tested']}"
         if r["confirmed_on_page"] else "No stored page checks: no split by page."),
        f"Too little history (under {MIN_HISTORY} earlier rounds): {r['too_little_history']} rounds; with 1 or 2 earlier rounds "
        f"{part(d['too_little_history'])}",
        "Other ranking rules: " + "; ".join(f"{k}: top 5 {v['top5']}, top 10 {v['top10']}" for k, v in d["rules"]["results"].items()),
        f"Hits that rest only on an earlier round of the same company: {d['hits_only_through_the_same_company']}. "
        f"With that company's earlier rounds hidden too: {part(d['other_companies_only'])} of {d['other_companies_only']['tested']}.",
        f"Rounds the walk opens whoever led them: {part(d['round_the_walk_opens_anyway'])}",
        f"Without the source-date rule: {part(d['without_source_date_rule'])} of {d['without_source_date_rule']['tested']}",
        f"Hits where the lead matched by name, not by Cala entity id: {d['hits_matched_by_name_not_entity_id']}",
        f"Share of the followers' earlier rounds whose record is in the cache (median): {d['history_in_cache']['median_share']}",
        "Not tested: " + "; ".join(f"{k}: {v}" for k, v in r["excluded"].items()),
        "Earlier rounds hidden: " + "; ".join(f"{k}: {v}" for k, v in d["earlier_rounds_hidden"].items()),
        f"Cala calls made by this run: {d['cache']['cala_calls_made']} (cache reads: {d['cache']['cache_reads']})",
    ]
    return "\n".join(lines)


async def main() -> None:
    cala = cala_mod.get()
    cala_mod.CREDIT_CAP = 0   # in this process the client refuses any fresh call, whatever the environment says
    tried = []

    async def refuse(method, url, body):   # and if one were attempted it would stop here, counted
        tried.append(url)
        raise cala_mod.BudgetExceeded("the backtest reads the cache only")

    cala._fetch = refuse
    result = await compute(cala)
    result["detail"]["cache"]["network_attempts"] = len(tried)
    if tried or cala._client is not None:
        raise RuntimeError("the backtest tried to reach Cala")
    print(summary(result))
    print(f"Network attempts: {len(tried)}; HTTP client ever built: {cala._client is not None}")
    for e in result["examples"]:
        print(("HIT  " if e["rank"] else "MISS ") + json.dumps(e, ensure_ascii=False))
    if "--dry" not in sys.argv:
        extras.blob_put(BLOB, result)
        print(f"Stored as blob {BLOB}.")


if __name__ == "__main__":
    asyncio.run(main())
