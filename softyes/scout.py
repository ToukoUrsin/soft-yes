"""Find investors from what the founder builds, not only from who already said yes.

The founder gives a field, a stage and a place, and if they like the companies theirs resembles and the investors they
already know. Cala names the companies in that field. From each of them the graph is read: the rounds it raised, who
took part, who led, when and for how much. Every "led" is checked against the page Cala cites. An investor's signals
are counts over those facts, each one with its sources: how many of those companies it backed, how often it leads, at
which stage, how lately, at what size, where it sits, and whether one of the founder's own investors has sat in a round
with it. No language model states anything here.
"""
from __future__ import annotations

import asyncio
import collections
import hashlib
import json
import re
import time
from typing import Awaitable, Callable

from . import graph, pagecheck, walk
from .cala import BudgetExceeded, Cala, CalaError, Ledger

MAX_COMPANIES = 14        # companies like the founder's that are read
LOOKUPS = 8               # names Cala gave without an id that are looked up
ROUNDS_PER_COMPANY = 3    # of each, the rounds nearest the asked stage
OWN_RECORDS = 16          # investors whose own record in Cala is read
INVESTOR_LOOKUPS = 8      # investors Cala named without an id that are looked up by name
SHOWN = 18
MINE = 8                  # the founder's own investors whose rounds are read for a way in
RECENT_MONTHS = 18
PATH_ROUNDS = 4     # rounds near the asked stage, per investor the founder knows, read for who led them
PATH_TOTAL = 16
NAMED_RECORDS = 6   # of the own records, the ones kept for investors Cala only names
WAY_RECORDS = 8     # own records read for investors found only through those rounds
NOT_EQUITY = re.compile(r"grant|debt|loan|crowdfund|ico|token|post-ipo|secondary", re.I)

Emit = Callable[[dict], Awaitable[None]]

# A place as people say it, and how an address in Cala ends.
COUNTRIES = {
    "FI": "Finland", "SE": "Sweden", "NO": "Norway", "DK": "Denmark", "IS": "Iceland", "EE": "Estonia", "LV": "Latvia",
    "LT": "Lithuania", "DE": "Germany", "AT": "Austria", "CH": "Switzerland", "FR": "France", "ES": "Spain", "PT": "Portugal",
    "IT": "Italy", "NL": "Netherlands", "BE": "Belgium", "LU": "Luxembourg", "IE": "Ireland", "GB": "United Kingdom",
    "PL": "Poland", "CZ": "Czech Republic", "SK": "Slovakia", "HU": "Hungary", "RO": "Romania", "BG": "Bulgaria",
    "GR": "Greece", "HR": "Croatia", "SI": "Slovenia", "UA": "Ukraine", "TR": "Turkey", "IL": "Israel", "US": "United States",
    "CA": "Canada", "IN": "India", "SG": "Singapore", "JP": "Japan", "CN": "China", "KR": "South Korea", "AU": "Australia",
    "BR": "Brazil", "MX": "Mexico", "AE": "United Arab Emirates", "ZA": "South Africa", "NG": "Nigeria", "KE": "Kenya",
}
ALSO_CALLED = {"uk": "GB", "britain": "GB", "great britain": "GB", "england": "GB", "scotland": "GB", "usa": "US", "u.s.": "US",
               "u.s.a.": "US", "united states of america": "US", "america": "US", "czechia": "CZ", "the netherlands": "NL",
               "holland": "NL", "uae": "AE", "korea": "KR", "türkiye": "TR", "deutschland": "DE", "suomi": "FI",
               "españa": "ES", "sverige": "SE", "norge": "NO", "danmark": "DK"}
NORDICS = {"FI", "SE", "NO", "DK", "IS"}
EUROPE = {"FI", "SE", "NO", "DK", "IS", "EE", "LV", "LT", "DE", "AT", "CH", "FR", "ES", "PT", "IT", "NL", "BE", "LU", "IE", "GB",
          "PL", "CZ", "SK", "HU", "RO", "BG", "GR", "HR", "SI", "UA"}
REGIONS = {"nordics": NORDICS, "nordic": NORDICS, "the nordics": NORDICS, "scandinavia": {"SE", "NO", "DK"},
           "baltics": {"EE", "LV", "LT"}, "the baltics": {"EE", "LV", "LT"}, "dach": {"DE", "AT", "CH"},
           "europe": EUROPE, "eu": EUROPE - {"GB", "CH", "NO", "IS", "UA"}, "benelux": {"NL", "BE", "LU"},
           "iberia": {"ES", "PT"}, "southern europe": {"ES", "PT", "IT", "GR"}, "north america": {"US", "CA"}}
US_STATES = set("""alabama alaska arizona arkansas california colorado connecticut delaware florida georgia hawaii idaho
illinois indiana iowa kansas kentucky louisiana maine maryland massachusetts michigan minnesota mississippi missouri montana
nebraska nevada ohio oklahoma oregon pennsylvania tennessee texas utah vermont virginia washington wisconsin wyoming""".split()) | {
    "new york", "new jersey", "new mexico", "new hampshire", "north carolina", "south carolina", "north dakota", "south dakota",
    "rhode island", "west virginia", "district of columbia"}
STATE_CODES = set("AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA "
                  "RI SC SD TN TX UT VT VA WA WV WI WY DC".split())
BY_NAME = {v.lower(): k for k, v in COUNTRIES.items()} | ALSO_CALLED


def run_id(inputs: dict) -> str:
    key = {"sector": (inputs.get("sector") or "").lower().strip(), "stage": inputs.get("stage"),
           "place": (inputs.get("place") or "").lower().strip(),
           "like": sorted(graph.norm(n) for n in inputs.get("like") or []),
           "mine": sorted(sorted(m["ids"]) for m in inputs.get("mine") or []), "v": 11}
    return "f" + hashlib.sha256(json.dumps(key, sort_keys=True).encode()).hexdigest()[:9]


def _words(s: str | None, n: int = 60) -> str:
    """Words for Cala's query: letters, digits and spaces. Its query language reads dots, equals signs and brackets."""
    return re.sub(r"\s+", " ", re.sub(r"[^\w &+/'-]", " ", s or "")).strip()[:n]


