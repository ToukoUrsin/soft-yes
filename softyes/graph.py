"""Typed reads from the Cala graph: an investor's rounds, a round's participants.

Nothing here invents a value. Every fact keeps the sources Cala attached to it.
"""
from __future__ import annotations

import re
from datetime import date

from .cala import Cala, Ledger

# These bodies are sent to Cala verbatim; they are also the cache key, so do not reorder.
INVESTOR_BODY = {"properties": ["name"], "relationships": {"outgoing": {
    "PARTICIPATES_IN_FUNDING_ROUND": {"limit": 50}, "INVESTED_IN": {"limit": 50}}}}
ROUND_BODY = {
    "properties": ["announcement_date", "transaction_value", "transaction_value_units", "round_label"],
    "relationships": {"incoming": {"PARTICIPATES_IN_FUNDING_ROUND": {"limit": 50}}}}
PROFILE_BODY = {"properties": ["name", "description", "website", "headquarters_address"],
                "relationships": {"incoming": {"WORKS_AT": {"limit": 25}}}}
COMPANY_BODY = {
    "properties": ["name", "description", "website", "founding_date", "total_funding", "total_funding_units",
                   "funding_stage", "headquarters_address"],
    "relationships": {"incoming": {"INVESTED_IN": {"limit": 50}},
                      "outgoing": {"PARTICIPATES_IN_FUNDING_ROUND": {"limit": 20},
                                   "OPERATES_IN_INDUSTRY": {"limit": 10}}}}

COMPANY_ROUNDS_BODY = {"properties": ["name"], "relationships": {"outgoing": {
    "PARTICIPATES_IN_FUNDING_ROUND": {"limit": 10}}}}

PEOPLE_BODY = {"properties": ["name"], "relationships": {"incoming": {
    "FOUNDED": {"limit": 6}, "IS_CEO_OF": {"limit": 3}, "WORKS_AT": {"limit": 8}}}}

ROUND_CAP = 50  # Cala returns at most 50 relationships of one type per entity
NOT_INVESTORS = {"cofounder", "founder", "founders", "undisclosed", "angel", "angels", "angelinvestors", "investors",
                 "others", "management", "employees", "ceo", "existinginvestors", "businessangels", "undisclosedinvestors"}

LEGAL = {"oy", "oyj", "ab", "ltd", "limited", "llc", "llp", "lp", "inc", "gmbh", "as", "sa", "sas", "bv", "ky",
         "plc", "corp", "co", "ag", "aps", "oü", "spa", "srl", "sl", "kg", "scsp", "fcre", "sgeic", "ug", "sasu", "sarl"}
TAIL = {"advisors", "advisers", "management", "services"}
ACRONYMS = {"vc", "ai", "eit", "nato", "gtt", "mig", "eic", "iqm", "ab", "as", "llc", "lp", "llp", "usa", "uk",
            "eu", "bv", "ag", "sa", "ii", "iii", "iv", "vi", "vii", "viii", "ix", "xi", "xii"}
PORTFOLIO_URL = re.compile(r"/(portfolio|companies|investments|our-companies|startups)/?($|\?|#)", re.I)
STAGE_ORDER = ["PRE_SEED", "SEED", "SERIES_A", "SERIES_B", "SERIES_C", "SERIES_D", "SERIES_E", "SERIES_F"]
STAGE_NAMES = {"PRE_SEED": "Pre-seed", "SEED": "Seed", "SERIES_A": "Series A", "SERIES_B": "Series B",
               "SERIES_C": "Series C", "SERIES_D": "Series D", "SERIES_E": "Series E", "SERIES_F": "Series F"}


def norm(name: str) -> str:
    """Key used to merge spellings of one investor: 'Maki VC' == 'Maki.vc', 'K-Fund' == 'Kfund'."""
    words = re.findall(r"[a-z0-9åäöüéèñøæ]+", (name or "").lower())
    while len(words) > 1 and words[-1] in LEGAL:
        words.pop()
    return "".join(words)


