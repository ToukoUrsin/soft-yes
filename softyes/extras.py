"""Everything around the ranking: drafts (Gemini), "says vs did" (Oxylabs + Gemini), conflicts, Ask Cala, Slush.

Rule kept everywhere: a language model never states a fact. It may phrase facts it was handed, quote a page
verbatim, or point at a company to look up. Each of those is checked in code before it is shown.
"""
from __future__ import annotations

import asyncio
import html as html_mod
import json
import os
import re
import time
from datetime import date

import httpx

from . import cala as cala_mod
from . import graph, slush_mcp
from .cala import BudgetExceeded, Cala, CalaError

GEMINI_MODEL = os.environ.get("SOFTYES_GEMINI_MODEL", "gemini-3.8-flash")
GEMINI_EFFORT = os.environ.get("SOFTYES_GEMINI_EFFORT", "low")
GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
OXYLABS_URL = "https://webapi.oxylabs.io/v1/scrape"
SLUSH_EVENTS_URL = "https://search.slush.org/search/slush26/side-events"
MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

_http: httpx.AsyncClient | None = None


def http() -> httpx.AsyncClient:
    global _http
    if _http is None:
        _http = httpx.AsyncClient(timeout=90, headers={"User-Agent": "softyes/0.1"})
    return _http


def gemini_ready() -> bool:
    return bool(os.environ.get("JUNCTION_GEMINI_API_KEY"))


def oxylabs_ready() -> bool:
    return bool(os.environ.get("JUNCTION_OXYLABS_API_KEY"))


def blob_get(key: str, max_age: float | None = None):
    c = cala_mod.get()
    with c.dblock:
        row = c.db.execute("select created, value from blobs where key=?", (key,)).fetchone()
    if not row or (max_age and time.time() - row[0] > max_age):
        return None
    return json.loads(row[1])


def blob_put(key: str, value) -> None:
    c = cala_mod.get()
    with c.dblock:
        c.db.execute("insert or replace into blobs values(?,?,?)", (key, time.time(), json.dumps(value, ensure_ascii=False)))


async def gemini_json(system: str, user: str, temperature: float = 0.4):
    """One Gemini call that must return JSON. Returns None when Gemini is unavailable or answers badly."""
    if not gemini_ready():
        return None
    payload = {"model": GEMINI_MODEL, "temperature": temperature, "response_format": {"type": "json_object"},
               "reasoning_effort": GEMINI_EFFORT,
               "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}]}
    for attempt in range(2):
        try:
            r = await http().post(GEMINI_URL, json=payload, timeout=25,
                                  headers={"Authorization": f"Bearer {os.environ['JUNCTION_GEMINI_API_KEY']}"})
            if r.status_code == 200:
                text = r.json()["choices"][0]["message"]["content"]
                text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip())
                return json.loads(text)
        except (httpx.HTTPError, ValueError, KeyError, IndexError):
            pass
        await asyncio.sleep(1 + attempt)
    return None


# ---------------------------------------------------------------------------------------------- formatting

def fmt_date(iso: str | None) -> str:
    if not iso:
        return ""
    try:
        y, m, d = (int(x) for x in iso[:10].split("-"))
        return f"{d} {MONTHS[m - 1]} {y}"
    except (ValueError, IndexError):
        return iso[:4]


def fmt_month(iso: str | None) -> str:
    if not iso:
        return ""
    try:
        y, m = int(iso[:4]), int(iso[5:7])
        return f"{MONTHS[m - 1]} {y}"
    except (ValueError, IndexError):
        return iso[:4]


def fmt_money(amount, currency) -> str:
    if not amount:
        return ""
    sym = {"EUR": "€", "USD": "$", "GBP": "£"}.get(currency or "", "")
    if amount >= 1e9:
        s = f"{amount / 1e9:.1f}".rstrip("0").rstrip(".") + "B"
    elif amount >= 1e6:
        s = f"{amount / 1e6:.1f}".rstrip("0").rstrip(".") + "M"
    elif amount >= 1e3:
        s = f"{amount / 1e3:.0f}K"
    else:
        s = f"{amount:.0f}"
    return f"{sym}{s}" if sym else f"{s} {currency or ''}".strip()


