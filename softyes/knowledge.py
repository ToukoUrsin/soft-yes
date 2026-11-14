"""Second path into Cala: its knowledge search, for investors whose rounds the entity graph does not hold.

Cala answers in prose and tables, with the passages it read and the page each passage came from.
We keep a row only when one of those passages names both the company and the lead, and we cite that
passage's page. A row we cannot find in a passage is dropped, however plausible it looks.
"""
from __future__ import annotations

import hashlib
import re

from . import graph, pagecheck
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


INSIDE_A_NAME = re.compile(r"^(research|company|co\b|sons|partners|associates|development|innovation|climate|more)", re.I)


def _ampersand(piece: str) -> list[str]:
    """'Endeit Capital & DeepTech & Climate Fonds' is two investors, 'B & C Holding' is one. An "&" after a single
    word, or before a word that only ends a name, sits inside the name; any other "&" parts two names."""
    parts = [p.strip() for p in re.split(r"\s+&\s+", piece) if p.strip()]
    out: list[str] = []
    glue = False
    for p in parts:
        if out and (glue or INSIDE_A_NAME.match(p)):
            out[-1] += " & " + p
        else:
            out.append(p)
        glue = len(out[-1].split()) == 1   # one word so far ("DeepTech", "B"): the next part belongs to it
    return out


def _leads(text: str, own: str) -> list[str]:
    text = re.sub(r"\([^)]*\)", "", text)
    out = []
    for part in (n for piece in re.split(r",|;|\s+and\s+|/", text) for n in _ampersand(piece)):
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
            passages.append((f" {_squash(k.get('content'))} ", srcs, graph.fix_text(k.get("content") or "") or ""))
    kept, dropped = [], 0
    for r in rows:
        company = f" {_squash(r['company'])} "
        found, named, said = [], [], {}
        for text, srcs, raw in passages:
            if company not in text or not re.search(r" (led|lead|leads|leading|co led) ", text):
                continue
            # is the page itself about this company? then "The round was led by X" needs no company in the sentence
            about = any(company in f" {_squash(s.get('title'))} " or company in f" {_squash(re.sub(r'[-_/.]+', ' ', s['url']))} "
                        for s in srcs)
            for lead in r["leads"]:
                if lead in said or f" {_squash(lead)} " not in text:
                    continue
                quote = _said(raw, lead, r["company"], about)
                if not quote:
                    continue   # both names somewhere in one passage is not a statement that one led the other's round
                said[lead] = {"quote": quote, "url": srcs[0]["url"], "publisher": srcs[0]["publisher"]}
                named.append(lead)
                for s in srcs:
                    if not any(f["url"] == s["url"] for f in found):
                        found.append(s)
        if not named:
            dropped += 1
            continue
        kept.append({**r, "leads": named, "sources": found[:4], "said": said})
    return kept, dropped


def _said(raw: str, lead: str, company: str, about: bool) -> str | None:
    """The passage's own words that this lead led this company's round: a table row naming both, or a sentence that
    names the lead next to a word for leading (and the company too, unless the page is about that company)."""
    words = re.findall(r"[A-Za-z0-9åäöüéèñøæÅÄÖÜ]+", lead)
    if not words:
        return None
    name = re.compile(r"(?<![A-Za-z0-9])" + r"[^A-Za-z0-9]{0,3}".join(map(re.escape, words)) + r"(?![A-Za-z0-9])", re.I)
    co = f" {_squash(company).strip()} "
    for part in raw.split("[...]"):   # Cala joins excerpts of one page with this mark: never quote across it
        for line in part.split("\n"):
            if not (3 <= line.count("|") <= 9) or len(line) > 400 or co not in f" {_squash(line)} ":
                continue
            cells = [c.strip() for c in line.strip().strip("|").split("|") if c.strip()]
            # the cell that names it must itself say it led: "led by Mosaic Ventures", never a column we cannot see
            if any(name.search(c) and LED_CELL.search(c) for c in cells):
                return " · ".join(cells)
        for m in name.finditer(part):
            lo, hi = pagecheck._sentence(part, m.start())
            sent = re.sub(r"\s+", " ", pagecheck.tidy(part[lo:hi])).strip(" |#*>")
            at = name.search(sent)
            if not at or not (30 <= len(sent) <= 420) or sent.count("|") > 1 or not pagecheck._says_led(sent, at.start(), at.end()):
                continue
            if co in f" {_squash(sent)} " or (about and not pagecheck._other_company(sent, company)):
                return sent
    return None


LED_CELL = re.compile(r"(?:^|[\s(])(?:co-)?(?:led by|lead investors?|leads the|led the)\b")


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


