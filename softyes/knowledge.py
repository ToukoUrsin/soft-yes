"""Second path into Cala: its knowledge search, for investors whose rounds the entity graph does not hold.

Cala answers in prose and tables, with the passages it read and the page each passage came from.
We keep a row only when one of those passages names both the company and the lead, and we cite that
passage's page. A row we cannot find in a passage is dropped, however plausible it looks.
"""
from __future__ import annotations

import hashlib
import re

from . import graph
from .cala import Cala, Ledger

QUESTION = "Funding rounds where {name} invested but another investor was the lead"
MONTHS = {m: i + 1 for i, m in enumerate(["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"])}
STAGES = [(r"pre[\s-]?seed", "PRE_SEED"), (r"seed", "SEED")] + [(rf"series\s+{c}\b", f"SERIES_{c.upper()}") for c in "abcdef"]
CURRENCY = {"€": "EUR", "$": "USD", "£": "GBP"}
NOBODY = {"", "—", "-", "–", "n/a", "na", "none", "unknown", "undisclosed", "not disclosed", "not specified", "tbd"}


def _cells(line: str) -> list[str]:
    return [re.sub(r"\*\*|__|`", "", c).strip() for c in line.strip().strip("|").split("|")]


def _date(text: str) -> str | None:
    t = text.strip().lower()
    m = re.search(r"(\d{4})-(\d{2})-(\d{2})", t)
    if m:
        return m.group(0)
    m = re.search(r"([a-z]{3})[a-z]*\.?\s+(?:\d{1,2},?\s+)?(\d{4})", t)
    if m and m.group(1) in MONTHS:
        return f"{m.group(2)}-{MONTHS[m.group(1)]:02d}-01"
    m = re.fullmatch(r"(?:fy|h[12]|q[1-4])?\s*(\d{4})", t)
    return f"{m.group(1)}-07-01" if m else None


def _amount(text: str) -> tuple[float | None, str | None]:
    m = re.search(r"([€$£])\s?([\d.,]+)\s?(bn|b|m|k|billion|million)?", text, re.I)
    if not m:
        return None, None
    try:
        n = float(m.group(2).replace(",", ""))
    except ValueError:
        return None, None
    unit = (m.group(3) or "").lower()
    n *= 1e9 if unit in ("b", "bn", "billion") else 1e6 if unit in ("m", "million") else 1e3 if unit == "k" else 1
    return n, CURRENCY[m.group(1)]


def _stage(text: str) -> str | None:
    for pat, stage in STAGES:
        if re.search(pat, text, re.I):
            return stage
    return None


def _leads(text: str, own: str) -> list[str]:
    text = re.sub(r"\([^)]*\)", "", text)
    out = []
    for part in re.split(r",|;|\s+and\s+|\s+&\s+|/", text):
        name = re.sub(r"^(co-)?led by\s+", "", part.strip(), flags=re.I).strip(" .")
        if name.lower() in NOBODY or len(name) < 2 or len(name) > 60 or re.search(r"\b(likely|various|others?|existing)\b", name, re.I):
            continue
        if graph.norm(name) == own or graph.norm(name) in graph.NOT_INVESTORS:
            continue
        out.append(name)
    return out


def parse(markdown: str, own_key: str) -> list[dict]:
    """Rows of every table in the answer that has a company column and a lead column."""
    rows, cols = [], None
    for line in (markdown or "").splitlines():
        if not line.strip().startswith("|"):
            cols = None
            continue
        cells = _cells(line)
        if all(re.fullmatch(r":?-{2,}:?", c) for c in cells if c) and cells:
            continue
        low = [c.lower() for c in cells]
        if cols is None:
            def find(*words):
                return next((i for i, c in enumerate(low) if any(w in c for w in words)), None)
            cols = {"company": find("company", "startup"), "round": find("round", "stage"),
                    "amount": find("amount", "raised", "size"), "lead": find("lead", "led by"),
                    "date": find("date", "announced", "year", "when")}
            if cols["company"] is None or cols["lead"] is None:
                cols = False
            continue
        if not cols or len(cells) <= max(i for i in cols.values() if i is not None):
            continue
        company = re.sub(r"\s*\([^)]*\)\s*$", "", cells[cols["company"]]).strip()
        leads = _leads(cells[cols["lead"]], own_key)
        if not company or not leads:
            continue
        get = lambda k: cells[cols[k]] if cols[k] is not None else ""  # noqa: E731
        amount, currency = _amount(get("amount"))
        stage = _stage(get("round"))
        rows.append({"company": company, "leads": leads, "stage": stage, "amount": amount, "currency": currency,
                     "date": _date(get("date"))})
    return rows


def _squash(text: str) -> str:
    return re.sub(r"[^a-z0-9åäöüéèñøæ]+", " ", (text or "").lower())


def verify(rows: list[dict], context: list[dict]) -> tuple[list[dict], int]:
    """Keep rows a passage backs: the passage names the company and at least one of the leads."""
    passages = []
    for k in context or []:
        srcs = []
        for o in k.get("origins") or []:
            doc, src = o.get("document") or {}, o.get("source") or {}
            url = doc.get("url") or src.get("url")
            if url and not any(s["url"] == url for s in srcs):
                m = re.match(r"https?://(?:www\.)?([^/]+)", url)
                srcs.append({"publisher": m.group(1) if m else (src.get("name") or "")[:60], "url": url,
                             "date": None, "rank": None, "title": (doc.get("name") or "")[:140]})
        if srcs:
            passages.append((f" {_squash(k.get('content'))} ", srcs))
    kept, dropped = [], 0
    for r in rows:
        company = f" {_squash(r['company'])} "
        found, named = [], []
        for text, srcs in passages:
            if company not in text or not re.search(r" (led|lead|leads|leading|co led) ", text):
                continue
            hit = [lead for lead in r["leads"] if f" {_squash(lead)} " in text]
            if hit:
                for s in srcs:
                    if not any(f["url"] == s["url"] for f in found):
                        found.append(s)
                named += [h for h in hit if h not in named]
        if not found:
            dropped += 1
            continue
        kept.append({**r, "leads": named, "sources": found[:4]})
    return kept, dropped


def round_id(row: dict) -> str:
    key = f"{graph.norm(row['company'])}|{row['stage']}|{(row['date'] or '')[:7]}|{row['amount']}"
    return "k:" + hashlib.sha256(key.encode()).hexdigest()[:12]


async def followed(cala: Cala, name: str, own_key: str, ledger: Ledger | None = None, cache_only: bool = False) -> dict | None:
    """Rounds this investor joined that someone else led, per Cala's knowledge search, each backed by a passage."""
    d = await cala.call("POST", "/knowledge/search", body={"input": QUESTION.format(name=name)}, ledger=ledger,
                        cache_only=cache_only)
    if d is None:
        return None
    rows = parse(d.get("content") or "", own_key)
    kept, dropped = verify(rows, d.get("context") or [])
    seen, unique = set(), []
    for r in kept:
        rid = round_id(r)
        if rid not in seen:
            seen.add(rid)
            unique.append({**r, "id": rid})
    return {"question": QUESTION.format(name=name), "rows": unique, "read": len(rows), "dropped": dropped,
            "passages": len(d.get("context") or [])}