def deal_phrase(d: dict) -> str:
    """'Seaber.io's €1.5M seed (Jul 2024)'"""
    issuer = (d.get("issuer") or {}).get("name") or "a company"
    stage = (d.get("stage_name") or "round").lower() if d.get("stage") else "round"
    stage = stage.replace("series ", "Series ").replace("Series a", "Series A").replace("Series b", "Series B") \
                 .replace("Series c", "Series C").replace("Series d", "Series D")
    money = fmt_money(d.get("amount"), d.get("currency"))
    when = fmt_month(d.get("date"))
    core = f"{issuer}'s {money + ' ' if money else ''}{stage}"
    return f"{core} ({when})" if when else core


# ---------------------------------------------------------------------------------------------- drafts

COMMON = set("""a about above after again all also am an and any are around as at back be because been before being best both
but by can chance cheers coffee could dear deal deals did do does done each either email even ever every find first follow
following follows for from fund get give given glad good great had happy has have having he hello help her here hey hi him his
how i if in intro introduce introduction into is it its join joined just keen kind know last lead leader leading leads led let
like look looking make many may maybe me meet meeting might minute minutes month months more most much my name need new next
no not note now of on once one only open or other our out over own part partner partners per please quick raise raising
rather really recent recently regards right round rounds said same say see seed series she short should since so some soon
stage start still such sure take talk team than thank thanks that the their them then there these they thing think this those
though through time to today together too took two under up us very was way we week weeks well were what when where whether
which while who why will with within without worth would yes yet you your yours slush helsinki pre a b c d ps investor
investors invest invested investing investment company founder founders ceo call chat intros brief context reason reasons
pattern record track public data sourced source sources cala lead-investor co-lead co-led already twice three four five six
seven eight nine ten jan feb mar apr may jun jul aug sep oct nov dec january february march april june july august
september october november december monday tuesday wednesday thursday friday based building built backed backing committed commit commits come coming early ready interested interest currently plan planning plans share shared sharing sent send reach reaching writing write wrote ask asking asked able tell told want wanted wants wonder wondering hope hoping love appreciate appreciated grateful forward forwardable lines line blurb below above attached closing close closed term sheet terms subject re fwd hear heard explore discuss discussion conversation worked work working alongside previously earlier later tomorrow yesterday history introduction introductions request""".split())


def fact_sheet(result: dict, lead: dict, founder: dict) -> list[str]:
    name = lead["name"]
    facts = []
    for d in lead["evidence"][:4]:
        who = " and ".join(d["with"])
        verb = "led" if lead["ring"] == 1 else "took part in"
        facts.append(f"{name} {verb} {deal_phrase(d)}. {who} took part in that round.")
    p = lead.get("pulse")
    if p and p["rounds"]:
        facts.append(f"Cala has {p['rounds']} funding rounds for {name}; it led {p['led']} of them"
                     + (f", {p['led_recent']} in the last {p['recent_months']} months." if p["led_recent"] else "."))
    if lead.get("last_led"):
        facts.append(f"The most recent round {name} led in Cala: {deal_phrase(lead['last_led'])}.")
    for s in result["soft_yeses"]:
        if any(s["name"] in d["with"] for d in lead["evidence"]) and s.get("rounds_in_cala"):
            facts.append(f"{s['name']} led {s['led']} of its {s['rounds_in_cala']} rounds in Cala and followed in {s['followed']}.")
    softs = sorted({w for d in lead["evidence"] for w in d["with"]})
    if softs:
        facts.append(f"{' and '.join(softs)} told the founder: we will invest once a lead investor is in. (The founder's own statement.)")
    if founder.get("company"):
        facts.append(f"The founder's company is {founder['company']}." + (f" {founder['one_liner']}" if founder.get("one_liner") else ""))
    if founder.get("raising"):
        facts.append(f"The founder is raising: {founder['raising']}.")
    return facts