FUND_WORDS = {"ventures", "venture", "capital", "partners", "vc", "fund", "funds", "investments", "investment", "invest",
              "investissement", "management", "growth", "equity", "fcr", "scr", "fcre", "en", "liquidacion", "opportunity",
              "opportunities", "seed", "early", "stage"}
GENERIC_BASE = {"nordic", "nordics", "global", "first", "general", "alpine", "atlantic", "pacific", "north", "south", "east",
                "west", "green", "black", "white", "digital", "alpha", "omega", "future", "european", "europe", "american",
                "baltic", "index", "summit", "pioneer", "founders", "founder", "united", "national", "royal", "impact",
                "international", "industrial", "innovation", "health", "climate", "energy", "smart", "world", "angel",
                "blue", "next", "open", "life", "core", "peak", "tech", "data", "deep", "high", "gold", "star", "moon"}
INVESTOR_WORDS = re.compile(r"\b(venture|ventures|capital|invest\w*|fund\w*|vc|private equity|accelerator|angel\w*|"
                            r"family office|asset manage\w*)\b", re.I)


def root(name: str) -> tuple[str, bool]:
    """The part of a name before the first fund word, and whether a fund word followed it."""
    words = re.findall(r"[a-z0-9åäöüéèñøæ]+", (name or "").lower())
    base = []
    for w in words:
        if w in FUND_WORDS or w in LEGAL or re.fullmatch(r"[ivx]+|\d+", w):
            break
        base.append(w)
    return "".join(base), len(base) < len(words)


def family(name: str) -> str | None:
    """'Seaya Ventures II, FCR' and 'Seaya Growth Tech' are vehicles of one firm: both give 'seaya'.

    Returns None when the name has no distinctive root, so nothing is merged on a common word.
    """
    base, fund = root(name)
    if len(base) < 4 or not fund or base in GENERIC_BASE:
        return None
    return base


def pretty(name: str) -> str:
    """'NORDICNINJA VC LIMITED' -> 'Nordicninja VC', 'VNV Global AB (publ)' -> 'VNV Global'. Mixed case is kept."""
    name = re.sub(r"\s*\((publ|uk|us|usa|eu|de|fr|se|fi)\)", "", (name or "").strip(), flags=re.I)
    name = re.sub(r"\s*\([^)]*\)\s*$", "", name) or name
    if not name:
        return name
    words = name.split()
    while len(words) > 1 and (re.sub(r"\W", "", words[-1]).lower() in LEGAL or not re.sub(r"\W", "", words[-1])):
        words.pop()
    # 'Lakestar Advisors', 'Ugly Duckling Ventures Management', 'HEADLINE SERVICES US': the firm, not its management company
    if len(words) > 2 and words[-1].lower() in ("us", "uk") and words[-2].lower() in TAIL:
        words.pop()
    while len(words) > 1 and words[-1].lower() in TAIL:
        words.pop()
    if name.isupper() and not (len(words) == 1 and len(words[0]) <= 4):
        words = [w.upper() if w.lower() in ACRONYMS or (len(w) <= 3 and len(words) > 1 and w.isalpha() and n == 0)
                 else w.capitalize() for n, w in enumerate(words)]
    return " ".join(words).rstrip(",")


def sources(raw) -> list[dict]:
    out, seen = [], set()
    for s in raw or []:
        doc = s.get("document")
        url = doc if isinstance(doc, str) else (doc or {}).get("endpoint") or (doc or {}).get("url")
        if not url or url in seen:
            continue
        seen.add(url)
        publisher = s.get("name") or ""
        if " | " in publisher or len(publisher) > 60:  # an article title, keep the host instead
            m = re.match(r"https?://(?:www\.)?([^/]+)", url)
            publisher = m.group(1) if m else publisher[:60]
        out.append({"publisher": publisher, "url": url, "date": s.get("date"), "rank": s.get("source_rank")})
    out.sort(key=lambda s: s.get("date") or "9999")
    return out