COMPANY_QUESTION = "Who led each funding round of {name}?"
SAYS_LED = re.compile(r"(?<![\w-])(?:(?:co-?)?led by|(?:co-?)?lead investors?|(?:co-?)?led (?:the|a|an|its|this|that)\b|"
                      r"(?:co-?)?leads? (?:the|a|an|its|this)\b[^.|]{0,60}\b(?:round|financing|funding)|(?:co-?)?leading (?:the|a|its|this)\b)", re.I)
# A sentence that does not name the company counts only on a page about it, and only when it opens on the round itself.
ITS_ROUND = re.compile(r"(?:(?:the|this|its|a|an)\s+)?(?:[\w$€£.-]+\s+){0,4}?(?:round|funding|financing|investment|series [a-h]|seed)\b", re.I)


def _table_rows(text: str, limit: int = 4) -> list[str]:
    """Rows of a table that has a lead column, each written out as 'column: cell'. A row whose cells do not line up
    with the header is skipped."""
    out, head, lead = [], None, None
    for line in text.splitlines():
        if not line.strip().startswith("|"):
            if not re.fullmatch(r"[\s:|-]*", line):
                head = None
            continue
        cells = _cells(line)
        if head is None:
            lead = next((i for i, c in enumerate(cells) if re.search(r"\blead", c, re.I)), None)
            head = cells if lead is not None else False
            continue
        if not head or len(cells) != len(head) or cells[lead].lower() in NOBODY or len(out) >= limit:
            continue
        if not re.match(r"[A-Za-zÀ-ÿ]", cells[lead]) or re.search(r"[$€£]|\d{4}", cells[lead]):
            continue   # cells out of step with the header: an amount or a date under "lead"
        out.append(" · ".join(f"{h}: {c}" for h, c in zip(head, cells)
                              if c and c.lower() not in NOBODY and not re.fullmatch(r"\d{5,}", c)))
    return out


async def company_leads(cala: Cala, name: str, ledger: Ledger | None = None, cache_only: bool = False) -> dict | None:
    """For a company whose rounds the graph does not hold: the sentences that say who led a round of it, word for word,
    from the passages Cala's knowledge search read, each with its page. Cala's own prose answer is not used."""
    question = COMPANY_QUESTION.format(name=name)
    d = await cala.call("POST", "/knowledge/search", body={"input": question}, ledger=ledger, cache_only=cache_only)
    if d is None:
        return None
    keys = [k for k in pagecheck.company_keys(name) if len(k) > 2] or [_squash(name).strip()]
    first = name.split()[0]
    if len(first) >= 4 and first.lower() not in pagecheck.COMMON_FIRST:   # "Oura Health" is "Oura" in the press
        keys.append(first)
    names = lambda text: any(f" {_squash(k).strip()} " in f" {_squash(text)} " for k in keys)  # noqa: E731
    quotes, seen = [], set()
    for k in d.get("context") or []:
        text = graph.fix_text(k.get("content") or "") or ""
        src = None
        for o in k.get("origins") or []:
            doc, org = o.get("document") or {}, o.get("source") or {}
            url = doc.get("url") or org.get("url")
            if url:
                m = re.match(r"https?://(?:www\.)?([^/]+)", url)
                src = {"publisher": m.group(1) if m else (org.get("name") or "")[:60], "url": url,
                       "title": (doc.get("name") or "")[:140]}
                break
        if not src or text.startswith("Entity: "):
            continue
        about = names(src["title"]) or names(re.sub(r"[-_/.]+", " ", src["url"]))   # the page is about this company
        for part in text.split("[...]"):   # Cala joins excerpts of one page with this mark: never quote across it
            for row in _table_rows(part) if about else []:
                key = _squash(row)[:160]
                if key not in seen:
                    seen.add(key)
                    quotes.append({"quote": row, "table": True, "rank": 1, **src})
            for m in SAYS_LED.finditer(part):
                lo, hi = pagecheck._sentence(part, m.start())
                sent = re.sub(r"\s+", " ", part[lo:hi]).strip(" |#")
                if not (20 <= len(sent) <= 420) or sent.count("|") > 1:
                    continue
                if not (names(sent) or (about and ITS_ROUND.match(sent))):
                    continue
                key = _squash(sent)[:160]
                if key in seen or any(key[:60] in s for s in seen):
                    continue
                seen.add(key)
                if hi >= len(part) and not re.search(r"[.!?\"”)]$", sent):
                    sent += " …"   # the excerpt ends here, not the sentence
                quotes.append({"quote": sent, "rank": 0 if names(sent) else 2, **src})
    quotes.sort(key=lambda q: q.pop("rank"))
    return {"question": question, "quotes": quotes[:6], "passages": len(d.get("context") or [])}