def template(result: dict, lead: dict, kind: str, founder: dict) -> dict:
    """Deterministic draft, used when Gemini is off or says something the facts do not support."""
    name = lead["name"]
    ask = lead.get("ask") or {}
    soft = ask.get("name") or (result["soft_yeses"][0]["name"] if result["soft_yeses"] else "our investor")
    deal = deal_phrase(ask["last"]) if ask.get("last") else None
    company = founder.get("company") or "[your company]"
    raising = re.sub(r"^(an?|our|the)\s+", "", founder.get("raising") or "", flags=re.I) or "[round]"
    a_raising = ("an " if raising[:1].lower() in "aeiou8" else "a ") + raising if raising != "[round]" else raising
    one = founder.get("one_liner") or "[one line on what you do]"
    led_verb = "led" if lead["ring"] == 1 else "joined"
    if kind == "intro_ask":
        subject = f"Intro to {name}?"
        body = (f"Hi,\n\nYou said {soft} would join our {raising} once a lead is in. "
                + (f"{name} {led_verb} {deal}, with {soft} in the round. " if deal else "")
                + f"Would you introduce us to the partner you worked with there?\n\n"
                  f"Two lines you can forward: {company}: {one} We are raising {a_raising} and {soft} has said it will follow.\n\nThanks")
    elif kind == "slush":
        subject = ""
        body = (f"{soft} has said it will join {company}'s {raising} once a lead is in. "
                + (f"You {led_verb} {deal} with them. " if deal else "")
                + "25 minutes at Slush to see if you'd lead?")
        if len(body) > 300:
            body = f"{soft} will follow in {company}'s {raising}. " + (f"You {led_verb} {deal} with them. " if deal else "") + "25 min at Slush?"
        body = body[:300]
    else:
        subject = f"{company}: {raising}, {soft} is in"
        body = (f"Hi,\n\n{company}: {one}\n\nWe are raising {a_raising}. {soft} has said it will join once a lead is in. "
                + (f"You {led_verb} {deal} with {soft} in the round, which is why I'm writing to you first. " if deal else "")
                + "Could we find 25 minutes this week?\n\nThanks")
    return {"subject": subject, "body": body}


def verify_draft(text: str, facts: list[str], founder: dict) -> list[str]:
    """Every number and every proper noun in the draft must come from the fact sheet or the founder's own words."""
    allowed = " ".join(facts + [str(v) for v in founder.values()]).lower()
    allowed_words = set(re.findall(r"[a-z0-9åäöüéèñøæ][a-z0-9åäöüéèñøæ.'’-]*", allowed))
    allowed_words |= {w.strip(".'’-") for w in allowed_words} | {w.replace("'s", "").replace("’s", "") for w in allowed_words}
    bad = []
    money = r"[€$£]\s?\d[\d.,]*\s?[MBKk]?\b|\d[\d.,]*\s?[MBKk]\b"
    tight = allowed.replace(" ", "")
    for m in re.findall(money, text):
        if m.lower().replace(" ", "").rstrip(".,") not in tight:
            bad.append(m)
    text = re.sub(money, " ", text)
    for num in re.findall(r"\d[\d.,]*", text):
        n = num.strip(".,")
        if n and n not in allowed and n.replace(",", "") not in allowed.replace(",", ""):
            bad.append(n)
    for word in re.findall(r"[A-Za-zÅÄÖÜÉÈÑØÆåäöüéèñøæ][A-Za-zÅÄÖÜÉÈÑØÆåäöüéèñøæ0-9.'’-]*", text):
        w = word.strip(".'’-")
        low = w.lower()
        base = re.sub(r"['’]s$", "", low)
        if not w or not (w[0].isupper() or any(ch.isdigit() for ch in w)):
            continue
        if low in COMMON or base in COMMON or low in allowed_words or base in allowed_words:
            continue
        if all(part in allowed_words or part in COMMON for part in re.split(r"[.\-]", base) if part):
            continue
        bad.append(w)
    return list(dict.fromkeys(bad))


