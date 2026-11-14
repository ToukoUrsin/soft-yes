"""The Soft Yes walk.

A founder names the investors who said "we're in if you find a lead".
We walk the Cala graph:   investor -> rounds it joined but did not lead -> who led them
and then check each lead: lead -> its own rounds -> how often, how recently, at what stage it leads.

The ranking is plain arithmetic on Cala facts. No model takes part in it.
"""
from __future__ import annotations

import asyncio
import collections
import math
import re
import hashlib
import json
import time
from datetime import date
from typing import Awaitable, Callable

from . import graph, knowledge, pagecheck
from .cala import BudgetExceeded, Cala, CalaError, Ledger

FOLLOW_CAP = 20     # followed rounds walked per soft-yes investor (most recently reported first)
PULSE_TOP = 25      # leads whose own record is read
VERIFY_TOP = 5      # leads whose most recent led rounds are opened, so "last led" carries a real date and source
VERIFY_ROUNDS = 2   # for the rest, only the latest led round is opened
SAME_STAGE_DAYS = 120  # two rounds of one company with one lettered stage, this far apart, cannot both carry it
RING2_TOP = 6       # co-investors checked for "sat beside you and leads elsewhere"
RECENT_MONTHS = 24
THIN_FOLLOWED = 3    # below this many followed rounds, also walk the soft yes's cap tables
CAP_COMPANIES = 8    # portfolio companies opened on that path
CAP_ROUNDS = 2       # most recent rounds opened per portfolio company
CAP_WEIGHT = 0.6     # "led a round in a company you both back" counts less than "led a round you joined"
SOFT_LED_ROUNDS = 3  # a soft yes's own most recent led rounds, opened for the follower profile
THIN_WALK = 6        # fewer followed rounds than this across all soft yeses: a list, not a ranking
DEEP_BELOW = 8       # fewer followed rounds than this in the graph: also ask Cala's knowledge search

# How far a lead can be counted on, from what Cala holds about it. Leads are listed tier by tier.
TIERS = [
    {"id": "active", "label": "Leading now",
     "note": "Three or more rounds on record in Cala and a round led in the last 24 months."},
    {"id": "thin", "label": "Led lately, short record",
     "note": "A round led in the last 24 months, but Cala holds fewer than three rounds for it."},
    {"id": "quiet", "label": "No recent lead on record",
     "note": "Led a round your investor joined, but Cala shows no round it led in the last 24 months."},
    {"id": "unconfirmed", "label": "Named as lead in Cala, not on the page",
     "note": "Cala marks these as the lead. The pages it cites name them in the round but do not say who led it."},
    {"id": "check", "label": "Check the name first",
     "note": "Cala may have tied this name to the wrong company."},
]
TIER_ORDER = {t["id"]: n for n, t in enumerate(TIERS)}

Emit = Callable[[dict], Awaitable[None]]

PAGE_SECONDS = 14     # how long a walk waits for the pages Cala cites; slower pages are read in the background
# How much a "led" row counts, by what the page Cala cites for it says.
CHECK_WEIGHT = {"lead": 1.0, "report": 1.0, "unstated": 0.5, "other": 0.5, "absent": 0.4, "off": 0.3, "unread": 0.7}
CONFIRMED = ("lead", "report")
NOT_A_NAME = re.compile(r"^(not stated|undisclosed|unknown|unnamed|n/?a|none|various|others?|other investors?|(?:undisclosed |private |"
                        r"existing |new |several |other |business |local |strategic |institutional )?(?:angel )?investors?|angels?|"
                        r"business angels?|angel investors?|management|founders?|employees|family offices?|venture capital(?:ists)?|"
                        r"co|inc|ltd|llc|team|group|fund|the company)$", re.I)
# "Belgian investment group": a description Cala stored where a name belongs.
A_DESCRIPTION = re.compile(r"^(?:an?\s+|the\s+)?[A-Z][a-z]+(?:\s+[a-z-]+)+\s+(?:group|investors?|firm|company|office|manager|bank|funds?|"
                           r"conglomerate|giant|agency)$")


def _no_name(name: str) -> bool:
    name = name.strip()
    return bool(NOT_A_NAME.match(name) or A_DESCRIPTION.match(name))


def _apply_check(rd: dict, c: dict | None, tally: collections.Counter) -> None:
    """Put what the cited pages say onto a round. Each investor Cala marks as lead is confirmed (the page says it
    led, quoted), corrected (the page names another lead: it becomes a co-investor), or left with a note that the
    page does not say. An investor the page says led is counted as lead even if Cala's flag is missing.
    An amount or stage the pages do not state is set aside."""
    cala_leads = [i for i in rd["investors"] if i["is_lead"]]
    if c is None or not c["read"]:
        status = "off" if c and c["off_topic"] else "unread"
        for i in cala_leads:
            i["check"] = {"status": status}
            tally[status] += 1
        if status == "off":
            rd["off_page"] = True
        return
    tally["rounds"] += 1
    tally["pages"] += c["read"]
    # Is the investor who said yes named on a page about this round? Under its own name, or the name Cala lists it by.
    rd["soft_on_page"] = {
        key: key in c.get("also_named", []) or any(
            graph.norm(i["name"]) in c["named"] for i in rd["investors"]
            if graph.norm(i["name"]) == key or i["id"] in (rd.get("_soft_ids") or {}).get(key, []))
        for key, _ in rd.get("look_for") or []}
    by_key = {graph.norm(i["name"]): i["name"] for i in rd["investors"]}
    read_urls = {p["url"] for p in c["pages"] if p["status"] == "read"}
    stage = rd.get("stage")
    # The stage each confirming sentence puts on its leading phrase. Cala sometimes folds two rounds of a company
    # into one: "a pre-seed round led by A" and "B led this seed round" are then two rounds, and the one that
    # carries Cala's label is this one.
    at_lead = {k: set(pagecheck.stages_at_lead(v.get("quote") or "")) for k, v in c["leads"].items() if k in by_key}
    known = stage in pagecheck.STAGES_ON_PAGE
    here = {k for k, st in at_lead.items() if known and stage in st}
    # is Cala's label the one these pages give the round? Their headlines say; without one, any use on the page counts
    label_used = stage in c["headline"] if c.get("headline") else stage in c["stages"]
    elsewhere = {k for k, st in at_lead.items() if known and st and stage not in st} if here or label_used else set()
    # A page published long before the round cannot be about it: what it says was led is an earlier round of the company.
    when = None if rd.get("date_is_report") else rd.get("date")
    early = {k for k, v in c["leads"].items()
             if k in by_key and k not in here and _days_before(c.get("dated", {}).get(v["url"]), when) > pagecheck.NEAR_DAYS}

    def other_stage(key: str, url: str) -> str | None:
        """The stage the page gives the round it speaks of: on the leading phrase, else the only one it names."""
        named = at_lead.get(key) or set()
        if not named:
            on_page = [st for st in c.get("page_stages", {}).get(url, []) if st != stage]
            named = set(on_page) if len(on_page) == 1 else set()
        was = sorted(named, key=list(pagecheck.STAGES_ON_PAGE).index)[0] if named else None
        return graph.STAGE_NAMES.get(was, was) if was else None

    cala_keys = {graph.norm(i["name"]) for i in cala_leads}
    if any(k in cala_keys and k not in early and k not in elsewhere for k in c["leads"]):
        # another lead of this round is confirmed by a page from its own time: Cala holds two rounds as one here,
        # and the old page is about the other
        elsewhere |= early
    else:
        # every page that names a lead is that old: one round, which Cala dates late. The claim is kept with the page's date.
        for k in early:
            c["leads"][k] = {**c["leads"][k], "earlier": {"date": c["dated"][c["leads"][k]["url"]],
                                                           "stage_name": other_stage(k, c["leads"][k]["url"])}}
    page_leads = [by_key[k] for k in c["leads"] if k in by_key and k not in elsewhere]
    for i in rd["investors"]:
        if not i["is_lead"]:
            continue   # a page confirms or corrects a lead Cala names; on its own it never adds one
        key = graph.norm(i["name"])
        hit, listed = c["leads"].get(key), c["followers"].get(key)
        if hit and key in elsewhere:
            if listed and key not in early:   # one page says it led the other round, another lists it under this round's lead
                hit = None
            else:
                i["check"] = {"status": "other", **hit, "other_round": other_stage(key, hit["url"])}
                tally["unstated"] += 1
                continue
        if hit:
            i["check"] = {"status": "lead", **hit}
            tally["lead"] += 1
        elif listed and page_leads and (short := _short_lead(i["name"], [v for k, v in c["leads"].items() if k in by_key and k not in elsewhere])):
            i["check"] = {"status": "lead", **short, "short_name": True}   # the lead sentence names it by its short name
            tally["lead"] += 1
        elif listed and page_leads:
            # the page names the lead and lists this investor among the others: a co-investor, not the lead
            i["is_lead"] = False
            led_by = _led_by(page_leads, listed.get("quote"), i["name"])
            proof = listed
            if not any(pagecheck.read(listed.get("quote") or "", n)["status"] == "lead" for n in led_by):
                # the sentence that lists it names no lead ("co-led by angel investors, with ..."): quote the one that does
                k = next((k for k in c["leads"] if by_key.get(k) in led_by and k not in elsewhere), None)
                if k:
                    proof = {**c["leads"][k], "listed": listed.get("quote")}
            i["check"] = {"status": "follower", **proof, "led_by": led_by, "page_date": c.get("dated", {}).get(proof.get("url"))}
            rd.setdefault("corrected", []).append(key)
            if i["id"]:
                rd.setdefault("corrected_ids", []).append(i["id"])
            tally["corrected"] += 1
        elif key in c["named"]:
            i["check"] = {"status": "unstated", **(listed or c["mentions"].get(key, {})),
                          **({"led_by": _led_by(page_leads, None, i["name"])} if page_leads else {})}
            tally["unstated"] += 1
        elif read_urls & {x["url"] for x in i["sources"]}:
            i["check"] = {"status": "absent"}   # the page Cala cites for this investor was read and does not name it
            tally["absent"] += 1
        else:
            i["check"] = {"status": "unread"}   # its own pages could not be read; the others do not name it
            tally["unread"] += 1
    fixes = [i["check"] for i in rd["investors"] if (i.get("check") or {}).get("status") == "follower"]
    if len({tuple(sorted(f["led_by"])) for f in fixes}) > 1 and len({f.get("url") for f in fixes}) > 1:
        for f in fixes:   # two pages, two different leads: Cala holds two rounds of this company as one
            f["two_rounds"] = True
    if rd.get("corrected"):
        # Cala named the wrong lead and the page names the right one: that one leads this round
        for i in rd["investors"]:
            key = graph.norm(i["name"])
            hit = c["leads"].get(key)
            if hit and not i["is_lead"] and key not in elsewhere and key not in rd["corrected"]:
                i["is_lead"] = i["promoted"] = True
                i["check"] = {"status": "lead", **hit}
                tally["promoted"] += 1
                tally["lead"] += 1
    # Cala's stage label against the label on the leading phrase: when every such phrase names one other stage, use it.
    said = set().union(*at_lead.values()) if at_lead else set()
    if known and said and not here and not elsewhere and any(i.get("check", {}).get("status") == "lead" for i in rd["investors"]):
        new = next(iter(said)) if len(said) == 1 else None
        rd["stage_page"] = {"cala": rd["stage_name"], "page": graph.STAGE_NAMES.get(new, new) if new else None}
        rd["stage"], rd["stage_name"] = new, graph.STAGE_NAMES.get(new, new) if new else "Round"
        tally["stages"] += 1
    if rd.get("date_is_report") and c.get("published"):
        rd["date"] = min(c["published"].values())   # no date in Cala: the day the page says it was published
        rd["date_from_page"] = True
    if rd.get("amount") and c["amount"] is False:
        rd["amount_set_aside"] = {"amount": rd["amount"], "currency": rd["currency"], "why": "page"}
        rd["amount"] = rd["currency"] = None
        tally["amounts"] += 1
    stage = rd.get("stage")
    if not rd.get("stage_page") and stage in pagecheck.STAGES_ON_PAGE and c["stages"] and stage not in c["stages"]:
        # the pages never use Cala's label: take the one their headline uses, else claim no stage
        new = c["stages"][0] if len(c["stages"]) == 1 and c["stages"][0] in c.get("headline", []) else None
        rd["stage_page"] = {"cala": rd["stage_name"], "page": graph.STAGE_NAMES.get(new, new) if new else None}
        rd["stage"], rd["stage_name"] = new, graph.STAGE_NAMES.get(new, new) if new else "Round"
        tally["stages"] += 1


