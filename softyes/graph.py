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

ROUND_CAP = 50  # Cala returns at most 50 relationships of one type per entity

LEGAL = {"oy", "oyj", "ab", "ltd", "limited", "llc", "llp", "lp", "inc", "gmbh", "as", "sa", "sas", "bv", "ky",
         "plc", "corp", "co", "ag", "aps", "oü", "spa", "srl", "sl", "kg", "scsp", "fcre", "sgeic"}
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


def pretty(name: str) -> str:
    """'NORDICNINJA VC LIMITED' -> 'Nordicninja VC'. Mixed-case names are left as Cala has them."""
    name = (name or "").strip()
    if not name:
        return name
    words = name.split()
    while len(words) > 1 and re.sub(r"\W", "", words[-1]).lower() in LEGAL:
        words.pop()
    if name.isupper():
        words = [w if w.lower() in ACRONYMS and len(w) <= 4 else w.capitalize() for w in words]
        words = [w.upper() if w.lower() in ACRONYMS else w for w in words]
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
    p = {k: v.get("value") for k, v in (d.get("properties") or {}).items()}
    psrc = []
    for v in (d.get("properties") or {}).values():
        psrc += v.get("sources") or []
    issuer, investors = None, []
    for x in ((d.get("relationships") or {}).get("incoming") or {}).get("PARTICIPATES_IN_FUNDING_ROUND", []):
        xp = x.get("properties") or {}
        item = {"id": x["id"], "name": pretty(x["name"]), "type": x.get("entity_type"), "kind": kind(x.get("entity_type")),
                "is_lead": bool(xp.get("is_lead")), "sources": sources(xp.get("sources"))}
        if xp.get("role") == "ISSUER":
            issuer = {"id": x["id"], "name": pretty(x["name"])}
        elif xp.get("role") in (None, "INVESTOR"):
            investors.append(item)
    label = p.get("round_label")
    amount = p.get("transaction_value")
    if label in ("PRE_SEED", "SEED") and isinstance(amount, (int, float)) and amount > 40_000_000:
        label = None  # a nine-figure "seed" is a labelling slip in the source; show the amount, claim no stage
    return {"id": rid, "stage": label, "stage_name": STAGE_NAMES.get(label or "", (label or "Round").replace("_", " ").title()),
            "date": p.get("announcement_date"), "amount": amount if isinstance(amount, (int, float)) else None,
            "currency": p.get("transaction_value_units"), "issuer": issuer, "investors": investors,
            "sources": sources(psrc)}


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
        if key in seen:
            continue
        seen.add(key)
        investors.append({"id": x["id"], "name": pretty(x["name"]), "type": x.get("entity_type"),
                          "kind": kind(x.get("entity_type")),
                          "sources": sources((x.get("properties") or {}).get("sources"))[:2]})
    out = rel.get("outgoing") or {}
    return {"id": uid, "name": pretty(val("name") or d.get("name") or ""), "description": val("description") or d.get("description"),
            "website": val("website"), "founded": val("founding_date"), "total_funding": val("total_funding"),
            "currency": val("total_funding_units"), "stage": val("funding_stage"), "hq": val("headquarters_address"),
            "investors": investors,
            "rounds": [{"id": r["id"], "label": r.get("name")} for r in out.get("PARTICIPATES_IN_FUNDING_ROUND", [])],
            "industries": [{"id": i["id"], "name": i["name"]} for i in out.get("OPERATES_IN_INDUSTRY", [])]}


def years_ago(iso: str | None, today: date | None = None) -> float | None:
    if not iso:
        return None
    try:
        y, m, d = (int(x) for x in iso[:10].split("-"))
        return ((today or date.today()) - date(y, m, d)).days / 365.25
    except ValueError:
        return None