async def draft(result: dict, lead: dict, kind: str, founder: dict, llm: bool = True) -> dict:
    facts = fact_sheet(result, lead, founder)
    fallback = template(result, lead, kind, founder)
    if not llm or not gemini_ready():
        return {"kind": kind, **fallback, "facts": facts, "model": None, "checked": True, "fallback": True,
                "chars": len(fallback["body"]), "note": "Built from the facts below without a language model."}
    ask = lead.get("ask") or {}
    soft = ask.get("name") or ""
    brief = {
        "intro_ask": f"An email from the founder to their contact at {soft}, who said {soft} will invest once a lead investor is in. "
                     f"Open with 'Hi,'. Ask for an introduction to {lead['name']}, using the most recent shared deal as the reason "
                     f"(one deal, with its amount and month). 60-90 words. End with a two-line blurb they can forward, which states "
                     f"the round being raised exactly as in FACTS. Do not mention Cala or counts of rounds.",
        "direct": f"A cold email from the founder to a partner at {lead['name']}, asking for a first call about leading the round. "
                  f"Open with 'Hi,' and what the company does, then say {soft} has said it will follow once a lead is in and cite "
                  f"the most recent deal they did together (with its amount and month). State the round being raised exactly as in "
                  f"FACTS. Ask for 25 minutes. 60-90 words. Do not mention Cala or counts of rounds.",
        "slush": f"A meeting request note for the Slush meeting tool, from the founder to {lead['name']}. Hard limit 280 characters, "
                 f"two or three sentences. Say what the company does in a few words, that {soft} has said it will follow once a lead "
                 f"is in, name the one most recent deal {lead['name']} and {soft} did together, and ask for 25 minutes at Slush about "
                 f"leading. Do not mention Cala or counts of rounds.",
    }[kind]
    system = ("You write short, plain fundraising messages for a startup founder. Use ONLY the facts in FACTS. "
              "Never add a name, number, date, title, sector or claim that is not in FACTS. No flattery, no buzzwords, "
              "no exclamation marks, no em dashes. First person plural for the company. Where a fact is missing "
              "(company name, what it does, round), write a bracketed placeholder like [your company]. "
              'Return JSON: {"subject": "...", "body": "..."}. For a Slush note the subject is empty.')
    user = "FACTS:\n" + "\n".join(f"- {f}" for f in facts) + f"\n\nWRITE: {brief}"
    unsupported: list[str] = []
    for attempt in range(2):
        out = await gemini_json(system, user + (f"\n\nYour last draft used words that are not in FACTS: {', '.join(unsupported)}. Remove them."
                                               if unsupported else ""))
        if not isinstance(out, dict) or not isinstance(out.get("body"), str):
            break
        body = out["body"].strip().replace("—", ", ")
        subject = str(out.get("subject") or "").strip()
        if kind == "slush" and len(body) > 300:
            unsupported = ["(over 300 characters)"]
            continue
        unsupported = verify_draft(re.sub(r"\[[^\]]*\]", " ", subject + "\n" + body), facts, founder)
        if not unsupported:
            return {"kind": kind, "subject": subject, "body": body, "facts": facts, "model": GEMINI_MODEL,
                    "checked": True, "fallback": False, "chars": len(body),
                    "note": "Written by Gemini from the facts below. Every name and number was checked against them."}
    return {"kind": kind, **fallback, "facts": facts, "model": None, "checked": True, "fallback": True,
            "chars": len(fallback["body"]),
            "note": "Built from the facts below without a language model."
                    + (f" Gemini's version was dropped: it added {', '.join(unsupported[:4])}." if unsupported else "")}


# ---------------------------------------------------------------------------------------------- says vs did

def page_text(html: str) -> str:
    html = re.sub(r"(?is)<(script|style|noscript|svg|template)[^>]*>.*?</\1>", " ", html)
    html = re.sub(r"(?i)<br\s*/?>|</(p|div|li|h[1-6]|section|article|tr)>", "\n", html)
    text = html_mod.unescape(re.sub(r"<[^>]+>", " ", html))
    lines = [re.sub(r"[ \t\xa0]+", " ", ln).strip() for ln in text.split("\n")]
    return "\n".join(ln for ln in lines if ln)


def squash(s: str) -> str:
    s = s.lower().replace("’", "'").replace("‘", "'").replace("“", '"').replace("”", '"').replace("–", "-").replace("—", "-")
    return re.sub(r"\s+", " ", s).strip()