def _on_page(d: dict, soft_key: str) -> bool:
    """The page about this round names the investor who said yes."""
    return any(k == soft_key and on for k, on in zip(d.get("with_keys", []), d.get("with_on_page", [])))


def _days_before(page_date: str | None, round_date: str | None) -> int:
    """How many days before the round a page was published (0 when either date is missing or unreadable)."""
    try:
        return (date.fromisoformat((round_date or "")[:10]) - date.fromisoformat((page_date or "")[:10])).days
    except ValueError:
        return 0


def _led_by(page_leads: list[str], quote: str | None, me: str) -> list[str]:
    """Who the page says led: the leads named in the quoted sentence when it names any (Cala can fold two rounds of
    a company into one, each with its own lead), and one name per firm ('Acton Capital', 'Acton Capital Partners')."""
    names = [n for n in page_leads if n != me]
    in_quote = [n for n in names if quote and pagecheck.read(quote, n)["status"] == "lead"]
    out, seen = [], set()
    for n in sorted(in_quote or names, key=len):
        k = graph.root(n)[0] or graph.norm(n)
        if k not in seen:
            seen.add(k)
            out.append(n)
    return out


GENERIC_FIRST = {"nordic", "north", "south", "east", "west", "capital", "venture", "ventures", "global", "first", "fund",
                 "partners", "tech", "digital", "general", "united", "national", "european", "euro", "american", "asia",
                 "pacific", "blue", "green", "black", "white", "open", "next", "future", "alpha", "beta", "seed", "angel"}


def _short_lead(name: str, hits: list[dict]) -> dict | None:
    """A page can name a lead by the first word of its name alone: "led by Prosus Ventures, UBS and MUFG" names
    MUFG Innovation Partners. Then the page says it led, and Cala's claim stands. The word has to stand alone
    ("Nordic" in "Nordic Ninja" is another firm) and be more than a common word."""
    words = name.split()
    first = words[0] if len(words) > 1 else ""
    if len(first) < 4 or first.lower() in GENERIC_FIRST:
        return None
    alone = re.compile(rf"(?<![A-Za-z0-9]){re.escape(first)}(?![A-Za-z0-9])(?!\s+[A-Z0-9&])")
    for h in hits:
        q = pagecheck.tidy(h.get("quote") or "")
        if any(pagecheck._says_led(q, m.start(), m.end()) for m in alone.finditer(q)):
            return h
    return None


def _note_check(rd: dict, c: dict | None, findings: list[dict], claims: list[list]) -> None:
    """Keep what the pages changed, so the result can show it: every lead claim with its outcome, and each lead,
    amount or stage where the page disagrees with Cala."""
    co = (rd.get("issuer") or {}).get("name")
    base = {"round": rd["id"], "company": co, "stage_name": rd["stage_name"], "date": rd["date"]}
    read = [p["url"] for p in (c or {}).get("pages", []) if p["status"] == "read"][:3]
    for i in rd["investors"]:
        ch = i.get("check")
        if not ch or not co:   # a round Cala names no company for is no claim anyone could repeat
            continue
        claims.append([rd["id"], graph.norm(i["name"]), ch["status"]])
        if ch["status"] == "lead" and ch.get("quote") and ch.get("url"):
            # a claim only an older page backs is listed as that page has it: its date, and its stage or none
            findings.append({**base, **(ch.get("earlier") or {}), "kind": "confirmed", "cala": i["name"], "quote": ch["quote"],
                             "url": ch["url"], "publisher": ch.get("publisher")})
            if ch.get("earlier") and not ch["earlier"]["stage_name"]:
                findings[-1]["stage_name"] = "Round"
        if ch["status"] == "follower" and co and not _no_name(i["name"]):
            findings.append({**base, "kind": "lead", "cala": i["name"], "page": ch.get("led_by") or [], "quote": ch.get("quote"),
                             "url": ch.get("url"), "publisher": ch.get("publisher"), "other_round": ch.get("other_round")})
            # the page that names the lead is from another time than Cala's date for the round: the page's date is the round's
            if ch.get("page_date") and rd.get("date") and abs(_days_before(ch["page_date"], rd["date"])) > pagecheck.NEAR_DAYS:
                findings[-1].update({"date": ch["page_date"], "cala_date": rd["date"]})
            if ch.get("two_rounds"):
                findings[-1]["note"] = "Cala's pages name two different leads here: it holds two rounds of this company as one."
                # Cala's one stage label cannot belong to both: keep it only where the page's own sentence carries it
                on_page = pagecheck.stages_at_lead(ch.get("quote") or "")
                if rd.get("stage") not in on_page:
                    was = next(iter(on_page)) if len(on_page) == 1 else None
                    findings[-1]["stage_name"] = graph.STAGE_NAMES.get(was, was) if was else "Round"
    aside = rd.get("amount_set_aside") or {}
    if aside.get("why") == "page" and co:
        findings.append({**base, "kind": "amount", "amount": aside["amount"], "currency": aside["currency"], "pages": read})
    if rd.get("stage_page") and co:
        findings.append({**base, "kind": "stage", "cala": rd["stage_page"]["cala"], "page": rd["stage_page"]["page"], "pages": read})


def _check_of(rd: dict, key: str, ids: list[str] | None = None) -> dict | None:
    i = next((i for i in rd["investors"] if graph.norm(i["name"]) == key or (ids and i["id"] in ids)), None)
    return i.get("check") if i else None


def run_id(inputs: dict) -> str:
    key = {"s": sorted(sorted(s["ids"]) for s in inputs["soft_yeses"]), "stage": inputs.get("stage"),
           "company": (inputs.get("company") or {}).get("id")}
    if (inputs.get("company") or {}).get("blind"):
        key["blind"] = True   # the walk as it would have gone before the company's own round
    return hashlib.sha256(json.dumps(key, sort_keys=True).encode()).hexdigest()[:10]


def _recency(iso: str | None) -> float:
    y = graph.years_ago(iso)
    return 0.4 if y is None else 0.5 ** (max(y, 0) / 3)


def _stage_weight(stage: str | None, want: str | None, mild: bool = False, near: bool = False) -> float:
    """How much a round counts for a raise at stage `want`. `mild`: the stage was not asked for but read off the
    rounds the soft yeses joined, so it weighs less. `near`: a round next to that stage whose label was set aside."""
    if not want or want not in graph.STAGE_ORDER:
        return 1.0
    steps = (1.0, 0.85, 0.65, 0.45) if mild else (1.0, 0.7, 0.4, 0.25)
    if near:
        return steps[1]
    if not stage or stage not in graph.STAGE_ORDER:
        return 0.8 if mild else 0.6
    return steps[min(3, abs(graph.STAGE_ORDER.index(stage) - graph.STAGE_ORDER.index(want)))]


def _months_ago(iso: str | None) -> float | None:
    y = graph.years_ago(iso)
    return None if y is None else y * 12


MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")


def _nearest(srcs: list[dict], when: str | None, limit: int) -> list[dict]:
    """Sources for a round, the page dated closest to the round first: that is the one that reports it.
    Cala also attaches older pages about the same company, which state other amounts."""
    seen, out = set(), []
    for x in srcs:
        if x["url"] not in seen:
            seen.add(x["url"])
            out.append(x)
    if when:
        def gap(x: dict) -> int:
            try:
                return abs((date.fromisoformat(x["date"][:10]) - date.fromisoformat(when[:10])).days)
            except (TypeError, ValueError):
                return 10 ** 6
        out.sort(key=gap)
    return out[:limit]


def _fact_sources(lead_srcs: list[dict], rd: dict, when: str | None, limit: int) -> list[dict]:
    """Sources for one evidence row, each tagged with what it backs: "lead" (the page names this investor in
    the round), "amount", "date". One page per fact comes first, then the pages dated closest to the round."""
    merged: dict[str, dict] = {}
    for x in lead_srcs:
        merged.setdefault(x["url"], {**x, "backs": ["lead"]})
    for x in rd["sources"]:
        have = merged.get(x["url"])
        if have:
            have["backs"] += [b for b in x.get("backs", []) if b not in have["backs"]]
        else:
            merged[x["url"]] = {**x, "backs": list(x.get("backs", []))}
    # among pages equally close to the round, the one that backs more of the row's facts comes first
    ranked = _nearest(sorted(merged.values(), key=lambda x: -len(x["backs"])), when, 99)
    out: list[dict] = []
    for tag in ("lead", "amount", "date"):
        if tag == "amount" and not rd.get("amount"):
            continue
        if not any(tag in x["backs"] for x in out):
            hit = next((x for x in ranked if tag in x["backs"]), None)
            if hit:
                out.append(hit)
    return (out + [x for x in ranked if x not in out])[:limit]


def _net(rounds: dict[str, dict], joined: dict, backed: dict, softs: list[dict]) -> list[dict]:
    """Each walked round as a row of names: [name, led by Cala's flag, what the cited page said]."""
    def row(rd: dict, who: list[str], led: bool = False) -> dict:
        return {"id": rd["id"], "company": (rd.get("issuer") or {}).get("name"), "stage_name": rd.get("stage_name"),
                "date": rd.get("date"), "via": rd.get("via", "graph"), "soft": who, "soft_led": led,
                "investors": [[i["name"], 1 if i["is_lead"] else 0, (i.get("check") or {}).get("status")]
                              for i in rd["investors"] if not _no_name(i["name"])][:24]}

    out = [row(rd, sorted(joined[rid] | backed[rid])) for rid, rd in rounds.items()]
    seen = {r["id"] for r in out}
    for s in softs:   # the rounds a soft-yes investor led itself: the people it brought in
        for rd, _ in s.get("_own", []):
            if rd["id"] not in seen:
                seen.add(rd["id"])
                out.append(row(rd, [s["key"]], True))
    return sorted(out, key=lambda r: r["date"] or "", reverse=True)[:240]


def _round_brief(rd: dict) -> dict:
    out = {"id": rd["id"], "issuer": rd["issuer"], "stage": rd["stage"], "stage_name": rd["stage_name"],
           "date": rd["date"], "amount": rd["amount"], "currency": rd["currency"]}
    for k in ("stage_set_aside", "stage_page", "off_page"):
        if rd.get(k):
            out[k] = rd[k]
    return out


LETTERED = re.compile(r"^SERIES_[A-Z]$")


def _days_apart(a: str, b: str) -> int:
    try:
        return abs((date.fromisoformat(a[:10]) - date.fromisoformat(b[:10])).days)
    except ValueError:
        return 0