def queries(sector: str, stage: str | None, place: str | None) -> list[tuple[str, str]]:
    """The same field asked four ways, each a line of Cala's query language: (what the rows are, the question)."""
    sec, st, pl = _words(sector), graph.STAGE_NAMES.get(stage or "", None), _words(place, 40) if place else None
    co = ["companies", f"industry={sec}"] + ([f"funding_stage={st}"] if st else [])
    out = [("company", ".".join(co + ([f"location={pl}"] if pl else []) + ["limit=40", "return(name, investors)"]))]
    if pl:
        out.append(("company", ".".join(co + ["limit=40", "return(name, investors)"])))
    out.append(("company", ".".join(["funding_rounds"] + ([f"round_label={st}"] if st else []) + [f"company.industry={sec}"]
                                    + ([f"company.location={pl}"] if pl else []) + ["limit=40", "return(company, announcement_date, lead_investors)"])))
    out.append(("investor", ".".join(["investors"] + ([f"investments.round_label={st}"] if st else []) + [f"investments.company.industry={sec}"]
                                     + ([f"investments.company.location={pl}"] if pl else []) + ["limit=40", "return(name)"])))
    return out


def where(address: str | None) -> dict | None:
    """'Itämerenkatu 25, 00180 HELSINKI, FI-00180, FI' and 'Helsinki, Finland' both end in the country."""
    parts = [p.strip() for p in re.split(r"[,\n]", address or "") if p.strip()]
    if not parts:
        return None
    code = city = None
    m = re.search(r"\b([A-Z]{2})-\d{3,6}\b", address)   # 'FI-00180'
    if m and m.group(1) in COUNTRIES:
        code = m.group(1)
    for n, p in enumerate(reversed(parts)):
        q = re.sub(r"\b(?:[A-Z]{1,2}-)?\d{4,6}\b", "", p).strip()   # without the postal code
        low = q.lower()
        if q in STATE_CODES and q != p:   # 'CA 94104': a state with its postal code
            code = code or "US"
        elif n == 0 and len(q) == 2 and q.upper() in COUNTRIES:
            code = q.upper()
        elif low in BY_NAME:
            code = code or BY_NAME[low]
        elif low in US_STATES or (q in STATE_CODES and len(parts) > 1):
            code = code or "US"
        elif not q or re.fullmatch(r"[A-Z]{2}(-[A-Z0-9]{1,3})?", q) or re.search(r"\d", q) or STREET.search(q) \
                or re.fullmatch(r"(?:[A-Za-z]{1,2}\.\s?){1,3}[A-Za-z]{0,2}", q):   # 'a.s.', 's.r.o.': a legal form after a comma
            continue   # a region code ('ES-M'), or a street
        else:
            city = q.title() if q.isupper() else q
            break
    country = COUNTRIES.get(code or "")
    if not country and not city:
        return None
    return {"code": code, "country": country, "city": city, "text": ", ".join(x for x in (city, country) if x)}


def in_place(asked: str | None, spot: dict | None) -> bool | None:
    """Is an address in the place the founder asked for? None when either is unknown."""
    if not asked or not spot:
        return None
    a = asked.lower().strip()
    if a in REGIONS:
        return spot["code"] in REGIONS[a] if spot.get("code") else None
    code = BY_NAME.get(a) or (a.upper() if a.upper() in COUNTRIES and len(a) == 2 else None)
    if code:
        return spot["code"] == code if spot.get("code") else None
    return a in (spot.get("city") or "").lower() or None


STREET = re.compile(r"\b(rue|street|avenue|ave|road|boulevard|blvd|strasse|straße|katu|gatan|vägen|plaza|calle|allee|platz|laan|"
                    r"straat|quai|chemin|floor|suite|building|house|centre|center|park|campus|court|tower|lane|mews|square|wharf|yard|c/o)\b", re.I)
LEGAL_FIRST = re.compile(r"^(UAB|OÜ|SIA|AS|AB|Oy|SAS|SA|GmbH)\s+(?=\S)")


def _name(name: str) -> str:
    """'UAB Contrarian Ventures' is Contrarian Ventures: a legal form in front of a name is not part of it."""
    return LEGAL_FIRST.sub("", (name or "").strip()) or (name or "").strip()


def _key(name: str) -> str:
    """One investor under two spellings is one investor: 'Nvidia' and 'Nvidia Corporation'."""
    k = graph.norm(_name(name))
    return k[:-11] if k.endswith("corporation") and len(k) > 14 else k


AGGREGATORS = re.compile(r"(^|\.)(tracxn|crunchbase|pitchbook|dealroom|cbinsights|vcbacked|linkedin|startup-map|premieralts|"
                         r"parsers|signal\.nfx|wellfound|golden|owler|zoominfo|f6s|eu-startups\.com/directory)\.", re.I)


def _first_report(srcs: list[dict]) -> str | None:
    """The day a round was first reported: the earliest dated page that is neither a database's listing nor a fund's
    portfolio page (those carry the day Cala read them, not the day of the deal)."""
    dated = [s["date"][:10] for s in srcs if s.get("date") and s.get("rank") != "AGGREGATOR"
             and not AGGREGATORS.search(re.sub(r"^https?://", "", s["url"]).split("/")[0] + ".") and not graph.PORTFOLIO_URL.search(s["url"])]
    return min(dated) if dated else None


def _stage_of(label: str | None) -> str | None:
    code = walk._stage_id(label)
    return code if code in graph.STAGE_ORDER else None


def _money_span(deals: list[dict]) -> str | None:
    sized = [d for d in deals if d.get("amount")]
    if not sized:
        return None
    lo, hi = min(sized, key=lambda d: d["amount"]), max(sized, key=lambda d: d["amount"])
    a, b = walk._money(lo["amount"], lo["currency"]), walk._money(hi["amount"], hi["currency"])
    return a if a == b else f"{a} to {b}"


def _st(stage_name: str | None) -> str:
    """A round's name inside a sentence: 'seed', 'pre-seed', 'Series A'."""
    name = stage_name or "round"
    return name if name.startswith("Series") else name.lower()