def reported_before(srcs: list[dict], when: str | None, days: int = 60) -> str | None:
    """If every dated page behind a fact is older than the round Cala attaches the fact to, the latest of those dates.

    A page cannot report a round months before it happened, so such a fact belongs to an earlier event that Cala
    folded into this round (a seed and its extension two years later held as one entity, for instance)."""
    dates = [s["date"][:10] for s in srcs if s.get("date")]
    if not when or not dates:
        return None
    try:
        day = date.fromisoformat(when[:10])
        if all((day - date.fromisoformat(d)).days > days for d in dates):
            return max(dates)
    except ValueError:
        pass
    return None


def first_report_date(srcs: list[dict]) -> str | None:
    """Earliest dated report of a deal. A fund's own portfolio page carries the crawl date, not the deal date."""
    dated = [s["date"] for s in srcs if s.get("date") and not PORTFOLIO_URL.search(s["url"])]
    return min(dated) if dated else None


def kind(entity_type: str | None) -> str:
    return "person" if entity_type == "Person" else "fund"


async def search(cala: Cala, name: str, ledger: Ledger | None = None, limit: int = 8, cache_only: bool = False):
    resp = await cala.call("GET", "/entities", params={"name": name, "limit": limit}, ledger=ledger,
                           cache_only=cache_only)
    if resp is None:
        return []
    keep = {"Company", "Organization", "Person"}
    return [{"id": e["id"], "name": pretty(e["name"]), "raw_name": e["name"], "type": e["entity_type"],
             "kind": kind(e["entity_type"]), "description": e.get("description")}
            for e in resp.get("entities", []) if e.get("entity_type") in keep]


async def investor(cala: Cala, uid: str, ledger: Ledger | None = None, cache_only: bool = False) -> dict | None:
    """One call: an investor's funding rounds (lead flag and sources on each) and its portfolio."""
    d = await cala.call("POST", f"/entities/{uid}", body=INVESTOR_BODY, ledger=ledger, cache_only=cache_only)
    if d is None:
        return None
    out = (d.get("relationships") or {}).get("outgoing") or {}
    rounds = []
    for r in out.get("PARTICIPATES_IN_FUNDING_ROUND", []):
        p = r.get("properties") or {}
        if p.get("role") and p["role"] != "INVESTOR":
            continue
        srcs = sources(p.get("sources"))
        rounds.append({"id": r["id"], "label": r.get("name"), "is_lead": bool(p.get("is_lead")),
                       "sources": srcs, "reported": first_report_date(srcs)})
    name = ((d.get("properties") or {}).get("name") or {}).get("value") or d.get("name") or ""
    portfolio = [{"id": c["id"], "name": pretty(c["name"]), "sources": sources((c.get("properties") or {}).get("sources"))[:2]}
                 for c in out.get("INVESTED_IN", [])]
    return {"id": uid, "name": pretty(name), "raw_name": name, "type": d.get("entity_type"),
            "kind": kind(d.get("entity_type")), "description": d.get("description"),
            "rounds": rounds, "portfolio": portfolio, "capped": len(rounds) >= ROUND_CAP}