def _set_aside_stages(items: list[dict]) -> None:
    """A company raises one Series A. When Cala labels two of its rounds, months apart, with the same lettered
    stage, the later one is shown without the label and says why. Changes the round dicts it is given."""
    groups: dict[tuple, list[dict]] = collections.defaultdict(list)
    for d in items:
        stage = d.get("stage") or (d.get("stage_set_aside") or {}).get("stage")
        issuer = d.get("issuer") or {}
        who = issuer.get("id") or graph.norm(issuer.get("name") or "")
        if stage and LETTERED.match(stage) and d.get("date") and who:
            groups[(who, stage)].append(d)
    for (_, stage), ds in groups.items():
        first = min(ds, key=lambda d: d["date"])
        for d in ds:
            if d["id"] == first["id"] or _days_apart(d["date"], first["date"]) < SAME_STAGE_DAYS:
                continue
            d["stage_set_aside"] = {"stage": stage, "stage_name": graph.STAGE_NAMES.get(stage, stage), "other": first["date"]}
            d["stage"], d["stage_name"] = None, "Round"


STRONGER = ("lead", "follower", "report", "other", "unstated", "absent", "off", "unread")   # which outcome of two is kept
PAGE_READ = ("lead", "other", "unstated", "absent")   # the cited page was read; only "lead" means it says so


def _pulse(inv: dict, dates: dict[str, str] | None = None, led_too: dict[str, dict] | None = None,
           canon: dict[str, str] | None = None, not_led: set[str] | None = None,
           labels: dict[str, str] | None = None, checks: dict[str, str] | None = None) -> dict:
    """What an investor's own round list says about how it behaves.

    One date per round, used for the chart, the recent count and "last led" alike: the round's own date when this
    walk opened the round (`dates`), else the date it was first reported.
    `led_too`: rounds whose own record names this investor as lead, even if its round list does not say so.
    `canon`: round ids Cala holds twice for one deal -> the id that is kept, so a deal counts once.
    `not_led`: rounds where the page Cala cites names another lead: counted as joined, not led.
    `checks`: round id -> what the cited page said about this investor leading it, for the rounds any walk has opened.
    Cala's lead flag is counted as before; beside it goes how many of those rounds a page was read for, and confirms.
    """
    dates, led_too, canon, not_led, labels = dates or {}, led_too or {}, canon or {}, not_led or set(), labels or {}
    checks = checks or {}
    rounds, seen = [], {}
    for r in inv["rounds"]:
        rid = canon.get(r["id"], r["id"])
        label = labels.get(rid) or graph.STAGE_NAMES.get((r["label"] or "").upper().replace("-", "_").replace(" ", "_"), r["label"])
        led = (r["is_lead"] and rid not in not_led) or rid in led_too
        if rid in seen:   # one deal under two round records: one round, led if either record says so
            seen[rid]["is_lead"] = seen[rid]["is_lead"] or led
            seen[rid]["label"] = seen[rid]["label"] or label
            continue
        seen[rid] = {"id": rid, "label": label, "is_lead": led, "when": dates.get(rid) or dates.get(r["id"]) or r["reported"]}
        rounds.append(seen[rid])
    for rid, x in led_too.items():
        if rid not in seen:
            rounds.append({"id": rid, "label": x.get("label"), "is_lead": True, "when": x.get("when")})
    led = [r for r in rounds if r["is_lead"]]
    by_year: dict[str, dict] = {}
    for r in rounds:
        y = (r["when"] or "")[:4]
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
    led_recent = sum(1 for r in led if (_months_ago(r["when"]) or 999) <= RECENT_MONTHS)
    stages = collections.Counter(r["label"] for r in led if r["label"])
    latest = max((r for r in led if r["when"]), key=lambda r: r["when"], default=None)
    recent = [r for r in led if (_months_ago(r["when"]) or 999) <= RECENT_MONTHS]
    return {"rounds": len(rounds), "led": len(led), "lead_rate": round(len(led) / len(rounds), 2) if rounds else None,
            "led_recent": led_recent, "recent_months": RECENT_MONTHS, "by_year": filled,
            "led_read": sum(1 for r in led if checks.get(r["id"]) in PAGE_READ),
            "led_on_page": sum(1 for r in led if checks.get(r["id"]) == "lead"),
            "led_recent_read": sum(1 for r in recent if checks.get(r["id"]) in PAGE_READ),
            "led_recent_on_page": sum(1 for r in recent if checks.get(r["id"]) == "lead"),
            # the latest round it led, and whether this walk opened it (a real date) or only saw it reported
            "last_led": {"id": latest["id"], "when": latest["when"], "opened": latest["id"] in dates,
                         "check": checks.get(latest["id"])} if latest else None,
            "led_stages": [{"stage": s, "n": n} for s, n in stages.most_common(5)],
            "led_list": [[r["id"], r["label"]] for r in led],   # taken out again before the result is stored
            "capped": inv["capped"], "portfolio_size": len(inv["portfolio"])}


def _stronger(a: str | None, b: str | None) -> str | None:
    """Of two outcomes for one claim, the one that says more."""
    if a not in STRONGER:
        return b
    if b not in STRONGER:
        return a
    return min(a, b, key=STRONGER.index)


def _record(key: str, inv: dict, dates: dict, led: dict, canon: dict, not_led: set, labels: dict,
            checks: dict[str, str] | None = None) -> dict:
    """What every walk so far has learned about this investor's own rounds, joined with what this one learned.

    A walk opens only some of an investor's rounds, so two walks used to count the same investor differently
    ("leads 22 of 47" here, "25 of 48" there). The joined record is kept, and every walk counts from it."""
    from . import extras   # extras reads walk results; imported here so the two modules stay apart
    own = {r["id"] for r in inv["rounds"]} | set(led)
    own |= {canon[i] for i in own if i in canon}
    mine = {"dates": {k: v for k, v in dates.items() if k in own and v}, "led_too": dict(led),
            "canon": {k: v for k, v in canon.items() if k in own or v in own},
            "not_led": sorted(not_led), "labels": {k: v for k, v in labels.items() if k in own and v},
            "checks": dict(checks or {})}
    try:
        old = extras.blob_get("record2:" + key) or {}
    except Exception:
        return mine
    # one deal held under several ids: every id points at the smallest, whichever walk met them first
    group: dict[str, str] = {}

    def find(x: str) -> str:
        while group.get(x, x) != x:
            x = group[x]
        return x

    for a, b in list((old.get("canon") or {}).items()) + list(mine["canon"].items()):
        ra, rb = find(a), find(b)
        if ra != rb:
            group[max(ra, rb)] = min(ra, rb)
        group.setdefault(a, find(a)), group.setdefault(b, find(b))
    both = {"canon": {x: find(x) for x in group if find(x) != x},
            # a value an earlier walk kept stays, so the record cannot flip between two walks
            "dates": {**mine["dates"], **(old.get("dates") or {})},
            "labels": {**mine["labels"], **(old.get("labels") or {})},
            "led_too": {**mine["led_too"], **(old.get("led_too") or {})},
            "not_led": sorted(set(old.get("not_led") or []) | set(mine["not_led"])),
            # what a page said about a round stays said: every walk counts confirmations from all walks so far
            "checks": {r: _stronger(mine["checks"].get(r), (old.get("checks") or {}).get(r))
                       for r in sorted(set(mine["checks"]) | set(old.get("checks") or {}))}}
    # Cala can hold one firm as several entities, and a walk does not always meet all of them: keep every round seen
    held = {r["id"]: r for r in old.get("rounds") or []}
    for r in inv["rounds"]:
        held.setdefault(r["id"], {k: r.get(k) for k in ("id", "label", "is_lead", "reported")})
        held[r["id"]]["is_lead"] = bool(held[r["id"]]["is_lead"] or r["is_lead"])
    both["rounds"] = sorted(held.values(), key=lambda r: (r.get("reported") or "", r["id"]))
    for field in ("dates", "labels", "checks"):
        for x, rep in both["canon"].items():
            if x in both[field]:
                both[field].setdefault(rep, both[field][x])
    if both != old:
        try:
            extras.blob_put("record2:" + key, both)
        except Exception:
            pass
    return both


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
    if a == b or (min(len(a), len(b)) >= 4 and (a.startswith(b) or b.startswith(a))):
        return True
    return len(a) >= 6 and a.replace("and", "") == b.replace("and", "")   # 'Job&Talent' and 'Jobandtalent'


def same_company(issuer: dict | None, mine: dict) -> bool:
    """Is this round's company the founder's own? The same Cala entity, or the same name give or take a tail
    ('Cala' and 'Cala AI'). Stricter than `_same_company`: 'Cala' is not 'Calabrio'."""
    if not issuer:
        return False
    if issuer.get("id") and issuer["id"] in ((mine.get("ids") or []) + [mine.get("id")]):
        return True
    a, b = graph.norm(issuer.get("name") or ""), graph.norm(mine.get("name") or "")
    if not a or not b:
        return False
    return a == b or any(a == b + t or b == a + t for t in pagecheck.TAILS)


def _same_deal(a: dict, b: dict) -> bool:
    """Cala sometimes holds one deal as two round entities (one per report). Same company, and the same
    day, or the same stage in the same month, or the same amount within three months."""
    ia, ib = a.get("issuer"), b.get("issuer")
    if not ia or not ib or not ((ia.get("id") and ia.get("id") == ib.get("id")) or
                                _same_company(graph.norm(ia["name"]), graph.norm(ib["name"]))):
        return _same_backers(a, b)
    da, db = a.get("date") or "", b.get("date") or ""
    if da and da[:10] == db[:10]:
        return True
    stage = a.get("stage") == b.get("stage") or not a.get("stage") or not b.get("stage")
    if stage and da and da[:7] == db[:7]:
        return True
    if a.get("amount") and a.get("amount") == b.get("amount") and a.get("currency") == b.get("currency"):
        # one sum, one currency: the same deal, unless the two are dated far apart
        return a.get("stage") == b.get("stage") or not da or not db or _days_apart(da, db) <= 90
    return False


def _same_backers(a: dict, b: dict) -> bool:
    """One deal that Cala holds under two company records ('GC AI' and 'General Counsel AI'), or once without its
    company. Only on the round's own date, the same day; never two different amounts; and nearly the same investors:
    half of the shorter list when both carry the same amount, four in five (and three names) when one carries none."""
    da, db = a.get("date") or "", b.get("date") or ""
    if not da or da[:10] != db[:10] or a.get("date_is_report") or b.get("date_is_report"):
        return False
    xa, xb = a.get("amount"), b.get("amount")
    if xa and xb and (xa != xb or a.get("currency") != b.get("currency")):
        return False
    ka = {graph.norm(i["name"]) for i in a.get("investors") or [] if not _no_name(i["name"])}
    kb = {graph.norm(i["name"]) for i in b.get("investors") or [] if not _no_name(i["name"])}
    shared, small = len(ka & kb), min(len(ka), len(kb))
    if xa and xb:
        return shared >= 2 and shared >= 0.5 * small
    return shared >= 3 and shared >= 0.8 * small


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
        for k in ("stage", "amount", "currency", "date", "issuer"):
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


WHY_SAME = {"name": "the same name, apart from the fund's legal tail",
            "round": "Cala lists both in one round",
            "company": "Cala lists both in rounds of one company",
            "record": "Cala's search for the name returns the same record"}


def _is_firm(i: dict) -> bool:
    return i.get("kind") != "person" and bool(graph.norm(i["name"])) and not _no_name(i["name"])


def _same_firm(a: str, b: str) -> bool:
    return graph.firm_key(a) == graph.firm_key(b) or graph.longer_name(a, b)