def _list(names: list[str], n: int = 3) -> str:
    names = list(dict.fromkeys(names))
    shown, more = names[:n], len(names) - n
    text = shown[0] if len(shown) == 1 else ", ".join(shown[:-1]) + (" and " if more <= 0 else ", ") + shown[-1]
    return text + (f" and {more} more" if more > 0 else "")


async def _ask(cala: Cala, q: str, ledger: Ledger) -> dict | None:
    try:
        return await cala.call("POST", "/knowledge/query", body={"input": q}, ledger=ledger)
    except BudgetExceeded:
        return await cala.call("POST", "/knowledge/query", body={"input": q}, ledger=ledger, cache_only=True)
    except CalaError:
        return None


async def field(cala: Cala, sector: str, stage: str | None, place: str | None, ledger: Ledger) -> dict:
    """The companies and the investors Cala names for a field, a stage and a place. Only names and ids are kept: what
    each company raised and from whom, and what each investor did, is read from the graph afterwards, where every fact
    has its sources. A name given under the narrowest question comes first."""
    qs = queries(sector, stage, place)
    answers = list(await asyncio.gather(*(_ask(cala, q, ledger) for _, q in qs)))
    rows_of = lambda d: [r for r in (d or {}).get("results") or [] if isinstance(r, dict) and not r.get("error")]
    # Cala answers some lines with "too complex to answer fully": the same line is then asked once more, for less per row
    for n, ((what, q), d) in enumerate(zip(qs, answers)):
        if q.startswith("companies.") and len(rows_of(d)) < 3:
            q2 = q.replace("limit=40.return(name, investors)", "limit=30.return(name, funding_stage, location)")
            d2 = await _ask(cala, q2, ledger)
            if len(rows_of(d2)) > len(rows_of(d)):
                qs[n], answers[n] = (what, q2), d2
    cos: dict[str, dict] = {}
    invs: dict[str, dict] = {}
    for rank, ((what, _), d) in enumerate(zip(qs, answers)):
        rows = rows_of(d)
        linked = {}
        for e in (d or {}).get("entities") or []:
            if e.get("entity_type") in ("Company", "Organization"):
                for m in [e.get("name") or ""] + list(e.get("mentions") or []):
                    linked.setdefault(graph.norm(m), e)
        row_names = [str(r.get("name") or r.get("company") or "").strip() for r in rows]
        row_keys = {graph.norm(n) for n in row_names}
        for n in row_names:
            key = graph.norm(n)
            if len(n) < 2 or not key or walk._no_name(n):
                continue
            e = linked.get(key)
            item = (cos if what == "company" else invs).setdefault(key, {"name": n, "id": None, "from": "cala", "asked": rank})
            item["id"] = item["id"] or (e["id"] if e else None)
        if what == "company":   # the other firms its answer links are the investors it names in those companies
            for key, e in linked.items():
                if key not in row_keys and key not in cos:
                    invs.setdefault(key, {"name": graph.pretty(e["name"]), "id": e["id"], "from": "cala", "asked": rank})
    for key in set(cos) & set(invs):
        invs.pop(key)
    return {"companies": list(cos.values()), "investors": list(invs.values()),
            "queries": [q for (_, q), d in zip(qs, answers) if rows_of(d)]}


async def _find_company(cala: Cala, name: str, ledger: Ledger, exact: bool = False) -> dict | None:
    try:
        hits = await graph.search(cala, name, ledger=ledger, limit=6)
    except BudgetExceeded:
        hits = await graph.search(cala, name, ledger=ledger, limit=6, cache_only=True)
    except CalaError:
        return None
    want = graph.norm(name)
    firms = [h for h in hits if h["type"] in ("Company", "Organization")]
    same = [h for h in firms if graph.norm(h["name"]) == want or graph.norm(h["raw_name"]) == want]
    near = [] if exact else [h for h in firms if graph.norm(h["name"]).startswith(want) or want.startswith(graph.norm(h["name"]))]
    pick = (same or near or [None])[0]
    return {"id": pick["id"], "name": pick["name"]} if pick else None