async def funding_round(cala: Cala, rid: str, ledger: Ledger | None = None, cache_only: bool = False) -> dict | None:
    """One call: a round's date, size, issuer and every participant with its lead flag and sources."""
    d = await cala.call("POST", f"/entities/{rid}", body=ROUND_BODY, ledger=ledger, cache_only=cache_only)
    if d is None:
        return None
    props = d.get("properties") or {}
    p = {k: v.get("value") for k, v in props.items()}
    when = p.get("announcement_date")
    # Every fact keeps its own pages, so a number on screen can be checked against the page it came from.
    tagged: dict[str, dict] = {}
    for tag, name in (("date", "announcement_date"), ("amount", "transaction_value"), (None, "transaction_value_units"),
                      (None, "round_label")):
        for x in sources((props.get(name) or {}).get("sources")):
            item = tagged.setdefault(x["url"], {**x, "backs": []})
            if tag and tag not in item["backs"]:
                item["backs"].append(tag)
    issuer, investors = None, []
    for x in ((d.get("relationships") or {}).get("incoming") or {}).get("PARTICIPATES_IN_FUNDING_ROUND", []):
        xp = x.get("properties") or {}
        item = {"id": x["id"], "name": pretty(x["name"]), "type": x.get("entity_type"), "kind": kind(x.get("entity_type")),
                "is_lead": bool(xp.get("is_lead")), "sources": sources(xp.get("sources"))}
        if item["is_lead"]:
            item["lead_reported"] = reported_before(item["sources"], when)
        if xp.get("role") == "ISSUER":
            issuer = {"id": x["id"], "name": pretty(x["name"])}
        elif xp.get("role") in (None, "INVESTOR"):
            investors.append(item)
    label = p.get("round_label")
    amount = p.get("transaction_value") if isinstance(p.get("transaction_value"), (int, float)) else None
    currency = p.get("transaction_value_units")
    if label in ("PRE_SEED", "SEED") and amount and amount > 40_000_000:
        label = None  # a nine-figure "seed" is a labelling slip in the source; show the amount, claim no stage
    set_aside = None
    stale = reported_before([x for x in tagged.values() if "amount" in x["backs"]], when) if amount else None
    if stale:   # the amount was reported before this round took place: it is some earlier round's size
        set_aside = {"amount": amount, "currency": currency, "reported": stale}
        amount = currency = None
    return {"id": rid, "stage": label, "stage_name": STAGE_NAMES.get(label or "", (label or "Round").replace("_", " ").title()),
            "date": when, "amount": amount, "currency": currency, "amount_set_aside": set_aside,
            "issuer": issuer, "investors": investors,
            "sources": sorted(tagged.values(), key=lambda x: x.get("date") or "9999")}


async def profile(cala: Cala, uid: str, ledger: Ledger | None = None, cache_only: bool = False) -> dict | None:
    d = await cala.call("POST", f"/entities/{uid}", body=PROFILE_BODY, ledger=ledger, cache_only=cache_only)
    if d is None:
        return None
    props = d.get("properties") or {}
    val = lambda k: (props.get(k) or {}).get("value")  # noqa: E731
    people = []
    for x in ((d.get("relationships") or {}).get("incoming") or {}).get("WORKS_AT", []):
        xp = x.get("properties") or {}
        people.append({"id": x["id"], "name": x["name"], "role": xp.get("role"), "sources": sources(xp.get("sources"))[:2]})
    return {"id": uid, "description": val("description") or d.get("description"), "website": val("website"),
            "hq": val("headquarters_address"), "people": people,
            "website_sources": sources((props.get("website") or {}).get("sources"))[:1]}


async def company(cala: Cala, uid: str, ledger: Ledger | None = None, cache_only: bool = False) -> dict | None:
    d = await cala.call("POST", f"/entities/{uid}", body=COMPANY_BODY, ledger=ledger, cache_only=cache_only)
    if d is None:
        return None
    props = d.get("properties") or {}
    val = lambda k: (props.get(k) or {}).get("value")  # noqa: E731
    rel = d.get("relationships") or {}
    investors, seen = [], set()
    for x in (rel.get("incoming") or {}).get("INVESTED_IN", []):
        key = norm(x["name"])
        if key in seen or key in NOT_INVESTORS:
            continue
        seen.add(key)
        investors.append({"id": x["id"], "name": pretty(x["name"]), "type": x.get("entity_type"),
                          "kind": kind(x.get("entity_type")),
                          "sources": sources((x.get("properties") or {}).get("sources"))[:2]})
    out = rel.get("outgoing") or {}
    return {"id": uid, "name": pretty(val("name") or d.get("name") or ""),
            "description": fix_text(val("description") or d.get("description")),
            "website": val("website"), "founded": val("founding_date"), "total_funding": val("total_funding"),
            "currency": val("total_funding_units"), "stage": val("funding_stage"), "hq": val("headquarters_address"),
            "investors": investors,
            "rounds": [{"id": r["id"], "label": r.get("name")} for r in out.get("PARTICIPATES_IN_FUNDING_ROUND", [])],
            "industries": list({i["name"]: {"id": i["id"], "name": i["name"].replace("_", " ").capitalize()}
                                for i in out.get("OPERATES_IN_INDUSTRY", [])}.values())}