async def scrape(url: str) -> dict:
    """Read one page through Oxylabs. Returns {url, text, links, status}."""
    if not oxylabs_ready():
        return {"url": url, "text": "", "links": [], "status": "no key"}
    cached = blob_get("page:" + url, max_age=7 * 86400)
    if cached:
        return cached
    out = {"url": url, "text": "", "links": [], "status": "error"}
    for run_js in (False, True):
        try:
            r = await http().post(OXYLABS_URL, json={"url": url, "output": ["html"], **({"run_js": True} if run_js else {})},
                                  headers={"Authorization": f"Bearer {os.environ['JUNCTION_OXYLABS_API_KEY']}"}, timeout=75)
        except httpx.HTTPError as exc:
            out["status"] = f"error: {type(exc).__name__}"
            continue
        if r.status_code != 200:
            out["status"] = f"error: HTTP {r.status_code}"
            continue
        page = (r.json().get("results") or [{}])[0]
        body = page.get("html") or ""
        if isinstance(body, dict):
            body = body.get("content") or body.get("text") or ""
        text = page_text(body)
        links = re.findall(r'(?i)<a[^>]+href="([^"#]+)"[^>]*>(.*?)</a>', body, flags=re.S)
        out = {"url": url, "text": text[:60000], "status": "ok_js" if run_js else "ok",
               "links": [{"href": h, "label": re.sub(r"<[^>]+>|\s+", " ", t).strip()[:60]} for h, t in links][:300]}
        if len(text) > 600:
            break
    if out["text"]:
        blob_put("page:" + url, out)
    return out


ABOUT = re.compile(r"about|approach|thesis|criteria|strategy|what-we-do|how-we|philosophy|focus|invest(?!ors-login)|manifesto|faq", re.I)


async def says(cala: Cala, lead: dict) -> dict:
    """What the fund says about itself on its own site, quoted verbatim, beside what Cala shows it did."""
    uid = lead.get("id")
    key = "says:" + (uid or lead["key"])
    hit = blob_get(key, max_age=3 * 86400)
    p = lead.get("pulse") or {}
    did = {"rounds": p.get("rounds"), "led": p.get("led"), "lead_rate": p.get("lead_rate"),
           "led_recent": p.get("led_recent"), "recent_months": p.get("recent_months"), "led_stages": p.get("led_stages", []),
           "last_led": lead.get("last_led")}
    if hit:
        return {**hit, "did": did}
    try:
        prof = await graph.profile(cala, uid) if uid else None
    except BudgetExceeded:
        prof = await graph.profile(cala, uid, cache_only=True)
    except CalaError:
        prof = None
    website = (prof or {}).get("website")
    base = {"lead": lead["name"], "website": website, "website_sources": (prof or {}).get("website_sources", []),
            "hq": (prof or {}).get("hq"), "people": ((prof or {}).get("people") or [])[:8], "quotes": [], "pages": []}
    if not website:
        return {**base, "available": False, "reason": "Cala has no website for this investor.", "did": did}
    if not re.match(r"https?://", website):
        website = "https://" + website
    home = await scrape(website)
    pages = [home]
    origin = re.match(r"https?://[^/]+", website).group(0)
    seen = {website.rstrip("/")}
    for link in home["links"]:
        href = link["href"]
        full = href if href.startswith("http") else origin + "/" + href.lstrip("/") if not href.startswith(("mailto:", "tel:", "javascript:")) else ""
        if not full.startswith(origin) or full.rstrip("/") in seen:
            continue
        if ABOUT.search(href) or ABOUT.search(link["label"]):
            seen.add(full.rstrip("/"))
            pages.append(await scrape(full))
            if len(pages) >= 3:
                break
    pages = [pg for pg in pages if pg["text"]]
    base["pages"] = [{"url": pg["url"], "chars": len(pg["text"]), "status": pg["status"]} for pg in pages]
    if not pages:
        return {**base, "available": False, "reason": f"Oxylabs could not read {website} ({home['status']}).", "did": did}
    corpus = "\n\n".join(f"PAGE {n + 1} ({pg['url']}):\n{pg['text'][:9000]}" for n, pg in enumerate(pages))
    out = await gemini_json(
        "You extract verbatim quotes. From the investor's own website text, pick up to 5 sentences in which the firm says "
        "how it invests: whether it leads rounds, at which stage, cheque size, sectors or geography. Copy each sentence "
        "EXACTLY as written, character for character, no edits, no ellipsis. If nothing fits, return an empty list. "
        'Return JSON: {"quotes": [{"quote": "...", "topic": "leads|stage|cheque|sector|geography", "page": 1}]}',
        corpus, temperature=0.0)
    quotes = []
    for q in (out or {}).get("quotes", []) if isinstance(out, dict) else []:
        text = str(q.get("quote", "")).strip()
        if not (25 <= len(text) <= 420):
            continue
        for pg in pages:
            if squash(text) in squash(pg["text"]):  # the quote must exist on the page, word for word
                quotes.append({"text": text, "topic": q.get("topic") if q.get("topic") in
                               ("leads", "stage", "cheque", "sector", "geography") else "stage", "url": pg["url"]})
                break
    order = {"leads": 0, "stage": 1, "cheque": 2, "sector": 3, "geography": 4}
    quotes.sort(key=lambda q: order[q["topic"]])
    base.update({"available": True, "quotes": quotes[:4], "model": GEMINI_MODEL if out is not None else None,
                 "reason": None if quotes else "No sentence about how it invests was found on its site."})
    blob_put(key, base)
    return {**base, "did": did}