def _groups(pairs: list[tuple[str, str, str]], names: dict[str, str], softs: set[str], seen: collections.Counter) -> dict[str, dict]:
    """Keys tied together two by two -> for every key that is not its group's own: {key, name, why}. The group goes
    by the soft yes when one is in it, else by its shortest spelling. Two soft yeses are never made one."""
    parent: dict[str, str] = {}
    because: dict[str, str] = {}

    def find(x: str) -> str:
        parent.setdefault(x, x)
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for a, b, why in pairs:
        ra, rb = find(a), find(b)
        if ra != rb and not ({k for k in parent if find(k) == ra} & softs and {k for k in parent if find(k) == rb} & softs):
            parent[max(ra, rb)] = min(ra, rb)
            because.setdefault(a, why), because.setdefault(b, why)
    members: dict[str, list[str]] = collections.defaultdict(list)
    for k in parent:
        members[find(k)].append(k)
    out = {}
    for group in members.values():
        if len(group) < 2:
            continue
        own = next((k for k in sorted(group) if k in softs), None) or \
            min(group, key=lambda k: (names[k].isupper(), len(names[k]), -seen[k], k))
        for k in group:
            if k != own:
                out[k] = {"key": own, "name": names[own], "why": because.get(k) or because.get(own) or "name"}
    return out


def _firm_alias(rds: list[dict], softs: list[dict]) -> tuple[dict[str, dict], dict[str, str]]:
    """Spellings of one firm among the investors of these rounds. Merged only when it is clearly one firm: the same
    name once the vehicle's legal tail is off ('Seaya Ventures' and 'Seaya Ventures II, FCR'), or one name is the
    other plus plain fund words ('Decibel', 'Decibel Partners') and Cala lists both in one round or in rounds of
    one company. Returns key -> {key, name, why} for each spelling that goes by another, and every key's name."""
    names = {s["key"]: s["name"] for s in softs}
    seen: collections.Counter = collections.Counter()
    in_round: list[set[str]] = []
    in_co: dict[str, set[str]] = collections.defaultdict(set)
    for rd in rds:
        keys = set()
        for i in rd["investors"]:
            if not _is_firm(i):
                continue
            k = graph.norm(i["name"])
            keys.add(k)
            seen[k] += 1
            if k not in names or (names[k].isupper() and not i["name"].isupper()):
                names[k] = i["name"]
        in_round.append(keys)
        issuer = rd.get("issuer") or {}
        co = issuer.get("id") or graph.norm(issuer.get("name") or "")
        if co:
            in_co[co] |= keys
    pairs = []
    by_firm: dict[str, list[str]] = collections.defaultdict(list)
    for k in sorted(names):
        by_firm[graph.firm_key(names[k])].append(k)
    for ks in by_firm.values():
        pairs += [(ks[0], k, "name") for k in ks[1:]]
    for why, sets in (("round", in_round), ("company", list(in_co.values()))):
        for keys in sets:
            ks = sorted(keys)
            pairs += [(a, b, why) for n, a in enumerate(ks) for b in ks[n + 1:] if graph.longer_name(names[a], names[b])]
    return _groups(pairs, names, {s["key"] for s in softs}, seen), names


def _rename_firms(rds: list[dict], alias: dict[str, dict], tally: collections.Counter, findings: list[dict],
                  claims: list[list]) -> None:
    """Write each merged spelling as its firm's one name, in every round. Two rows of one firm in one round become
    one row: a lead if either was. A 'correction' from one spelling to the other was no correction and is taken back."""
    if not alias:
        return
    touched = set(alias) | {a["key"] for a in alias.values()}
    for rd in rds:
        rows, at = [], {}
        for i in rd["investors"]:
            k = graph.norm(i["name"])
            a = alias.get(k) if _is_firm(i) else None
            if a:
                i["was"], i["name"], k = i["name"], a["name"], a["key"]
            have = at.get(k) if k in touched and _is_firm(i) else None
            if have is None:
                if k in touched and _is_firm(i):
                    at[k] = i
                rows.append(i)
                continue
            good = [x for x in (have, i) if x["is_lead"]]
            lead = next((x for x in good if (x.get("check") or {}).get("status") in CONFIRMED), good[0] if good else None)
            for x in (have, i):
                if lead and x is not lead and (x.get("check") or {}).get("status") == "follower":
                    old = graph.norm(x.get("was") or x["name"])
                    rd["corrected"] = [c for c in rd.get("corrected", []) if c != old]
                    rd["corrected_ids"] = [c for c in rd.get("corrected_ids", []) if c != x["id"]]
                    findings[:] = [f for f in findings if not (f["round"] == rd["id"] and f["kind"] == "lead"
                                                               and f["cala"] == (x.get("was") or x["name"]))]
                    claims[:] = [c for c in claims if c != [rd["id"], old, "follower"]]
                    tally["corrected"] -= 1
            keep = lead or min((have, i), key=lambda x: STRONGER.index((x.get("check") or {}).get("status"))
                               if (x.get("check") or {}).get("status") in STRONGER else 99)
            for f in ("check", "promoted", "lead_reported"):
                if keep.get(f) is not None:
                    have[f] = keep[f]
                else:
                    have.pop(f, None)
            have["is_lead"] = bool(lead)
            have["sources"] = (have["sources"] + [x for x in i["sources"] if x["url"] not in {y["url"] for y in have["sources"]}])[:6]
            have["more_ids"] = [u for u in dict.fromkeys(have.get("more_ids", []) + [i["id"]] + i.get("more_ids", []))
                                if u and u != have["id"]]
            have["id"] = have["id"] or (have["more_ids"].pop(0) if have["more_ids"] else None)
        rd["investors"] = rows
        if rd.get("corrected"):
            rd["corrected"] = [alias[c]["key"] if c in alias else c for c in rd["corrected"]]


def _twins(held: dict[str, dict]) -> dict[str, str]:
    """Among one investor's rounds: the ids that are a deal Cala holds twice -> the id that is kept."""
    kept, out = [], {}
    for rid in sorted(held, key=lambda r: (-len(held[r]["investors"]), r)):
        twin = next((k for k in kept if _same_deal(held[k], held[rid])), None)
        if twin:
            out[rid] = twin
        else:
            kept.append(rid)
    return out


def _money(amount: float, currency: str | None) -> str:
    sign = {"USD": "$", "EUR": "\u20ac"}.get(currency or "", "")
    for cut, unit in ((1e9, "B"), (1e6, "M"), (1e3, "K")):
        if amount >= cut:
            n = amount / cut
            return f"{sign}{n:.1f}".rstrip("0").rstrip(".") + unit if n < 10 else f"{sign}{n:.0f}{unit}"
    return f"{sign}{amount:.0f}"


def _stage_id(label: str | None) -> str:
    return (label or "").upper().replace("-", "_").replace(" ", "_")


def _fit_line(stage_name: str, n: int, sizes: dict | None, most: dict | None) -> str:
    """One line on how a lead fits the asked stage, every number a count over Cala's rounds."""
    if not n:
        return f"Led no {stage_name} round in Cala" + (f", {most['n']} at {most['stage']}" if most else "")
    line = f"Led {n} {stage_name} round{'' if n == 1 else 's'} in Cala"
    if sizes:
        lo, hi = _money(sizes["min"], sizes["min_currency"]), _money(sizes["max"], sizes["max_currency"])
        span = lo if lo == hi else f"{lo} to {hi}"
        line += f", {span}" if sizes["n"] >= n else f", {'one' if sizes['n'] == 1 else sizes['n']} of them {span}"
    return line


def _month(iso: str | None) -> str:
    try:
        return f"{MONTHS[int(iso[5:7]) - 1]} {iso[:4]}"
    except (TypeError, ValueError, IndexError):
        return (iso or "an unknown date")[:4]


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
            who, n = _names(sorted({w for d in same for w in d['with']})), len(same)
            status = [(d.get("check") or {}).get("status") for d in same]
            ok, told = status.count("lead"), status.count("report")   # on the cited page, or in a report Cala read
            read = ok + sum(1 for x in status if x in ("unstated", "other", "absent", "off"))
            if ok == n:
                out.append({"tone": "good", "text": f"Led {_plural(n, 'round')} that {who} joined, as the cited "
                                                    f"{'page says' if n == 1 else 'pages say'}"})
            elif told == n:
                out.append({"tone": "good", "text": f"Led {_plural(n, 'round')} that {who} joined, as "
                                                    f"{'a report' if n == 1 else 'reports'} Cala read "
                                                    f"{'says' if n == 1 else 'say'}"})
            elif ok:
                out.append({"tone": "good", "text": f"Led {_plural(n, 'round')} that {who} joined; the cited pages confirm {ok}"
                                                    + (f", reports {told}" if told else "")})
            elif told:
                out.append({"tone": "good", "text": f"Led {_plural(n, 'round')} that {who} joined; reports Cala read back {told}"})
            elif read:
                out.append({"tone": "warn", "text": f"Cala marks it lead of {_plural(n, 'round')} that {who} joined; "
                                                    f"the cited {'page does' if n == 1 else 'pages do'} not say who led"})
            else:
                out.append({"tone": "good", "text": f"Led {_plural(n, 'round')} that {who} joined"})
        if cap:
            out.append({"tone": "good" if not same else "plain",
                        "text": f"Led {_plural(len(cap), 'round')} in companies "
                                f"{_names(sorted({w for d in cap for w in d['with']}))} backs"})
    else:
        out.append({"tone": "plain", "text": f"Sat in {_plural(n, 'round')} with {_names(softs)} without leading"})
    if e.get("doubt"):
        out.append({"tone": "warn", "text": "Cala may have tied this name to the wrong company"})
    p = e.get("pulse")
    recent = e.get("led_recent") or 0
    if recent:
        read, ok = (p or {}).get("led_recent_read") or 0, (p or {}).get("led_recent_on_page") or 0
        out.append({"tone": "good", "text": f"Cala has it leading {_plural(recent, 'round')} in the last {RECENT_MONTHS} months"
                                            + (f"; pages were read for {read} of them and {ok} say it led" if read else "")})
    elif p and p["rounds"]:
        out.append({"tone": "warn", "text": f"No lead dated in the last {RECENT_MONTHS} months in Cala"})
    if p and p["rounds"] >= 3:
        out.append({"tone": "plain", "text": (f"Leads {p['led']} of the first {p['rounds']} rounds Cala returns for it" if p["capped"]
                                             else f"Leads {p['led']} of its {p['rounds']} rounds in Cala's graph")})
    elif p and p["rounds"]:
        out.append({"tone": "plain", "text": f"Cala's graph lists only {_plural(p['rounds'], 'round')} for it"})
    elif e.get("record") == "missing" or (p and not p["rounds"]):
        out.append({"tone": "plain", "text": "No rounds under this name in Cala's graph; known from reports"})
    else:
        out.append({"tone": "plain", "text": "Own record not read (outside the top of this walk)"})
    f = e.get("fit")
    if f:
        out.append({"tone": "good" if f["match"] else "warn", "text": f["line"]})
        if f.get("size_gap"):
            out.append({"tone": "warn", "text": f["size_gap"]["text"]})
    return out


MIN_HABIT = 10   # rounds on record before "leads" or "follows" is called a habit
MIN_GRAPH = 5    # of those, rounds in Cala's graph itself: the share it led is counted from these alone

GRANTS = re.compile(r"\b(grants?|public funding|funding agency|government agency|innovation agency|development agency|"
                    r"governmental|public organi[sz]ation|ministry)\b", re.I)