async def scout(cala: Cala, inputs: dict, emit: Emit | None = None) -> dict:
    """inputs: sector, stage (code), place, like [names], mine [{name, ids}] (the investors the founder already has)."""
    t0 = time.time()
    ledger = Ledger()
    want = inputs.get("stage") if inputs.get("stage") in graph.STAGE_ORDER else None
    sector, place = (inputs.get("sector") or "").strip(), (inputs.get("place") or "").strip() or None
    mine = (inputs.get("mine") or [])[:MINE]
    via_company = inputs.get("via_company") or None   # the company whose investors those are, when they are not the founder's own
    mine_ids = {i for m in mine for i in m["ids"]}
    mine_keys = {_key(m["name"]) for m in mine}

    async def say(**event) -> None:
        if emit:
            await emit({**event, "cala_calls": ledger.calls})

    async def read(fn, *args):
        try:
            return await fn(cala, *args, ledger=ledger)
        except BudgetExceeded:
            return await fn(cala, *args, ledger=ledger, cache_only=True)
        except CalaError:
            return None

    # 0. the investors the founder knows: their records, and the rounds near this stage they sat in without leading.
    #    Whoever led one of those has invested next to them: that is a way in. Read while Cala answers the field questions.
    async def known() -> tuple[dict[str, set], list[tuple[list[str], dict]]]:
        rounds_of: dict[str, set] = {}
        if not mine:
            return rounds_of, []
        pairs = [(m, i) for m in mine for i in m["ids"][:2]]
        theirs = await asyncio.gather(*(read(graph.investor, i) for _, i in pairs))

        def far(r: dict) -> int:
            st = _stage_of(r.get("label"))
            if not st:
                return 9
            return abs(graph.STAGE_ORDER.index(st) - graph.STAGE_ORDER.index(want)) if want else 0
        near: dict[str, list[str]] = {}
        for (m, _), inv in zip(pairs, theirs):
            if not inv:
                continue
            rounds_of.setdefault(m["name"], set()).update(r["id"] for r in inv["rounds"])
            rows = [r for r in inv["rounds"] if not r["is_lead"] and not NOT_EQUITY.search(r.get("label") or "") and far(r) <= 1]
            rows.sort(key=lambda r: _first_report(r["sources"]) or "", reverse=True)
            rows.sort(key=far)
            for r in rows[:PATH_ROUNDS]:
                if m["name"] not in near.setdefault(r["id"], []):
                    near[r["id"]].append(m["name"])
        ids = list(near)[:PATH_TOTAL]
        rds = await asyncio.gather(*(read(graph.funding_round, rid) for rid in ids))
        return rounds_of, [(near[rid], rd) for rid, rd in zip(ids, rds) if rd and (rd.get("issuer") or {}).get("name")]

    known_task = asyncio.create_task(known())

    # 1. the companies like the founder's: the ones they named, then the ones Cala names for the field
    named = [{"name": n, "id": None, "from": "you"} for n in dict.fromkeys(str(x).strip() for x in inputs.get("like") or []) if len(n) > 1]
    await say(t="step", step="field", sector=sector, place=place, stage=want)
    fld = {"companies": [], "investors": [], "queries": []}
    if sector:
        fld = await field(cala, sector, want, place, ledger)
    asked = fld["companies"]
    listed = named + [a for a in asked if graph.norm(a["name"]) not in {graph.norm(n["name"]) for n in named}]
    await say(t="step", step="companies", names=[x["name"] for x in listed][:MAX_COMPANIES], found=len(listed))

    # ids: the ones Cala's answer carried cost nothing; the rest are looked up by name
    # A name Cala gave without an id is looked up only as far as needed, and kept only when Cala holds it under exactly that name.
    linked = [x for x in listed if x["from"] == "cala" and x["id"]]
    loose = [x for x in listed if x["from"] == "cala" and not x["id"]][:max(0, min(LOOKUPS, MAX_COMPANIES - len(named) - len(linked)))]
    pool = [x for x in listed if x["from"] == "you"] + linked + loose
    hits = await asyncio.gather(*(asyncio.sleep(0, {"id": x["id"], "name": x["name"]}) if x["id"]
                                  else _find_company(cala, x["name"], ledger, exact=x["from"] == "cala") for x in pool))
    refs, seen_ids = [], set()
    for x, h in zip(pool, hits):
        if h and h["id"] not in seen_ids:
            seen_ids.add(h["id"])
            refs.append({**x, "id": h["id"]})
    profiles = await asyncio.gather(*(read(graph.company, x["id"]) for x in refs))
    companies = []
    for x, p in zip(refs, profiles):
        if p and (p["rounds"] or p["investors"]) and len(companies) < MAX_COMPANIES:
            p["asked_name"] = x["name"]
            p["name"] = p["name"] or x["name"]
            p["from"] = x["from"]
            companies.append(p)

    # 2. their rounds, the ones nearest the asked stage first
    def nearest(c: dict) -> list[dict]:
        rows = [r for r in c["rounds"] if not NOT_EQUITY.search(r.get("label") or "")]

        def far(r: dict) -> int:
            st = _stage_of(r.get("label"))
            if not want:
                return 0 if st else 1
            return abs(graph.STAGE_ORDER.index(st) - graph.STAGE_ORDER.index(want)) if st else 3
        return sorted(rows, key=far)[:ROUNDS_PER_COMPANY]

    picks = [(c, r) for c in companies for r in nearest(c)]
    rds = await asyncio.gather(*(read(graph.funding_round, r["id"]) for _, r in picks))
    for c in companies:
        c["_rounds"] = []
    for (c, _), rd in zip(picks, rds):
        if not rd:
            continue
        rd["issuer"] = rd["issuer"] if rd.get("issuer") and rd["issuer"].get("id") else {"id": c["id"], "name": c["name"]}
        if not any(walk._same_deal(rd, k) for k in c["_rounds"]):   # one deal Cala holds as two round entities counts once
            c["_rounds"].append(rd)
    all_rounds = [rd for c in companies for rd in c["_rounds"]]
    rounds_of, ways = await known_task
    by_id = {rd["id"]: rd for rd in all_rounds}
    ways = [(names, by_id.get(rd["id"], rd)) for names, rd in ways]   # a round read both ways is one round
    way_rounds = [rd for _, rd in ways if rd["id"] not in by_id]
    await say(t="step", step="rounds", rounds=len(all_rounds) + len(way_rounds), companies=len(companies))

    # 3. the page Cala cites for each "led"
    checks = await pagecheck.check_rounds(all_rounds + way_rounds, walk.PAGE_SECONDS)
    tally, findings, claims = collections.Counter(), [], []
    for rd in all_rounds + way_rounds:
        walk._apply_check(rd, checks.get(rd["id"]), tally)
    for c in companies:
        walk._set_aside_stages(c["_rounds"])
    for rd in all_rounds + way_rounds:
        walk._note_check(rd, checks.get(rd["id"]), findings, claims)
    await say(t="step", step="pages", pages=tally["pages"], confirmed=tally["lead"], corrected=tally["corrected"])

    # 4. everyone in those rounds, and the investors Cala names for the field
    cands: dict[str, dict] = {}

    def cand(name: str, uid: str | None, kind: str) -> dict | None:
        key = _key(name)
        if not key or key in graph.NOT_INVESTORS or walk._no_name(name) or key in mine_keys or (uid and uid in mine_ids):
            return None
        c = cands.setdefault(key, {"key": key, "name": _name(name), "kind": kind, "ids": collections.Counter(), "deals": [], "backed": [],
                                   "named": False})
        if uid:
            c["ids"][uid] += 1
        return c

    co_keys = {graph.norm(c["name"]) for c in companies} | {graph.norm(c["asked_name"]) for c in companies}
    for co in companies:
        in_round = set()
        for rd in co["_rounds"]:
            for i in rd["investors"]:
                c = cand(i["name"], i["id"], i["kind"])
                if c is None:
                    continue
                in_round.add(c["key"])
                ck = i.get("check") or {}
                c["deals"].append({
                    "company": co["name"], "company_id": co["id"], "round": rd["id"], "stage": rd["stage"], "stage_name": rd["stage_name"],
                    "date": rd["date"], "amount": rd["amount"], "currency": rd["currency"], "led": bool(i["is_lead"]),
                    "status": ck.get("status"), "quote": ck.get("quote"), "url": ck.get("url"), "publisher": ck.get("publisher"),
                    "led_by": ck.get("led_by"),
                    "sources": [{k: s.get(k) for k in ("publisher", "url", "date")} for s in (i["sources"] or rd["sources"])[:2]]})
        for inv in co["investors"]:
            c = cand(inv["name"], inv["id"], inv["kind"])
            if c is not None and c["key"] not in in_round:
                c["backed"].append({"company": co["name"], "company_id": co["id"],
                                    "sources": [{k: s.get(k) for k in ("publisher", "url", "date")} for s in inv["sources"][:2]]})

    # whoever led or sat in a round one of the founder's known investors sat in: the funds they have invested next to.
    # A "led" the cited page gives to someone else counts as taking part.
    via_key = graph.norm(via_company or "")
    for names, rd in ways:
        issuer = rd["issuer"]["name"]
        if via_key and graph.norm(issuer) == via_key:
            continue
        for i in rd["investors"]:
            ck = i.get("check") or {}
            led_it = bool(i["is_lead"]) and ck.get("status") != "other"
            if not led_it and i["kind"] == "person":
                continue
            c = cand(i["name"], i["id"], i["kind"])
            if c is None:
                continue
            c.setdefault("ways", []).append({
                "company": issuer, "company_id": rd["issuer"].get("id"), "round": rd["id"], "stage": rd["stage"], "stage_name": rd["stage_name"],
                "date": rd["date"], "amount": rd["amount"], "currency": rd["currency"], "led": led_it, "with": names,
                "status": ck.get("status"), "quote": ck.get("quote"), "url": ck.get("url"), "publisher": ck.get("publisher"),
                "led_by": ck.get("led_by"),
                "sources": [{k: s.get(k) for k in ("publisher", "url", "date")} for s in (i["sources"] or rd["sources"])[:2]]})

    def weight(d: dict) -> float:
        w = walk._stage_weight(d["stage"], want) * walk._recency(d["date"])
        return w * (1.8 * walk.CHECK_WEIGHT.get(d["status"] or "unread", 0.7) if d["led"] else 1.0)

    for c in cands.values():
        c["ways"] = sorted(sorted(c.get("ways") or [], key=lambda d: d["date"] or "", reverse=True), key=lambda d: not d["led"])
        c["base"] = sum(weight(d) for d in c["deals"]) + 0.35 * len(c["backed"]) + sum((0.6 if d["led"] else 0.4) * weight(d) for d in c["ways"][:3])
    # The investors Cala's answers name. Nothing is claimed for them yet: each one's own record is read below.
    told = sorted((x for x in fld["investors"] if graph.norm(x["name"]) not in co_keys), key=lambda x: (x["id"] is None, x["asked"]))
    for x in told:
        key = _key(x["name"])
        if key in cands:
            cands[key]["named"] = True
            if x["id"]:
                cands[key]["ids"][x["id"]] += 0
    fresh = [x for x in told if _key(x["name"]) not in cands]
    with_id = [x for x in fresh if x["id"]]
    looked = [x for x in fresh if not x["id"]][:INVESTOR_LOOKUPS]
    found = await asyncio.gather(*(_find_company(cala, x["name"], ledger, exact=True) for x in looked))
    for x, h in list(zip(with_id, with_id)) + list(zip(looked, found)):
        if not h or not h.get("id"):
            continue
        c = cand(x["name"], h["id"], "fund")
        if c is not None:
            c["named"] = True
            c.setdefault("base", 0.0)
            c.setdefault("ways", [])

    # 5. each front-runner's own record in Cala, and where it sits
    by_deals = sorted((c for c in cands.values() if c["ids"] and (c["deals"] or c["backed"])), key=lambda c: (-c["base"], c["name"]))
    by_name = [c for c in cands.values() if c["ids"] and not c["deals"] and not c["backed"] and not c["ways"]]
    by_way = sorted((c for c in cands.values() if c["ids"] and c["ways"] and not c["deals"] and not c["backed"]), key=lambda c: (-c["base"], c["name"]))
    front = by_deals[:OWN_RECORDS - min(len(by_name), NAMED_RECORDS)]
    front += by_name[:OWN_RECORDS - len(front)]
    front += by_way[:WAY_RECORDS]
    await say(t="step", step="investors", investors=len(cands), reading=[c["name"] for c in front])
    owns = await asyncio.gather(*(read(graph.investor, c["ids"].most_common(1)[0][0]) for c in front))
    profs = await asyncio.gather(*(read(graph.profile, c["ids"].most_common(1)[0][0]) for c in front))
    # the companies of this field by name: the ones read, and the ones Cala named without a record to read
    field_names = {graph.norm(x["name"]): x["name"] for x in asked} | {graph.norm(c["name"]): c["name"] for c in companies}
    year_ago = time.strftime("%Y-%m-%d", time.gmtime(time.time() - 365 * 86400))
    for c, own, prof in zip(front, owns, profs):
        if own:
            rows = own["rounds"]
            at = [r for r in rows if want and _stage_of(r["label"]) == want]
            by_stage = collections.Counter(_stage_of(r["label"]) for r in rows if _stage_of(r["label"]))
            read_cos = {d["company_id"] for d in c["deals"]} | {b["company_id"] for b in c["backed"]}
            also = [{"company": field_names[graph.norm(x["name"])], "sources": [{k: s.get(k) for k in ("publisher", "url", "date")} for s in x["sources"]]}
                    for x in own["portfolio"] if graph.norm(x["name"]) in field_names and x["id"] not in read_cos]
            seen_also = {graph.norm(d["company"]) for d in c["deals"]} | {graph.norm(b["company"]) for b in c["backed"]}
            also = [x for x in also if graph.norm(x["company"]) not in seen_also]
            c["own"] = {"rounds": len(rows), "led": sum(r["is_lead"] for r in rows), "at_stage": len(at),
                        "led_at_stage": sum(r["is_lead"] for r in at), "capped": own["capped"], "portfolio": len(own["portfolio"]),
                        "most": by_stage.most_common(1)[0] if by_stage else None, "round_ids": [r["id"] for r in rows],
                        "recent": sum(1 for r in rows if (_first_report(r["sources"]) or "") >= year_ago), "also": also[:6]}
            if not c["deals"] and not c["backed"] and own["name"]:
                c["name"] = own["name"]
                c["kind"] = own["kind"]
        if prof:
            c["hq"] = where(prof.get("hq"))
            c["website"] = prof.get("website")
            c["description"] = graph.fix_text(prof.get("description"))

    # 6. a way in: a round it led with one of the founder's known investors in it, or a round they both sat in
    if mine:
        in_front = {c["key"] for c in front}
        for c in cands.values():
            if c["key"] not in in_front and not c["ways"]:
                continue
            mine_in = {}
            ids = set((c.get("own") or {}).get("round_ids") or []) | {d["round"] for d in c["deals"]} | {d["round"] for d in c["ways"]}
            for name, held in rounds_of.items():
                both = ids & held
                if both:
                    mine_in[name] = sorted(both)
            c["path"] = []
            for w in c["ways"]:
                for name in w["with"]:
                    if name not in [p["via"] for p in c["path"]]:
                        c["path"].append({"via": name, "rounds": max(1, len(mine_in.get(name) or [])), "company": w["company"],
                                          "stage_name": w["stage_name"], "date": w["date"], "led": w["led"], "status": w["status"]})
            # name one shared round per investor: the company and the year, read from the round itself
            first = [(name, rids[0]) for name, rids in sorted(mine_in.items(), key=lambda kv: -len(kv[1]))
                     if name not in [p["via"] for p in c["path"]]][:2]
            shared = await asyncio.gather(*(read(graph.funding_round, rid) for _, rid in first))
            c["path"] += [{"via": name, "rounds": len(mine_in[name]),
                           "company": ((rd or {}).get("issuer") or {}).get("name"), "stage_name": (rd or {}).get("stage_name"),
                           "date": (rd or {}).get("date"), "led": False} for (name, _), rd in zip(first, shared)]

    # 7. the signals, and the order they give
    stage_name = graph.STAGE_NAMES.get(want or "", None)
    n_cos = len(companies)
    co_place = {c["id"]: where(c.get("hq")) for c in companies}
    out = []
    for c in cands.values():
        deals = sorted(c["deals"], key=lambda d: d["date"] or "", reverse=True)
        led = [d for d in deals if d["led"]]
        own = c.get("own")
        also = (own or {}).get("also") or []
        names = list(dict.fromkeys([d["company"] for d in deals] + [b["company"] for b in c["backed"]]))
        n_field = len(names) + len(also)
        ways_led = c["ways"]
        if not n_field and not ways_led and not (own and (own["at_stage"] if want else own["rounds"])):
            continue   # Cala named it, but its record holds no company of this field and no round at this stage
        sig = []
        # the field
        if names:
            text = f"Backed {len(names)} of the {n_cos} companies like yours: {_list(names)}" if n_cos > 1 else f"Backed {names[0]}"
            if led:
                text += f". Led {len({d['company_id'] for d in led})}" if len(names) > 1 else ", and led the round"
            if also:
                text += f". Its portfolio in Cala also holds {_list([x['company'] for x in also])}"
        elif also:
            text = f"Its portfolio in Cala holds {_list([x['company'] for x in also])}"
        else:
            text = "None of the companies like yours is in its Cala record"
        sig.append({"id": "field", "label": "Your field", "on": n_field > 0, "text": text, "n": n_field})
        # leading
        if own and own["rounds"]:
            more = "at least " if own["capped"] else ""
            n = walk._plural(own["rounds"], "round")
            sig.append({"id": "leads", "label": "Leads rounds", "on": own["led"] >= 2,
                        "text": f"Led {own['led']} of its {more}{n} in Cala" if own["led"]
                        else f"Led none of its {more}{n} in Cala" + (": it follows" if own["rounds"] >= 4 else "")})
        elif led:
            sig.append({"id": "leads", "label": "Leads rounds", "on": True, "text": f"Led {walk._plural(len(led), 'round')} here"})
        # the stage
        if want:
            here = [d for d in deals if d["stage"] == want]
            if own and own["at_stage"]:
                sig.append({"id": "stage", "label": stage_name, "on": True,
                            "text": f"{walk._plural(own['at_stage'], stage_name + ' round')} in Cala"
                                    + (f", led {own['led_at_stage']}" if own["led_at_stage"] else "")})
            elif here:
                sig.append({"id": "stage", "label": stage_name, "on": True, "text": f"{walk._plural(len(here), stage_name + ' round')} here"})
            elif own:
                most = own.get("most")
                sig.append({"id": "stage", "label": stage_name, "on": False,
                            "text": f"No {stage_name} round in Cala" + (f"; mostly {graph.STAGE_NAMES.get(most[0], most[0])} ({most[1]})" if most else "")})
        # how lately
        dated = [d for d in deals if d["date"]]
        last = dated[0] if dated else None
        months = walk._months_ago(last["date"]) if last else None
        n_recent = (own or {}).get("recent") or 0
        if n_recent or last:
            bits = ([f"{walk._plural(n_recent, 'round')} reported in the last 12 months"] if n_recent else []) + \
                   ([f"{'latest here' if n_recent else 'Latest here'}: {last['company']}, {walk._month(last['date'])}"] if last else [])
            sig.append({"id": "recent", "label": "Active now", "on": n_recent > 0 or (months is not None and months <= RECENT_MONTHS),
                        "text": "; ".join(bits)})
        elif own:
            sig.append({"id": "recent", "label": "Active now", "on": False, "text": "No round reported in the last 12 months"})
        # the size
        span = _money_span([d for d in deals if not want or d["stage"] == want] or deals)
        if span:
            sig.append({"id": "size", "label": "Round size", "on": True, "text": f"Rounds here of {span}"})
        # the place
        hq = c.get("hq")
        near = in_place(place, hq)
        if hq:
            sig.append({"id": "place", "label": "Near you" if place else "Where", "on": bool(near) if place else True,
                        "text": f"Based in {hq['text']}"})
        elif place:
            cos_in = {d["company_id"] for d in deals if in_place(place, co_place.get(d["company_id"]))}
            if cos_in:
                near = True
                sig.append({"id": "place", "label": "Near you", "on": True,
                            "text": f"Backed {len(cos_in)} {'company' if len(cos_in) == 1 else 'companies'} in {place}"})
        # a way in
        if mine:
            path = c.get("path") or []
            if path:
                p = path[0]
                what = " ".join(x for x in (f"{p['company']}'s" if p.get("company") else "", _st(p.get("stage_name")),
                                            f"({p['date'][:4]})" if p.get("date") else "") if x)
                who = f"{p['via']}, an investor in {via_company}" if via_company else p["via"]
                if p.get("led"):
                    when_p = f" in {walk._month(p['date'])}" if p.get("date") else ""
                    said = "Led" if p.get("status") in walk.CONFIRMED else "Cala has it leading"
                    text = f"{said} {p['company']}'s {_st(p.get('stage_name'))}{when_p} with {who} in the round"
                    if p["rounds"] > 1:
                        text += f"; {p['rounds']} rounds together in Cala"
                else:
                    text = f"Sat in {walk._plural(p['rounds'], 'round')} with {who}: {what}"
                sig.append({"id": "path", "label": "A way in", "on": True, "text": text, "via": [x["via"] for x in path]})
            elif own:
                whom = f"{via_company}'s investors" if via_company else \
                    (_list([m["name"] for m in mine], 3) if len(mine) <= 3 else f"any of your {len(mine)} investors")
                sig.append({"id": "path", "label": "A way in", "on": False, "text": f"No round with {whom} in Cala"})
        score = c.get("base", 0.0) + 0.5 * len(also)
        if own:
            score += (0.3 * min(own["led_at_stage"], 5) + 0.08 * min(own["at_stage"], 10)) if want else 0.2 * min(own["led"], 5)
            score += 0.1 * min(own["recent"], 6)
        if near:
            score *= 1.15
        if c.get("path"):
            score *= 1.25
        proof = next((d for d in led + [w for w in ways_led if w["led"]] if d["status"] == "lead" and d.get("quote")), None)
        top = led[0] if led else (deals[0] if deals else None)
        if top:
            when = f" in {walk._month(top['date'])}" if top["date"] else ""
            held = top["status"] in ("lead", "report")   # a "led" the cited page does not bear out is Cala's word only
            line = (f"Led {top['company']}'s {_st(top['stage_name'])}{when}" if top["led"] and held
                    else f"Cala says it led {top['company']}'s {_st(top['stage_name'])}{when}; the page it cites does not say so" if top["led"]
                    else f"In {top['company']}'s {_st(top['stage_name'])}{when}")
            rest = n_field - 1
            if rest > 0:
                line += f", and backed {rest} more of these companies"
        elif ways_led:
            w = ways_led[0]
            when = f" in {walk._month(w['date'])}" if w["date"] else ""
            said = "In" if not w["led"] else "Led" if w["status"] in walk.CONFIRMED else "Cala has it leading"
            line = f"{said} {w['company']}'s {_st(w['stage_name'])}{when}, with {_list(w['with'], 2)} in the round"
        elif n_field:
            line = f"Cala lists it as an investor in {_list(names + [x['company'] for x in also])}"
        elif want and own["led_at_stage"]:
            line = f"Led {own['led_at_stage']} of its {walk._plural(own['at_stage'], stage_name + ' round')} in Cala"
        elif want:
            line = f"{walk._plural(own['at_stage'], stage_name + ' round')} in Cala"
        else:
            line = f"Led {own['led']} of its {walk._plural(own['rounds'], 'round')} in Cala"
        out.append({
            "key": c["key"], "name": c["name"], "kind": c["kind"], "score": round(score, 3), "line": line, "signals": sig,
            "on": sum(1 for s in sig if s["on"]), "led_here": len(led), "companies": n_field, "named_by_cala": c["named"],
            "proof": {k: proof.get(k) for k in ("company", "stage_name", "date", "quote", "url", "publisher")} if proof else None,
            "deals": [{k: d.get(k) for k in ("company", "stage_name", "date", "led", "status", "quote", "url", "publisher", "led_by", "sources")}
                      | {"money": walk._money(d["amount"], d["currency"]) if d["amount"] else None} for d in deals[:6]],
            "ways": [{k: d.get(k) for k in ("company", "stage_name", "date", "led", "status", "quote", "url", "publisher", "led_by", "sources", "with")}
                     | {"money": walk._money(d["amount"], d["currency"]) if d["amount"] else None} for d in ways_led[:4]],
            "backed": (c["backed"] + also)[:6], "hq": (hq or {}).get("text"), "website": c.get("website"), "description": c.get("description"),
            "own": {k: own[k] for k in ("rounds", "led", "at_stage", "led_at_stage", "capped", "portfolio", "recent")} if own else None,
            "path": c.get("path") or []})
    out.sort(key=lambda x: (-x["score"], -((x["own"] or {}).get("rounds") or 0), x["kind"] == "person", x["name"]))
    # the list shows the investors whose record or rounds were read; one only listed on a cap table is counted, not ranked
    read_ones = [x for x in out if x["own"] or x["deals"] or x["ways"]]
    shown = read_ones[:SHOWN] if len(read_ones) >= 5 else out[:SHOWN]
    for n, x in enumerate(shown, 1):
        x["rank"] = n

    def co_view(c: dict) -> dict:
        spot = where(c.get("hq"))
        return {"id": c["id"], "name": c["name"], "from": c["from"], "description": c.get("description"),
                "where": (spot or {}).get("text"), "stage": c.get("stage"), "founded": (c.get("founded") or "")[:4] or None,
                "industries": [i["name"] for i in c.get("industries") or []][:2], "investors_listed": len(c["investors"]),
                "rounds": [{"id": rd["id"], "stage": rd["stage"], "stage_name": rd["stage_name"], "date": rd["date"],
                            "money": walk._money(rd["amount"], rd["currency"]) if rd["amount"] else None,
                            "leads": [{"key": _key(i["name"]), "name": _name(i["name"]), "status": (i.get("check") or {}).get("status")}
                                      for i in rd["investors"] if i["is_lead"]],
                            "investors": [_key(i["name"]) for i in rd["investors"] if _key(i["name"]) in cands],
                            "sources": [{k: s.get(k) for k in ("publisher", "url", "date")} for s in rd["sources"][:2]]}
                           for rd in sorted(c["_rounds"], key=lambda rd: rd["date"] or "", reverse=True)]}

    facts = sum(2 + len(rd["investors"]) + len(rd["sources"]) for rd in all_rounds + way_rounds) + sum(4 + len(c["investors"]) for c in companies) \
        + sum((c.get("own") or {}).get("rounds", 0) for c in front)
    top = shown[0] if shown else None
    rounds_read = len(all_rounds) + len(way_rounds) + sum((c.get("own") or {}).get("rounds", 0) for c in front)
    if not companies:
        headline = (f"Cala named no company for {sector}." if sector else "Cala does not know these companies.") + \
            " Try other words for the field, or name two or three companies like yours."
    elif not out:
        headline = f"Cala holds {walk._plural(n_cos, 'company').replace('companys', 'companies')} like yours but no round with a named investor."
    else:
        line = top["line"] if top["line"].startswith("Cala") else top["line"][0].lower() + top["line"][1:]
        cos = "1 company like yours" if n_cos == 1 else f"{n_cos} companies like yours"
        if ways:
            cos += f" and the rounds {via_company + chr(39) + 's' if via_company else 'your'} investors sat in"
        headline = (f"{walk._plural(len(out), 'investor')} around {cos}, read from {walk._plural(rounds_read, 'round')} in Cala. "
                    f"Start with {top['name']}: {line}.")
    result = {
        "run_id": run_id(inputs), "created": time.time(), "seconds": round(time.time() - t0, 1),
        "ask": {"sector": sector or None, "stage": want, "stage_name": stage_name, "place": place,
                "like": [n["name"] for n in named], "mine": [m["name"] for m in mine], "via_company": via_company},
        "queries": fld["queries"], "headline": headline, "companies": [co_view(c) for c in companies],
        "investors": shown, "investors_total": len(out),
        "counts": {"companies": n_cos, "named_by_cala": len(asked), "rounds": len(all_rounds), "rounds_read": rounds_read,
                   "investors": len(out), "ways": sum(1 for x in out if x["path"]), "way_rounds": len(ways),
                   "leads": sum(1 for x in out if x["led_here"]), "own_records": sum(1 for c in front if c.get("own"))},
        "check": {"rounds": tally["rounds"], "pages": tally["pages"], "confirmed": tally["lead"], "corrected": tally["corrected"],
                  "unstated": tally["unstated"] + tally["absent"], "unread": tally["unread"] + tally["off"]},
        "fixes": [f for f in findings if f["kind"] == "lead"][:12],
        # the same record a walk keeps, so these pages count on the list of every checked claim
        "page_check": {"claims": claims, "findings": [f for f in findings if f["kind"] != "confirmed"],
                       "confirmed_rows": [f for f in findings if f["kind"] == "confirmed"]},
        "ledger": {**ledger.as_dict(), "facts": facts, "llm": 0},
    }
    await say(t="step", step="done")
    return result