# ---------------------------------------------------------------------------------------------- conflicts

async def conflicts(cala: Cala, lead: dict, company_id: str, about: str) -> dict:
    """Does this lead already back someone in your space? Gemini only points at portfolio names to open;
    what is shown about each one is Cala's own description and industries."""
    portfolio = lead.get("portfolio") or []
    mine = None
    if company_id:
        try:
            mine = await graph.company(cala, company_id)
        except CalaError:
            mine = None
    about_text = " ".join(x for x in [about, (mine or {}).get("description") or "",
                                      ", ".join(i["name"] for i in (mine or {}).get("industries", []))] if x).strip()
    base = {"lead": lead["name"], "portfolio_size": len(portfolio), "about": about_text, "company": mine and
            {"id": mine["id"], "name": mine["name"], "industries": mine["industries"], "description": mine["description"]},
            "checked": [], "overlaps": []}
    if not portfolio:
        return {**base, "available": False, "reason": "Cala lists no portfolio companies for this investor."}
    if not about_text:
        return {**base, "available": False, "reason": "Say what your company does, or pick it from Cala, to check for conflicts."}
    key = f"conflicts:{lead['id']}:{graph.norm(about_text)[:80]}"
    hit = blob_get(key, max_age=3 * 86400)
    if hit:
        return hit
    names = [c["name"] for c in portfolio]
    out = await gemini_json(
        "You help a founder check an investor's portfolio for possible competitors. Given what the founder's company does "
        "and a list of portfolio company names, return the names (exactly as listed, at most 6) that might operate in the same "
        'market. You are only choosing which ones to look up; do not describe them. Return JSON: {"names": ["..."]}',
        f"FOUNDER'S COMPANY: {about_text}\n\nPORTFOLIO:\n" + "\n".join(f"- {n}" for n in names), temperature=0.0)
    picked = [n for n in ((out or {}).get("names") or []) if n in names][:6] if isinstance(out, dict) else []
    my_inds = {i["name"].lower() for i in (mine or {}).get("industries", [])}

    async def open_one(name: str):
        c = next(x for x in portfolio if x["name"] == name)
        try:
            d = await graph.company(cala, c["id"])
        except CalaError:
            return None
        if not d:
            return None
        shared = sorted(i["name"] for i in d["industries"] if i["name"].lower() in my_inds)
        return {"id": d["id"], "name": d["name"], "description": d["description"], "website": d["website"],
                "industries": [i["name"] for i in d["industries"]], "shared_industries": shared,
                "stage": d["stage"], "sources": c["sources"]}

    opened = [o for o in await asyncio.gather(*(open_one(n) for n in picked)) if o]
    opened.sort(key=lambda o: -len(o["shared_industries"]))
    res = {**base, "available": True, "checked": opened, "overlaps": [o for o in opened if o["shared_industries"]],
           "model": GEMINI_MODEL if out is not None else None,
           "reason": None if opened else ("No portfolio company looked close enough to open." if out is not None
                                          else "Gemini is unavailable, so no portfolio company was opened."),
           "note": f"{len(portfolio)} portfolio companies in Cala. Gemini chose which to open; descriptions and industries are Cala's."}
    blob_put(key, res)
    return res