def _verdict(s: dict) -> tuple[str, str]:
    """Is the soft yes a follower by habit, or could it lead? Counted, never guessed, and only from enough rounds."""
    n, led, name = s.get("rounds_in_cala") or 0, s.get("led") or 0, s["name"]
    k = (s.get("knowledge") or {}).get("added") or 0
    more = (f" Cala's knowledge search adds {_plural(k, 'round')} it joined that someone else led, "
            f"each checked against the page that reports it.") if k else ""
    if s.get("doubt"):
        return "unknown", s["doubt"]["text"]
    if not s.get("found") or n == 0:
        if k:
            return "thin", f"Cala's graph holds no funding rounds for {name}.{more}"
        return "unknown", f"Cala has no funding rounds for {name}, so there is nothing to walk from it."
    cap = " (the first 50 Cala returns)" if s.get("capped") else ""
    # what the cited pages say about the rounds Cala marks it as leading
    rows = s.get("led_rounds") or []
    ok = sum(1 for d in rows if (d.get("check") or {}).get("status") == "lead")
    open_ = sum(1 for d in rows if (d.get("check") or {}).get("status") in ("unstated", "other", "absent", "off"))
    fixed = len(s.get("led_corrected") or [])
    pages, total = "", ok + open_ + fixed
    if total == 1:
        pages = " The page behind that round " + ("says it led." if ok else "names another lead." if fixed else "does not say who led.")
    elif total:
        bits = ([f"{ok} say{'s' if ok == 1 else ''} it led"] if ok else []) + \
               ([f"{fixed} name{'s' if fixed == 1 else ''} another lead"] if fixed else []) + \
               ([f"{open_} do{'es' if open_ == 1 else ''} not say who led"] if open_ else [])
        pages = f" Of the pages behind its {total} latest, {', '.join(bits)}."
    born = re.search(r"founded in ((?:19|20)\d\d)", s.get("description") or "")
    sample = ""
    if born and int(born.group(1)) <= 2012 and n + k < 60:
        sample = (f" A firm founded in {born.group(1)} has done far more rounds than the {n + k} Cala holds, "
                  f"so read this as a sample.")
    elif n + k < 40:
        sample = " That is the slice Cala holds, not its whole record."
    grant = (f" {name} mostly gives grants and loans. A grant next to a round is not a promise to join one, so check what "
             f"the yes covers.") if GRANTS.search(s.get("description") or "") else ""
    if n + k < MIN_HABIT or n < MIN_GRAPH:
        few = f"Under {MIN_HABIT} rounds is too few to call a habit." if n + k < MIN_HABIT else "That is too few to call a habit."
        return "thin", (f"Cala's graph holds {_plural(n, 'round')} for {name}, and marks it lead in {led}. "
                        f"{few}{pages}{more}{grant}")
    count = f"Cala lists {n} rounds for {name}{cap} and marks it lead in {led}."
    if k:   # reports are searched for rounds someone else led, so they would tilt the count towards following
        count += f" Reports add {k} more that someone else led. Those were looked for, so the habit is counted from Cala's graph alone."
    twice = s.get("duplicates") or 0
    if twice:   # the count is lower than the one Cala returns: say why
        count += f" Cala holds {'one deal' if twice == 1 else f'{twice} deals'} twice, counted once here."
    rate = led / n
    if rate >= 0.5:
        return "leads", f"{count}{pages} In Cala it leads more often than it follows, so ask what would make it lead yours.{sample}{grant}"
    if rate >= 0.25:
        return "mixed", f"{count}{pages} It does lead sometimes, so ask what is missing.{sample}{grant}"
    return "follows", f"{count}{pages} It follows by habit, so the lead has to come from someone else.{sample}{grant}"


def _followed(softs: list[dict]) -> int:
    """Rounds in this walk that a soft yes joined under someone else's lead, from the graph or from a report."""
    return len({d["id"] for s in softs for d in s.get("followed_rounds") or [] if d.get("relation") == "round"})


def _start(softs: list[dict], leads: list[dict]) -> dict:
    """Where to start, and how sure the order is. mode: pick (one first lead) | tie (two that Cala's record cannot
    tell apart) | list (too few rounds walked to rank at all) | none."""
    if not leads:
        return {"mode": "none", "keys": [], "followed": 0}
    followed = _followed(softs)
    top, second = leads[0], leads[1] if len(leads) > 1 else None
    if followed < THIN_WALK:
        return {"mode": "list", "keys": [e["key"] for e in leads[:3]], "followed": followed}
    if second and second["tier"] == top["tier"] and second["score"] >= 0.92 * top["score"]:
        return {"mode": "tie", "keys": [top["key"], second["key"]], "followed": followed}
    return {"mode": "pick", "keys": [top["key"]], "followed": followed}