async def company_rounds(cala: Cala, cid: str, ledger: Ledger | None = None, cache_only: bool = False) -> list[dict] | None:
    """One call: the funding rounds a company raised, each with the date it was first reported."""
    d = await cala.call("POST", f"/entities/{cid}", body=COMPANY_ROUNDS_BODY, ledger=ledger, cache_only=cache_only)
    if d is None:
        return None
    out = []
    for r in ((d.get("relationships") or {}).get("outgoing") or {}).get("PARTICIPATES_IN_FUNDING_ROUND", []):
        p = r.get("properties") or {}
        if p.get("role") not in (None, "ISSUER"):
            continue
        srcs = sources(p.get("sources"))
        out.append({"id": r["id"], "label": r.get("name"), "sources": srcs, "reported": first_report_date(srcs)})
    return out


async def company_people(cala: Cala, cid: str, ledger: Ledger | None = None, cache_only: bool = False) -> list[dict] | None:
    """One call: a company's founders and chief executive, each with the source that names them."""
    d = await cala.call("POST", f"/entities/{cid}", body=PEOPLE_BODY, ledger=ledger, cache_only=cache_only)
    if d is None:
        return None
    inc = (d.get("relationships") or {}).get("incoming") or {}
    people: dict[str, dict] = {}
    for rel, role in (("FOUNDED", "Founder"), ("IS_CEO_OF", "CEO"), ("WORKS_AT", None)):
        for x in inc.get(rel, []):
            if x.get("entity_type") != "Person":
                continue
            xp = x.get("properties") or {}
            r = role or (xp.get("role") or "").strip()
            if rel == "WORKS_AT" and not re.search(r"\b(ceo|chief executive|founder|cto|coo)\b", r, re.I):
                continue
            key = norm(x["name"])
            p = people.setdefault(key, {"id": x["id"], "name": x["name"], "roles": [], "sources": []})
            r = "CEO" if re.fullmatch(r"(ceo|chief executive( officer)?)", r, re.I) else r
            for part in re.split(r"\s*(?:&|,| and )\s*", r):
                part = {"co-founder": "Founder", "cofounder": "Founder", "founder": "Founder", "ceo": "CEO"}.get(part.lower(), part)
                if part and part not in p["roles"]:
                    p["roles"].append(part)
            for src in sources(xp.get("sources")):
                if src["url"] not in {y["url"] for y in p["sources"]}:
                    p["sources"].append(src)
    out = []
    for p in people.values():
        roles = sorted(p["roles"], key=lambda r: {"Founder": 0, "CEO": 1}.get(r, 2))[:2]
        out.append({"id": p["id"], "name": p["name"], "role": " & ".join(roles), "sources": p["sources"][:2]})
    out.sort(key=lambda p: (("CEO" not in p["role"]), ("Founder" not in p["role"]), p["name"]))
    return out


def fix_text(s: str | None) -> str | None:
    """Undo UTF-8 text that was decoded as Latin-1 somewhere upstream ('whatâ\x80\x99s' -> 'what’s')."""
    if not s or not any(ch in s for ch in "âÃ"):
        return s
    try:
        return s.encode("cp1252").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        try:
            return s.encode("latin-1").decode("utf-8")
        except (UnicodeEncodeError, UnicodeDecodeError):
            return s


def years_ago(iso: str | None, today: date | None = None) -> float | None:
    if not iso:
        return None
    try:
        y, m, d = (int(x) for x in iso[:10].split("-"))
        return ((today or date.today()) - date(y, m, d)).days / 365.25
    except ValueError:
        return None