# ---------------------------------------------------------------------------------------------- ask cala

async def ask(cala: Cala, lead: dict, q: str) -> dict:
    """One answer from Cala's knowledge search, with its reasoning steps and the facts behind each."""
    question = q.strip() or f"What does {lead['name']} invest in, and which funding rounds has it led recently?"
    if lead["name"].lower() not in question.lower():
        question = f"{question} (about the investor {lead['name']})"
    try:
        d = await cala.call("POST", "/knowledge/search", body={"input": question})
    except BudgetExceeded:
        d = await cala.call("POST", "/knowledge/search", body={"input": question}, cache_only=True)
    if not d:
        return {"available": False, "question": question, "reason": "Cala gave no answer."}
    bits = {}
    for k in d.get("context") or []:
        origins = []
        for o in k.get("origins") or []:
            doc, src = o.get("document") or {}, o.get("source") or {}
            url = doc.get("url") or doc.get("endpoint") or src.get("url")
            if url:
                origins.append({"publisher": src.get("name") or doc.get("name") or re.sub(r"https?://(www\.)?([^/]+).*", r"\2", url),
                                "url": url})
        bits[k["id"]] = {"id": k["id"], "content": k.get("content"), "origins": origins[:3]}
    steps = [{"content": s.get("content"), "facts": [bits[r] for r in s.get("references", []) if r in bits]}
             for s in d.get("explainability") or []]
    return {"available": True, "question": question, "answer": d.get("content"), "steps": steps,
            "facts": len(bits), "entities": [{"id": e["id"], "name": e["name"]} for e in (d.get("entities") or [])[:12]]}


# ------------------------------------------------------------------------------------------ references

REFERENCE_COMPANIES = 4


async def references(cala: Cala, lead: dict) -> dict:
    """Founders this lead has already led: the people to call before you take its money.

    Every name comes from Cala with the page that names the person as founder or chief executive.
    """
    seen, picks = set(), []
    for d in lead.get("recent_leads") or []:
        co = d.get("issuer")
        if co and co.get("id") and co["id"] not in seen:
            seen.add(co["id"])
            picks.append(d)
    picks = picks[:REFERENCE_COMPANIES]

    async def one(d: dict):
        try:
            people = await graph.company_people(cala, d["issuer"]["id"])
        except BudgetExceeded:
            people = await graph.company_people(cala, d["issuer"]["id"], cache_only=True)
        except CalaError:
            people = None
        return {"company": d["issuer"], "round": {k: d.get(k) for k in ("id", "stage_name", "date", "amount", "currency")},
                "round_sources": (d.get("sources") or [])[:2], "people": (people or [])[:3]}

    rows = await asyncio.gather(*(one(d) for d in picks))
    named = [r for r in rows if r["people"]]
    return {"lead": lead["name"], "companies_checked": len(rows), "references": named,
            "unnamed": [r["company"]["name"] for r in rows if not r["people"]],
            "people": sum(len(r["people"]) for r in named)}


# ---------------------------------------------------------------------------------------------- slush

def _rich_text(node) -> str:
    """Slush stores descriptions as a rich-text tree; flatten it to plain text."""
    if isinstance(node, dict):
        return (node.get("text") or "") + " ".join(_rich_text(c) for c in node.get("content") or [])
    if isinstance(node, list):
        return " ".join(_rich_text(c) for c in node)
    return node if isinstance(node, str) else ""