def _headline(softs: list[dict], leads: list[dict]) -> str:
    names = _names([s["name"] for s in softs])
    if not leads:
        return f"Cala shows no outside investor leading a round that {names} joined."
    top = leads[0]
    same = any(d["relation"] == "round" for e in leads for d in e["evidence"])
    cap = any(d["relation"] == "cap_table" for e in leads for d in e["evidence"])
    where = (f"rounds that {names} joined" + (" or in companies they back" if cap else "")) if same else \
        f"rounds in companies that {names} back{'s' if len(softs) == 1 else ''}"
    active = sum(1 for e in leads if e.get("tier") == "active")
    line = f"{_plural(len(leads), 'investor')} led {where}"
    if 0 < active < len(leads):
        line += f", and {active} of them {'is' if active == 1 else 'are'} leading now"
    followed = _followed(softs)
    if followed < THIN_WALK:
        # a handful of rounds is a list, not a ranking: say so instead of naming a first pick
        back = f"{names} back{'s' if len(softs) == 1 else ''}"
        if not followed:
            return (f"Cala holds no round that {names} joined under another lead. {_plural(len(leads), 'investor')} led "
                    f"rounds in companies {back}: read this as a list, not a ranking.")
        return (f"Cala holds {_plural(followed, 'round')} that {names} joined without leading. That is too few to rank, "
                f"so read this as a list: {_plural(len(leads), 'investor')} led {'it' if followed == 1 else 'them'}"
                + (f" or rounds in companies {back}" if cap else "") + ".")
    line += f". Start with {top['name']}"
    n = len(top["evidence"])
    second = leads[1] if len(leads) > 1 else None
    if second and second["tier"] == top["tier"] and second["score"] >= 0.92 * top["score"]:
        return line + f" or {second['name']}: Cala's record puts them level."   # too close to call one first
    if top.get("led_recent"):
        line += (f": it led {n} of those rounds, and Cala has it leading {_plural(top['led_recent'], 'round')} "
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
        except BudgetExceeded as exc:
            if not state["cache_only"]:
                state["cache_only"] = True
                notes.append("This visit has used its share of fresh Cala reads for today. Showing what is already walked."
                             if "this visit" in str(exc).lower() else
                             "Live reads from Cala are paused (credit cap). Showing what is already walked.")
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
        s["_inv"] = merged
        s.update({"found": bool(invs), "rounds_in_cala": len(all_rounds), "led": len(led), "followed": len(followed),
                  "lead_rate": round(len(led) / len(all_rounds), 2) if all_rounds else None,
                  "walked": len(todo), "capped": merged["capped"], "pulse": _pulse(merged),
                  "description": next((i["description"] for i in invs if i.get("description")), None),
                  # Cala may hold one firm as several entities; say which ones were read as this investor
                  "entities": [{"id": i["id"], "name": i["name"], "rounds": len(i["rounds"]),
                                "portfolio": len(i["portfolio"])} for i in invs if i["rounds"] or i["portfolio"]]})
        desc = (s.get("description") or "").strip()
        if invs and not all_rounds and not portfolio and desc and not graph.INVESTOR_WORDS.search(f"{s['name']} {desc}"):
            # Cala has an entity under this name, with no rounds and no portfolio, described as something other than an investor
            s["doubt"] = {"description": desc,
                          "text": f"Cala's record under this name reads \"{desc.rstrip('.')}\". It holds no rounds and no "
                                  f"portfolio, so this is probably not the investor you mean. Pick another match for {s['name']}."}
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
                    rd["date_is_report"] = True
                own.append((rd, r["sources"]))

        # Second pass: put the same question to Cala's knowledge search, which reads the reports themselves.
        thin = len(followed) < THIN_FOLLOWED
        asked = None
        if s["key"] in deep and not s.get("doubt"):   # a name tied to a non-investor is not read further: reports would be about a namesake
            await emit({"t": "knowledge", "soft": s["key"], "name": s["name"], "state": "asking",
                        "graph_rounds": len(all_rounds), **ledger.as_dict()})
            asked = asyncio.create_task(guarded(knowledge.followed, s["name"], s["key"]))

        recent_led = sorted(led, key=lambda r: r["reported"] or "", reverse=True)[:SOFT_LED_ROUNDS]
        await asyncio.gather(*(open_round(r) for r in todo), *(open_led(r) for r in recent_led))
        s["_own"] = own

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
                      # the passage's own sentence naming the lead, when it has one, is shown as its proof
                      "investors": [{"id": None, "name": graph.pretty(n), "type": None, "kind": "fund", "is_lead": True,
                                     "sources": row["sources"],
                                     **({"check": {"status": "report", **row["said"][n]}} if n in (row.get("said") or {}) else {})}
                                    for n in row["leads"]]}
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
    canon = {also: rid for rid, rd in rounds.items() for also in rd.get("also", [])}

    # 1b. Open the pages Cala cites for these rounds and read what they say about who led.
    checks: dict[str, dict | None] = {}
    tally: collections.Counter = collections.Counter()
    not_led: dict[str, set[str]] = collections.defaultdict(set)   # investor key or id -> rounds a page says it did not lead
    findings: list[dict] = []   # where a page disagrees with Cala
    claims: list[list] = []     # every lead claim checked: [round, investor, outcome]

    async def read_pages(rds: list[dict], seconds: float) -> None:
        rds = [rd for rd in rds if rd.get("via") != "knowledge" and not rd.get("_checked")]
        new = {rd["id"]: rd for rd in rds if rd["id"] not in checks}
        if new:
            await emit({"t": "pages", "state": "reading", "rounds": len(new)})
            got = await pagecheck.check_rounds(list(new.values()), seconds)
            for rid in new:
                checks[rid] = got.get(rid)
        counted = set()
        for rd in rds:
            rd["_checked"] = True
            first = rd["id"] in new and rd["id"] not in counted
            _apply_check(rd, checks[rd["id"]], tally if first else collections.Counter())
            if first:
                _note_check(rd, checks[rd["id"]], findings, claims)
            counted.add(rd["id"])
            for k in rd.get("corrected", []) + rd.get("corrected_ids", []):
                not_led[k].add(rd["id"])
        if new:
            await emit({"t": "pages", "state": "done", "rounds": tally["rounds"], "pages": tally["pages"], "confirmed": tally["lead"],
                        "corrected": tally["corrected"], "unstated": tally["unstated"] + tally["absent"]})

    for rid, rd in rounds.items():   # the page is also asked whether it names the investor who said yes in this round
        rd["look_for"] = [[s["key"], s["name"]] for s in softs if s["key"] in joined[rid]]
        rd["_soft_ids"] = {s["key"]: s["ids"] for s in softs if s["key"] in joined[rid]}
    await read_pages(list(rounds.values()) + [rd for s in softs for rd, _ in s.get("_own", [])], PAGE_SECONDS)

    # One firm under two spellings is one investor, in every round of this walk.
    named: dict[str, dict[str, str]] = collections.defaultdict(dict)   # firm key -> its other spellings, and why they are it

    def all_rounds() -> list[dict]:
        own = [rd for s in softs for rd, _ in s.get("_own", []) if rd["id"] not in rounds]
        return list(rounds.values()) + own

    def unite(alias: dict[str, dict], names: dict[str, str]) -> None:
        for k, a in alias.items():
            named[a["key"]].update(named.pop(k, {}))
            named[a["key"]][names[k]] = WHY_SAME[a["why"]]
        _rename_firms(all_rounds(), alias, tally, findings, claims)
        not_led.clear()
        for rd in all_rounds():
            for k in rd.get("corrected", []) + rd.get("corrected_ids", []):
                not_led[k].add(rd["id"])

    unite(*_firm_alias(all_rounds(), softs))

    async def cached_rounds(inv: dict) -> dict[str, dict]:
        """The rounds of an investor's record that some walk has already opened. Read from the cache only: no credit."""
        out = {}
        for r in inv["rounds"]:
            try:
                rd = await graph.funding_round(cala, r["id"], cache_only=True)
            except CalaError:
                rd = None
            if rd:
                if not rd["date"]:
                    rd["date"], rd["date_is_report"] = r["reported"], True
                out[r["id"]] = rd
        return out

    for s in softs:   # a deal Cala holds twice counts once in the soft yes's own numbers
        inv = s.get("_inv")
        s["_twins"] = {}
        if not inv or not inv["rounds"]:
            continue
        own = {r["id"] for r in inv["rounds"]}
        same = {**_twins(await cached_rounds(inv)), **{k: v for k, v in canon.items() if k in own and v in own}}

        def head(x: str) -> str:
            hops = 0
            while x in same and same[x] != x and hops < 9:
                x, hops = same[x], hops + 1
            return x

        deals = {head(r["id"]) for r in inv["rounds"]}
        n = len(own) - len(deals)
        if n:
            led = {head(r["id"]) for r in inv["rounds"] if r["is_lead"]}
            s.update({"rounds_in_cala": len(deals), "led": len(led), "followed": len(deals) - len(led), "duplicates": n,
                      "lead_rate": round(len(led) / len(deals), 2)})
            s["_twins"] = {r: head(r) for r in own if head(r) != r}
    for s in softs:
        # the soft yes's own led rounds: one the page credits to someone else is not a round it led
        s["led_rounds"], s["led_corrected"] = [], []
        for rd, srcs in s.get("_own", []):
            ck = _check_of(rd, s["key"], s["ids"])
            row = {**_round_brief(rd), "sources": _fact_sources(srcs, rd, rd["date"], 3), "check": ck}
            if ck and ck["status"] == "follower":
                s["led_corrected"].append(row)
                # the page says someone else led it and the soft yes joined: that is a round it followed
                if rd["id"] not in rounds and not any(_same_deal(rd, k) for k in rounds.values()):
                    rounds[rd["id"]] = rd
                    joined[rd["id"]].add(s["key"])
            else:
                s["led_rounds"].append(row)
        s["led_rounds"].sort(key=lambda d: d["date"] or "", reverse=True)
        # ... and a round it joined where the page says it led is not one it followed
        co_led = [rid for rid in list(rounds) if s["key"] in joined[rid] and
                  ((_check_of(rounds[rid], s["key"], s["ids"]) or {}).get("status") == "lead")]
        moved = len(s["led_corrected"]) - len(co_led)
        if s.get("rounds_in_cala"):
            s["led"] = max(0, s["led"] - moved)
            s["followed"] = max(0, s["followed"] + moved)
            s["lead_rate"] = round(s["led"] / s["rounds_in_cala"], 2)
    _set_aside_stages(list(rounds.values()) + [d for s in softs for d in s.get("led_rounds", [])])
    for s in softs:
        if s.get("duplicates"):   # the count shown while reading was Cala's own; say why it is lower now
            await emit({"t": "fold", "key": s["key"], "name": s["name"], "rounds": s["rounds_in_cala"], "led": s["led"],
                        "followed": s["followed"], "folded": s["duplicates"]})

    # The founder's own company. Its rounds say who led already, not who could lead next: they are set aside and shown
    # on their own. An investor Cala already lists in the company is not offered as a new lead either.
    mine = inputs.get("company") or {}
    own_rounds: list[dict] = []
    already: dict[str, str] = {}
    if mine.get("id") or mine.get("name"):
        for rid in [rid for rid, rd in rounds.items() if same_company(rd.get("issuer"), mine)]:
            rd = rounds.pop(rid)
            own_rounds.append({**_round_brief(rd), "with": [s["name"] for s in softs if s["key"] in joined[rid]],
                               "investors": len(rd["investors"]),
                               "leads": [{"key": graph.norm(i["name"]), "name": i["name"], "check": i.get("check")}
                                         for i in rd["investors"] if i["is_lead"] and not _no_name(i["name"])],
                               "sources": _fact_sources(rd["sources"], rd, rd["date"], 3)})
        own_rounds.sort(key=lambda d: d["date"] or "", reverse=True)
        # `blind`: the walk as it was before the company's own round, when nobody was in it yet
        for cid in ([] if mine.get("blind") else (mine.get("ids") or [mine.get("id")])):
            prof = await guarded(graph.company, cid) if cid else None
            for v in (prof or {}).get("investors", []):
                already.setdefault(graph.norm(v["name"]), v["name"])
                if graph.family(v["name"]):
                    already.setdefault(graph.family(v["name"]), v["name"])
    left_out: dict[str, str] = {}

    # 2. Who led those rounds, and who else sat in them.
    def books() -> tuple[dict[str, dict], dict[str, dict]]:
        leads: dict[str, dict] = {}
        cos: dict[str, dict] = {}
        for rid, rd in rounds.items():
            with_keys = sorted(joined[rid] | backed[rid])
            if not (rd.get("issuer") or {}).get("name"):
                continue   # Cala holds this round without its company: nothing a founder could name
            for i in rd["investors"]:
                key = graph.norm(i["name"])
                if i["id"] in soft_ids or key in soft_keys or not key or _no_name(i["name"]):
                    continue
                if key in already or graph.family(i["name"]) in already:
                    if i["is_lead"]:
                        left_out[key] = i["name"]
                    continue
                book = leads if i["is_lead"] else cos
                e = book.setdefault(key, {"key": key, "name": i["name"], "ids": [], "kind": i["kind"], "rounds": {}})
                for uid in [i["id"]] + i.get("more_ids", []):
                    if uid and uid not in e["ids"]:
                        e["ids"].append(uid)
                if len(i["name"]) and not i["name"].isupper() and e["name"].isupper():
                    e["name"] = i["name"]
                e["rounds"][rid] = {"with": with_keys, "sources": i["sources"], "lead_reported": i.get("lead_reported") if i["is_lead"] else None,
                                    "check": i.get("check") or ({"status": "report"} if rd.get("via") == "knowledge" and i["is_lead"] else None),
                                    "promoted": bool(i.get("promoted"))}
        return leads, cos

    leads, cos = books()

    def evidence(e: dict) -> list[dict]:
        out = []
        for rid, link in e["rounds"].items():
            rd = rounds[rid]
            brief, is_report, caution = _round_brief(rd), rd.get("date_is_report", False), None
            earlier = link.get("lead_reported")
            if earlier:
                # Every page naming this investor as lead is older than the date Cala gives the round: two events in one
                # entity. The lead is dated by its own pages, and the amount stays only if a page from then states it.
                caution = (f"Cala dates this round {_month(rd['date'])}, but the pages that name {e['name']} as its lead are "
                           f"from {_month(earlier)} or before. Cala may hold two rounds as one, so the date shown is the report's.")
                near = [x for x in rd["sources"] if "amount" in x.get("backs", []) and x.get("date")
                        and abs((date.fromisoformat(x["date"][:10]) - date.fromisoformat(earlier)).days) <= 60]
                brief = {**brief, "date": earlier} | ({} if near else {"amount": None, "currency": None})
                is_report = True
            srcs = _fact_sources(link["sources"], {**rd, "amount": brief["amount"]}, brief["date"], 4)
            out.append({**brief, "date_is_report": is_report, "caution": caution,
                        "amount_set_aside": rd.get("amount_set_aside"),
                        # what the page Cala cites says about this investor in this round, with the sentence
                        "check": link.get("check"), "promoted": link.get("promoted", False),
                        "with": [next(s["name"] for s in softs if s["key"] == k) for k in link["with"]],
                        "with_keys": link["with"],
                        # does a page about this round name that investor? True, False, or None when no page was read
                        "with_on_page": [(rd.get("soft_on_page") or {}).get(k) for k in link["with"]],
                        # "round": the soft yes was in this round. "cap_table": it backs the company, round not on record.
                        "relation": "round" if any(k in joined[rid] for k in link["with"]) else "cap_table",
                        "co_leads": [i["name"] for i in rd["investors"] if i["is_lead"] and graph.norm(i["name"]) != e["key"]],
                        # "graph": a funding-round entity in Cala. "knowledge": a report Cala's knowledge search read.
                        "via": rd.get("via", "graph"),
                        "investors": None if rd.get("via") == "knowledge" else len(rd["investors"]),
                        "sources": srcs})
        out.sort(key=lambda d: d["date"] or "", reverse=True)
        return out

    # No stage asked for: rank for the stage the soft yeses mostly invest at, and say so.
    staged = collections.Counter(rd["stage"] for rid, rd in rounds.items() if rd.get("stage") in graph.STAGE_ORDER and joined[rid])
    usual = None
    if not want_stage and sum(staged.values()) >= 3:
        top = max(staged.values())
        usual = min((st for st, n in staged.items() if n == top), key=graph.STAGE_ORDER.index)
    rank_stage = want_stage or usual

    def stage_of(d: dict) -> str | None:
        """The round's stage: Cala's label, else the one the page that confirms the lead gives it."""
        if d.get("stage"):
            return d["stage"]
        said = (((d.get("check") or {}).get("earlier") or {}).get("stage_name") or "").upper().replace("-", "_").replace(" ", "_")
        return said if said in graph.STAGE_ORDER else None

    def base_score(ev: list[dict]) -> float:
        s = sum(_recency(d["date"]) * _stage_weight(stage_of(d), rank_stage, mild=not want_stage,
                                                    near=(d.get("stage_set_aside") or {}).get("stage") == rank_stage) *
                (1.0 if d["relation"] == "round" else CAP_WEIGHT) *
                CHECK_WEIGHT.get((d.get("check") or {}).get("status"), CHECK_WEIGHT["unread"]) for d in ev)
        return s * (1 + 0.35 * (len({k for d in ev for k in d["with_keys"]}) - 1))

    def weigh() -> list[dict]:
        for e in list(leads.values()) + list(cos.values()):
            for uid in (aliases(e["key"]) if aliases else []):
                if uid not in e["ids"]:
                    e["ids"].append(uid)
        for e in leads.values():
            e["evidence"] = evidence(e)
            e["ring"] = 1
            e["score"] = base_score(e["evidence"]) * (0.75 if e["kind"] == "person" else 1.0)
        return sorted(leads.values(), key=lambda e: e["score"], reverse=True)

    order = weigh()
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
                e["portfolio"] = e["_inv"]["portfolio"][:150]
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
        e["portfolio"] = inv["portfolio"][:150]
        await emit({"t": "pulse", "key": e["key"], "name": e["name"], "rounds": e["pulse"]["rounds"],
                    "led": e["pulse"]["led"], **ledger.as_dict()})

    await asyncio.gather(*(read_pulse(e) for e in order[:PULSE_TOP]), *(read_pulse(e, free=True) for e in order[PULSE_TOP:]))

    # A lead named in a report and a lead Cala holds as an entity can be one firm ('Inveready', 'Inveready Capital
    # Company'). They are, when one name is the other plus plain fund words and both carry the same Cala record.
    pool = {**cos, **leads}
    pairs = [(a["key"], b["key"], "record") for n, a in enumerate(list(pool.values())) for b in list(pool.values())[n + 1:]
             if a["kind"] != "person" and b["kind"] != "person" and set(a["ids"]) & set(b["ids"]) and _same_firm(a["name"], b["name"])]
    pairs += [(s["key"], e["key"], "record") for s in softs for e in pool.values()
              if e["kind"] != "person" and set(e["ids"]) & set(s["ids"]) and _same_firm(e["name"], s["name"])]
    if pairs:
        names = {e["key"]: e["name"] for e in pool.values()} | {s["key"]: s["name"] for s in softs}
        alias = _groups(pairs, names, soft_keys, collections.Counter({e["key"]: len(e["rounds"]) for e in pool.values()}))
        unite(alias, names)
        was = (leads, cos)
        leads, cos = books()
        for book in (leads, cos):
            for key, e in book.items():   # what was already read about the firm, under any of its spellings, stays read
                olds = [o for k in [key] + [m for m, a in alias.items() if a["key"] == key] for b in was for o in [b.get(k)] if o]
                for o in olds:
                    e["ids"] += [uid for uid in o["ids"] if uid not in e["ids"]]
                invs = list({id(o["_inv"]): o["_inv"] for o in olds if o.get("_inv")}.values())
                if invs:
                    e["_inv"] = invs[0] if len(invs) == 1 else _merge(invs)
                    e["pulse"] = _pulse(e["_inv"])
                    e["portfolio"] = e["_inv"]["portfolio"][:150]
                elif olds and all(o.get("record") == "missing" for o in olds):
                    e["record"] = "missing"
        order = weigh()

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
    opened: dict[str, str] = {rid: rd["date"] for rid, rd in rounds.items()
                              if rd.get("date") and (not rd.get("date_is_report") or rd.get("date_from_page"))}
    for s in softs:
        opened.update({d["id"]: d["date"] for d in s.get("led_rounds", []) if d.get("date")})

    def led_too(e: dict) -> dict[str, dict]:
        """Rounds whose own record names this investor as lead: counted as led in its record too."""
        if e.get("ring") != 1:
            return {}
        return {d["id"]: {"when": d["date"], "label": d["stage_name"] if d["stage"] else None} for d in e["evidence"]}

    def dates_for(e: dict) -> dict[str, str]:
        return opened | {d["id"]: d["date"] for d in e.get("evidence", []) if d.get("date")}

    def not_led_by(e: dict) -> set[str]:
        return set().union(not_led.get(e["key"], set()), *(not_led.get(uid, set()) for uid in e.get("ids", [])))

    async def verify(e: dict, n: int = VERIFY_ROUNDS, free: bool = False):
        inv = e.get("_inv")
        if not inv:
            return
        known = set(e["rounds"]) | {canon.get(r, r) for r in e["rounds"]}
        todo = sorted((r for r in inv["rounds"] if r["is_lead"] and canon.get(r["id"], r["id"]) not in known),
                      key=lambda r: r["reported"] or "", reverse=True)[:n]
        got = []

        async def one(r):
            if free:
                try:
                    rd = await graph.funding_round(cala, r["id"], ledger=ledger, cache_only=True)
                except CalaError:
                    rd = None
            else:
                rd = await guarded(graph.funding_round, r["id"])
            if rd:
                if rd["date"]:
                    opened[rd["id"]] = rd["date"]
                else:
                    rd["date"] = r["reported"]
                    rd["date_is_report"] = True
                got.append((rd, r["sources"]))
                if not free:
                    await emit({"t": "verify", "key": e["key"], "round": _round_brief(rd), **ledger.as_dict()})

        await asyncio.gather(*(one(r) for r in todo))
        # A report can be dated long after its round. Once the opened rounds carry their own dates, the latest led
        # round may be one not opened yet: open that too, so "last led" and the recent count rest on one basis.
        for _ in range(3):
            last = _pulse(inv, dates_for(e), led_too(e), canon)["last_led"]
            if not last or last["opened"] or last["id"] in {rd["id"] for rd, _ in got}:
                break
            before = len(got)
            await one(next(r for r in inv["rounds"] if canon.get(r["id"], r["id"]) == last["id"]))
            if len(got) == before:
                break
        e["_verified"] = got

    final_order = sorted(order[:PULSE_TOP], key=lambda e: e["score"], reverse=True)
    await asyncio.gather(*(verify(e) for e in final_order[:VERIFY_TOP] + second[:2]),
                         *(verify(e, 1) for e in final_order[VERIFY_TOP:] + second[2:]),
                         *(verify(e, 1, free=True) for e in order[PULSE_TOP:]))
    # Those rounds are lead claims too: read their pages, and drop the ones a page credits to someone else.
    await read_pages([rd for e in order + second for rd, _ in e.get("_verified", [])], PAGE_SECONDS * 0.6)
    for e in order + second:   # a round Cala does not date, dated by its page: that date, not the day it was reported
        opened.update({rd["id"]: rd["date"] for rd, _ in e.get("_verified", []) if rd.get("date_from_page")})
    for e in order + second:
        rows = []
        for rd, srcs in e.get("_verified", []):
            ck = _check_of(rd, e["key"], e["ids"])
            if ck and ck["status"] == "follower":
                continue
            rows.append({**_round_brief(rd), "sources": _fact_sources(srcs, rd, rd["date"], 3), "check": ck})
        e["_verified"] = rows
    # Every round opened in this walk now has its own date: rebuild each record on those, and re-check stage labels.
    everything = list(rounds.values()) + [d for s in softs for d in s.get("led_rounds", [])] + \
        [d for e in order + second for d in e.get("_verified", [])] + [d for e in order + second for d in e["evidence"]]
    _set_aside_stages(everything)
    # a stage read from an opened round replaces the label on the investor's list ("Series E" next to "last led: Series B")
    labels = {d["id"]: d["stage_name"] for d in everything if d.get("stage") and d.get("id")}
    said: dict[str, dict[str, str]] = collections.defaultdict(dict)   # investor -> round -> what its page said
    for rid, who, status in claims:
        said[who][canon.get(rid, rid)] = _stronger(status, said[who].get(canon.get(rid, rid)))

    def checks_for(e: dict) -> dict[str, str]:
        mine = dict(said.get(e["key"], {}))
        for d in list(e.get("evidence") or []) + list(e.get("_verified") or []) + list(e.get("led_rounds") or []):
            status = (d.get("check") or {}).get("status")
            if status and d.get("id"):
                mine[canon.get(d["id"], d["id"])] = _stronger(status, mine.get(canon.get(d["id"], d["id"])))
        return mine

    for e in order + second:
        if e.get("_inv"):
            e["_held"] = await cached_rounds(e["_inv"])   # free: only what is already cached
            k = _record(e["key"], e["_inv"], dates_for(e), led_too(e), {**canon, **_twins(e["_held"])}, not_led_by(e), labels,
                        checks_for(e))
            e["pulse"] = _pulse({**e["_inv"], "rounds": k.get("rounds") or e["_inv"]["rounds"]}, k["dates"], k["led_too"],
                                k["canon"], set(k["not_led"]), k["labels"], k.get("checks"))
            # Every round counted as led is looked up by its own id, so the size line never depends on which of the
            # firm's Cala records this walk happened to read. Cache only: no credit.
            for rid, _ in e["pulse"].get("led_list") or []:
                if rid not in e["_held"]:
                    try:
                        rd = await graph.funding_round(cala, rid, cache_only=True)
                    except CalaError:
                        rd = None
                    if rd:
                        e["_held"][rid] = rd
    for s in softs:
        if s.get("_inv"):
            k = _record(s["key"], s["_inv"], opened, {}, {**canon, **s.get("_twins", {})}, not_led_by(s), labels, checks_for(s))
            s["pulse"] = _pulse({**s["_inv"], "rounds": k.get("rounds") or s["_inv"]["rounds"]}, k["dates"], k["led_too"],
                                k["canon"], set(k["not_led"]), k["labels"], k.get("checks"))

    # 6. Final shape.
    def doubt(e: dict) -> dict | None:
        """Cala sometimes ties an investor's name to the wrong legal entity. One case can be told from Cala's own
        record: it does not describe the entity as an investor, and the entity is younger than the round it led."""
        desc = ((e.get("_inv") or {}).get("description") or "").strip()
        m = re.search(r"founded in (\d{4})", desc)
        years = [int(d["date"][:4]) for d in e["evidence"] if d.get("date")]
        if not m or not years or graph.INVESTOR_WORDS.search(desc) or int(m.group(1)) <= min(years):
            return None
        return {"founded": int(m.group(1)), "round_year": min(years), "description": desc,
                "text": f"Cala's record under this name reads \"{desc.rstrip('.')}\", yet it is listed leading a round in "
                        f"{min(years)}. The name is probably tied to the wrong company in Cala: read the source before you use it."}

    # The sizes of the rounds at the asked stage that the soft yeses joined: what a round like the founder's looks like here.
    joined_sizes = sorted((rd["amount"], rd["currency"]) for rid, rd in rounds.items()
                          if want_stage and joined[rid] and rd.get("stage") == want_stage
                          and rd.get("amount") and rd.get("currency") in ("EUR", "USD"))

    def finish(e: dict) -> dict:
        ev = e["evidence"]
        pulse = e.get("pulse")
        led_list = pulse.pop("led_list", []) if pulse else []
        led_known = [{k: d[k] for k in ("id", "issuer", "stage", "stage_name", "date", "amount", "currency", "sources",
                                        "stage_set_aside", "stage_page", "off_page", "check") if k in d}
                     for d in ev] if e["ring"] == 1 else []
        for d in e.get("_verified", []):
            if not any(_same_deal(d, k) for k in led_known):  # one deal held as two round entities shows once
                led_known.append(d)
        led_known.sort(key=lambda d: d["date"] or "", reverse=True)
        last_led = next((d for d in led_known if d["date"]), None)
        # Rounds it led in the last two years: from its record, which already counts the rounds in hand.
        in_hand = sum(1 for d in led_known if (_months_ago(d["date"]) or 999) <= RECENT_MONTHS) if e["ring"] == 1 else 0
        led_recent = pulse["led_recent"] if pulse else in_hand
        # A lead that keeps leading counts for more; one with no recent lead on record counts as unproven.
        e["score"] *= 0.6 + 0.8 * min(1.0, math.log2(1 + led_recent) / math.log2(9))
        unsure = doubt(e)
        if unsure:
            e["score"] *= 0.3
        on_record = (pulse or {}).get("rounds") or 0
        status = [(d.get("check") or {}).get("status") for d in ev]
        confirmed, reported = status.count("lead"), status.count("report")   # said on the cited page; said in a report
        looked = confirmed + sum(1 for x in status if x in ("unstated", "other", "absent", "off"))
        tier = "check" if unsure else "unconfirmed" if e["ring"] == 1 and looked and not (confirmed or reported) else \
            "active" if led_recent and on_record >= 3 else "thin" if led_recent else "quiet"
        per_soft = collections.defaultdict(list)
        for d in ev:
            for k, name in zip(d["with_keys"], d["with"]):
                per_soft[(k, name)].append(d)
        # the round to mention to that investor: the latest one the page confirms, else the latest
        ask = sorted(({"key": k, "name": name, "deals": len(ds),
                       "last": next((d for d in ds if (d.get("check") or {}).get("status") in CONFIRMED and _on_page(d, k)),
                                    next((d for d in ds if (d.get("check") or {}).get("status") in CONFIRMED), ds[0]))}
                      for (k, name), ds in per_soft.items()),
                     key=lambda a: (a["deals"], a["last"]["date"] or ""), reverse=True)
        stages = collections.Counter(d["stage"] for d in led_known if d["stage"])
        fit = None
        if rank_stage:
            n = stages.get(rank_stage, 0)
            listed = next((s["n"] for s in (pulse or {}).get("led_stages", [])
                           if (s["stage"] or "").upper().replace("-", "_").replace(" ", "_") == rank_stage), 0)
            at_stage = max(n, listed)
            long_record = ((pulse or {}).get("led") or 0) >= 3
            # A lead that has led at this stage moves up, more for each such round up to five; one with a real record
            # and no such round moves down.
            if want_stage:
                at_stage = max(n, sum(1 for _, label in led_list if _stage_id(label) == want_stage))
                e["score"] *= (1 + 0.1 * min(at_stage, 5)) if at_stage else 0.6 if long_record else 0.8
                # how large those rounds were: from the rounds this walk opened, else as Cala holds the round
                known, held, sized, done = {d["id"]: d for d in led_known}, e.get("_held") or {}, [], set()
                for rid in [d["id"] for d in led_known if d["stage"] == want_stage] + \
                        [rid for rid, label in led_list if _stage_id(label) == want_stage]:
                    d = known[rid] if rid in known else held.get(rid)
                    # only where the round's own record carries the stage too: a "seed" of a billion is a slip in the label
                    if d and rid not in done and d.get("stage") == want_stage and not any(_same_deal(d, k) for k in sized) and \
                            d.get("amount") and d.get("currency") in ("EUR", "USD"):
                        sized.append(d)
                    done.add(rid)
                sized = sorted(sized, key=lambda d: d["amount"])[:max(at_stage, 0)]
                sizes = {"min": sized[0]["amount"], "min_currency": sized[0]["currency"], "max": sized[-1]["amount"],
                         "max_currency": sized[-1]["currency"], "n": len(sized)} if sized else None
                name = graph.STAGE_NAMES.get(want_stage, want_stage)
                most = next((s for s in (pulse or {}).get("led_stages", []) if _stage_id(s["stage"]) != want_stage), None)
                fit = {"stage": want_stage, "stage_name": name, "led_at_stage": at_stage, "match": at_stage > 0,
                       "sizes": sizes, "line": _fit_line(name, at_stage, sizes, most)}
                # Its rounds at this stage are all far larger, or all far smaller, than the ones the soft yeses joined.
                if sizes and sizes["n"] >= 2 and len(joined_sizes) >= 3:
                    lo, hi = joined_sizes[0], joined_sizes[-1]
                    gap = "larger" if sizes["min"] > 3 * hi[0] else "smaller" if sizes["max"] < lo[0] / 3 else None
                    if gap:
                        e["score"] *= 0.8
                        fit["size_gap"] = {"way": gap, "text": f"Those rounds are far {gap} than the {name} rounds "
                                           f"{_names([s['name'] for s in softs])} joined ({_money(*lo)} to {_money(*hi)})"}
            else:
                e["score"] *= 1.1 if at_stage else 0.75 if long_record else 0.9
        amounts = sorted(d["amount"] for d in led_known if d["amount"] and d["currency"] in ("EUR", "USD"))
        return {"key": e["key"], "id": e["ids"][0] if e["ids"] else None, "ids": e["ids"], "name": e["name"], "kind": e["kind"],
                "ring": e["ring"], "score": round(e["score"], 3), "tier": tier, "evidence": ev, "ask": ask[0] if ask else None,
                "asks": ask, "pulse": pulse, "led_recent": led_recent, "record": e.get("record"), "doubt": unsure, "wrong_entity": bool(unsure),
                "confirmed": confirmed, "checked": looked, "reported": reported,
                "recent_leads": led_known[:4], "last_led": last_led, "fit": fit,
                # the other spellings Cala holds this firm under, each with why it is the same firm
                "also_named": [{"name": n, "why": w} for n, w in sorted(named.get(e["key"], {}).items())],
                # a range from one or two rounds says nothing about what it usually writes
                "typical_round": {"min": amounts[0], "max": amounts[-1], "n": len(amounts)} if len(amounts) >= 3 else None,
                "portfolio": e.get("portfolio", [])}

    first = sorted((finish(e) for e in leads.values()), key=lambda e: (TIER_ORDER[e["tier"]], -e["score"]))
    for n, e in enumerate(first, 1):
        e["rank"] = n
    second_out = sorted((finish(c) for c in second), key=lambda e: e["score"], reverse=True)
    # A co-lead whose name Cala may have tied to the wrong company is in doubt wherever it is named, not only on its own card.
    in_doubt = {graph.norm(e["name"]) for e in first if e.get("doubt") or e.get("tier") == "check"}
    for e in first + second_out:
        for d in e["evidence"]:
            d["co_doubt"] = [n for n in d.get("co_leads") or [] if graph.norm(n) in in_doubt]
    for e in first + second_out:
        e["why"] = _why(e, want_stage)

    soft_out = []
    for s in softs:
        counts = collections.Counter()
        for e in leads.values():
            n = sum(1 for link in e["rounds"].values() if s["key"] in link["with"])
            if n and not doubt(e):  # a name Cala may have tied to the wrong company is not a habit to report
                counts[e["name"]] = n
        soft_out.append({k: s.get(k) for k in ("key", "name", "ids", "kind", "found", "rounds_in_cala", "led", "followed",
                                                "lead_rate", "walked", "capped", "pulse", "description", "led_rounds", "led_corrected", "cap_companies",
                                                "entities", "knowledge", "duplicates", "doubt")}
                        | {"also_named": [{"name": n, "why": w} for n, w in sorted(named.get(s["key"], {}).items())],
                           "reports": (s.get("knowledge") or {}).get("added") or 0,
                           "usual_leads": [{"name": n, "deals": c} for n, c in counts.most_common(5)],
                           "followed_rounds": sorted(
                               ({**_round_brief(rd), "leads": list(dict.fromkeys(i["name"] for i in rd["investors"] if i["is_lead"])),
                                 "leads_on_page": [i["name"] for i in rd["investors"]
                                                   if i["is_lead"] and (i.get("check") or {}).get("status") == "lead"],
                                 "relation": "round" if s["key"] in joined[rid] else "cap_table",
                                 "via": rd.get("via", "graph"), "sources": _nearest(rd["sources"], rd["date"], 2)}
                                for rid, rd in rounds.items() if s["key"] in joined[rid] or s["key"] in backed[rid]),
                               key=lambda d: d["date"] or "", reverse=True)})

    for s in soft_out:
        s["verdict"], s["insight"] = _verdict(s)
        (s.get("pulse") or {}).pop("led_list", None)

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
    for s in soft_out:   # an investor with no followed rounds still has its own record and the rounds it led
        facts += ((s.get("pulse") or {}).get("rounds") or 0) + 3 * len(s.get("led_rounds") or [])
        for d in (s.get("led_rounds") or []) + (s.get("led_corrected") or []):
            urls.update(x["url"] for x in d.get("sources", []))
            if (d.get("check") or {}).get("url"):
                urls.add(d["check"]["url"])
    result = {
        "run_id": run_id(inputs), "created": time.time(),
        "input": {"soft_yeses": [{"name": s["name"], "ids": s["ids"]} for s in softs], "stage": want_stage,
                  "stage_name": graph.STAGE_NAMES.get(want_stage or "", None), "company": inputs.get("company"),
                  # no stage given: the one most of the walked rounds carry, used to weigh the list
                  "stage_usual": {"stage": usual, "stage_name": graph.STAGE_NAMES.get(usual, usual), "rounds": staged[usual],
                                  "of": sum(staged.values())} if usual else None},
        "headline": _headline(soft_out, first), "start": _start(soft_out, first),
        "soft_yeses": soft_out, "leads": first, "second_ring": second_out,
        "tiers": [{**t, "count": sum(1 for e in first if e["tier"] == t["id"])} for t in TIERS
                  if any(e["tier"] == t["id"] for e in first)],
        # facts Cala attaches to a round from pages older than the round: shown with a caution, or left out
        "set_aside": sum(bool(d.get("caution")) + bool(d.get("amount_set_aside")) for e in first + second_out for d in e["evidence"]),
        "rounds_walked": len(rounds), "duplicates_folded": folded["_all"],
        # spellings this walk counted as one firm: [{name, also: [{name, why}]}]
        "merged_firms": [{"name": next((x["name"] for x in first + second_out + soft_out if x["key"] == k), k),
                          "also": [{"name": n, "why": w} for n, w in sorted(v.items())]} for k, v in sorted(named.items()) if v],
        # the founder's own rounds, kept out of the walk, and leads left out because Cala already lists them in the company
        "own": {"company": mine, "rounds": own_rounds[:4], "already_in": sorted(left_out.values())} if mine.get("id") else None,
        # the pages Cala cites, re-read: how many "led" claims they confirm, correct or leave open
        "page_check": {"rounds": tally["rounds"], "pages": tally["pages"], "confirmed": tally["lead"], "corrected": tally["corrected"],
                       "added": tally["promoted"], "unstated": tally["unstated"] + tally["absent"],
                       "unread": tally["unread"] + tally["off"], "amounts": tally["amounts"], "stages": tally["stages"],
                       "late": pagecheck.pending(), "findings": [f for f in findings if f["kind"] != "confirmed"][:120],
                       "confirmed_rows": [f for f in findings if f["kind"] == "confirmed"][:400], "claims": claims},
        "ledger": ledger.as_dict() | {"facts": facts, "sources": len(urls), "seconds": round(time.time() - t0, 1),
                                      "llm_facts": 0},
        # every round opened on the walk with everyone Cala lists in it: who the soft-yes investors have sat next to
        "net": _net(rounds, joined, backed, softs),
        "notes": notes,
    }
    await tick()
    return result