def view(r: dict, url: str) -> dict:
    """What the card draws: the result without the record kept for the list of checked claims."""
    return {"view": "find", "url": f"{url}/audit", **{k: v for k, v in r.items() if k not in ("page_check", "created")}}


def in_words(place: str | None) -> str:
    """'in the Nordics', 'in Europe'."""
    if not place:
        return ""
    return f"in the {place}" if place.lower() in ("nordics", "baltics", "uk", "us", "usa", "netherlands") else f"in {place}"


def text(r: dict, url: str) -> str:
    """What the assistant reads: the same facts as the card, assembled in code."""
    a = r["ask"]
    what = " ".join(x for x in (a.get("stage_name"), a.get("sector") or "", in_words(a.get("place"))) if x).strip()
    out = [f"# Investors for {what or 'companies like ' + _list(a.get('like') or ['yours'])}", "", r["headline"], ""]
    if r["companies"]:
        out.append("Companies like yours that Cala holds: " + ", ".join(c["name"] for c in r["companies"]) + ".")
        out.append("")
    if a.get("via_company") and a.get("mine"):
        out.append(f"The way in is looked for through {a['via_company']}'s investors in Cala: {_list(a['mine'], 6)}.")
        out.append("")
    for x in r["investors"][:8]:
        out.append(f"{x['rank']}. **{x['name']}**: {x['line']}.")
        for s in x["signals"]:
            if s["id"] != "field" or x["companies"] > 1:
                out.append(f"   - {'yes' if s['on'] else 'no'} · {s['label']}: {s['text']}")
        if x.get("proof"):
            p = x["proof"]
            out.append(f"   - The page says: \"{p['quote']}\" ({p['url']})")
    more = [x for x in r["investors"][8:] if x.get("path")]
    if more:
        out += ["", "Further down the list, with a way in:"]
        for x in more[:6]:
            way = next(s["text"] for s in x["signals"] if s["id"] == "path")
            out.append(f"{x['rank']}. **{x['name']}**: {way}.")
    ck = r["check"]
    if a.get("mine"):
        out += ["", "This one answer covers both who fits and the way in. Do not call find_lead or explore_network for the same question: "
                    "the chat shows one drawing per answer."]
    out += ["", f"{ck['pages']} pages read: {ck['confirmed']} lead claims confirmed word for word, {ck['corrected']} corrected.",
            f"{r['ledger']['facts']} facts from Cala, none from a language model. The list is drawn in the chat with every source; "
            "do not repeat it. Say in two or three sentences who to start with and why, using only the lines above.",
            f"Every checked claim: {url}/audit"]
    return "\n".join(out)