async def slush_events() -> list[dict]:
    """Public Slush 2026 side-event listings, trimmed to what we show."""
    hit = blob_get("slush:events2", max_age=6 * 3600)
    if hit is not None:
        return hit
    try:
        r = await http().post(SLUSH_EVENTS_URL, json={"options": {"query": "", "page": {"size": 400}}}, timeout=30)
        data = r.json() if r.status_code == 200 else {}
    except (httpx.HTTPError, ValueError):
        data = {}
    items = data.get("results") or data.get("hits") or data.get("items") or []
    if isinstance(items, dict):
        items = items.get("hits") or items.get("items") or []
    out = []
    for ev in items:
        doc = ev.get("document") if isinstance(ev.get("document"), dict) else ev
        text = " ".join(_rich_text(v) for k, v in doc.items() if k not in ("logo", "title") and isinstance(v, (dict, list)))
        out.append({"id": doc.get("side_event_id") or doc.get("id"), "title": doc.get("title"), "start": doc.get("start_at"),
                    "end": doc.get("end_at"), "venue": doc.get("location"), "host": doc.get("company_name"),
                    "industry": doc.get("primary_industry"), "text": re.sub(r"\s+", " ", text)[:8000]})
    if out:
        blob_put("slush:events2", out)
    return out


_firms: dict[str, dict] | None = None


async def slush_firms() -> dict[str, dict]:
    """Investor firms registered for Slush 2026, read through the Slush MCP (read-only) and kept for 12 hours."""
    global _firms
    if _firms is not None:
        return _firms
    hit = blob_get("slush:firms", max_age=12 * 3600)
    if hit is None and slush_mcp.ready():
        try:
            hit = await slush_mcp.investors()
            if hit:
                blob_put("slush:firms", hit)
        except (slush_mcp.SlushError, httpx.HTTPError, ValueError, KeyError):
            hit = blob_get("slush:firms")  # a stale list beats none
    _firms = hit or {}
    return _firms


def at_slush(name: str) -> dict | None:
    """Head count and job titles of this investor's people in the Slush attendee directory. No names."""
    m = slush_mcp.match(_firms or {}, name)
    if not m:
        return None
    titles = []
    for p in m["people"]:
        t = re.sub(r"\s+(at|@)\s+.*$", "", p.get("title") or "", flags=re.I).strip(" ,")
        if t and t not in titles:
            titles.append(t)
    return {"firm": m["firm"], "people": len(m["people"]), "titles": titles[:4]}


def slush_directory() -> dict:
    return {"connected": slush_mcp.ready(), "firms": len(_firms or {}),
            "people": sum(len(f["people"]) for f in (_firms or {}).values())}


async def slush(lead: dict) -> dict:
    """Is this lead at Slush 2026? The attendee directory (Slush MCP) and public side events it hosts or is named in."""
    events = await slush_events()
    await slush_firms()
    name = lead["name"]
    pat = re.compile(r"(?<![a-z0-9])" + r"[\s.-]*".join(re.escape(w) for w in name.lower().split()) + r"(?![a-z0-9])")
    found = []
    for ev in events:
        host = (ev.get("host") or "")
        if graph.norm(host) == lead["key"] or pat.search(host.lower()):
            found.append({**{k: ev[k] for k in ("id", "title", "start", "end", "venue", "host")}, "role": "host", "snippet": None})
            continue
        hay = f"{ev.get('title') or ''} . {ev.get('text') or ''}"
        m = pat.search(hay.lower())
        if m:
            a, b = max(0, m.start() - 90), min(len(hay), m.end() + 90)
            found.append({**{k: ev[k] for k in ("id", "title", "start", "end", "venue", "host")}, "role": "named",
                          "snippet": ("…" if a else "") + hay[a:b].strip() + ("…" if b < len(hay) else "")})
    found.sort(key=lambda f: (f["role"] != "host", f["start"] or ""))
    return {"lead": name, "events_checked": len(events), "events": found[:5],
            "attending": at_slush(name), "directory": slush_directory(),
            "slush": {"starts": "2026-11-18", "ends": "2026-11-19", "days_away": (date(2026, 11, 18) - date.today()).days},
            "meeting_tool": {"note_limit": 300, "slot_minutes": 25},
            "source": {"publisher": "slush.org", "url": "https://slush.org/side-events"}}