async def check_company(cala: Cala, cid: str, name: str, limit: int = 8) -> dict:
    """The page check on its own, for one company: each of its rounds in Cala, who Cala says led, and what the
    pages Cala cites for that round say, word for word."""
    ledger = Ledger()

    async def read(fn, *args):
        try:
            return await fn(cala, *args, ledger=ledger)
        except BudgetExceeded:
            return await fn(cala, *args, ledger=ledger, cache_only=True)

    rows = await read(graph.company_rounds, cid) or []
    rows.sort(key=lambda r: r["reported"] or "", reverse=True)
    backers = None
    if not rows:   # Cala can hold a company's investors without any of its rounds: say so, there is no lead to check
        prof = await read(graph.company, cid)
        backers = len((prof or {}).get("investors") or [])
    rds = [rd for rd in await asyncio.gather(*(read(graph.funding_round, r["id"]) for r in rows[:limit])) if rd]
    for rd in rds:
        rd["issuer"] = rd["issuer"] or {"id": cid, "name": name}
    kept: list[dict] = []
    for rd in sorted(rds, key=lambda rd: rd["date"] or "", reverse=True):
        if not any(_same_deal(rd, k) for k in kept):   # one deal Cala holds as two round entities shows once
            kept.append(rd)
    checks = await pagecheck.check_rounds(kept, PAGE_SECONDS)
    tally, findings, claims, out = collections.Counter(), [], [], []
    said_by = {rd["id"]: [i["name"] for i in rd["investors"] if i["is_lead"]] for rd in kept}
    for rd in kept:
        _apply_check(rd, checks.get(rd["id"]), tally)
    _set_aside_stages(kept)   # two rounds of one company under one stage label: the later one keeps no label
    for rd in kept:
        said, c = said_by[rd["id"]], checks.get(rd["id"])
        _note_check(rd, c, findings, claims)
        out.append({**_round_brief(rd), "amount_set_aside": rd.get("amount_set_aside"), "cala_leads": said,
                    "investors": [{"name": i["name"], "cala_lead": i["name"] in said, "is_lead": i["is_lead"],
                                   "promoted": bool(i.get("promoted")), "check": i.get("check")}
                                  for i in rd["investors"] if i["name"] in said or i["is_lead"]],
                    "others": sum(1 for i in rd["investors"] if i["name"] not in said and not i["is_lead"]),
                    "pages": [{"url": p["url"], "publisher": p.get("publisher"), "status": p["status"]}
                              for p in (c or {}).get("pages", [])]})
    return {"company": {"id": cid, "name": name}, "rounds": out, "rounds_in_cala": len(rows), "investors_in_cala": backers,
            "page_check": {"rounds": tally["rounds"], "pages": tally["pages"], "confirmed": tally["lead"],
                           "corrected": tally["corrected"], "added": tally["promoted"],
                           "unstated": tally["unstated"] + tally["absent"], "unread": tally["unread"] + tally["off"],
                           "amounts": tally["amounts"], "stages": tally["stages"],
                           "findings": [f for f in findings if f["kind"] != "confirmed"],
                           "confirmed_rows": [f for f in findings if f["kind"] == "confirmed"], "claims": claims},
            "ledger": ledger.as_dict(), "created": time.time()}
