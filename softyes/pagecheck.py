"""Re-read the page Cala cites for a lead and find the sentence that says so.

Cala marks an investor as the lead of a round and cites pages for it. A citation is not a check: the page may name
the investor without calling it the lead, or be about another round. This module opens the page, looks for the
investor's name next to a word for leading, and returns that sentence word for word. No language model is used:
it is text matching, so a quote shown here is on the page.
"""
from __future__ import annotations

import asyncio
import math
import re
import time

import httpx

from . import extras, graph

# "led", in the languages the pages Cala cites for European rounds are written in
LEAD_WORDS = re.compile(
    r"(?<![\w-])(led|co-?led|leads?|co-?leads?|leading|co-?leading|lead investors?|spearheaded|headed|anchored|"
    r"johti|johtama|johtamaan|johtamassa|johdolla|pääsijoittaja\w*|vetämä\w*|"
    r"angeführt|anführung|führte|führt|lead-?investor\w*|"
    r"liderad[ao]s?|lideró|lidera|encabezad[ao]|"
    r"menée?s?|mené|mène|emmenée?s?|dirigée?s?|chef de file|"
    r"leds av|ledd av|ledet af|ledet av|ledde|leder|anført af|"
    r"guidat[oa]|geleid|aangevoerd)(?![\w-])", re.I)
UNREADABLE = re.compile(r"(^|\.)(linkedin|twitter|x|facebook|instagram|crunchbase|pitchbook|cbinsights|dealroom|tracxn|youtube)\.", re.I)
BROWSER = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36",
           "Accept": "text/html,application/xhtml+xml", "Accept-Language": "en,fi;q=0.8,de;q=0.6"}
GATE = asyncio.Semaphore(16)
# the day a page says it was published, from its own markup
PUBLISHED = re.compile(r"""(?:article:published_time|og:published_time|datePublished|date_published|publish_date|pubdate)"""
                       r"""["'\s:=>]{1,12}(?:content=)?["']?((?:19|20)\d\d-\d\d-\d\d)""", re.I)
_plain: httpx.AsyncClient | None = None


def _client() -> httpx.AsyncClient:
    global _plain
    if _plain is None:
        _plain = httpx.AsyncClient(timeout=10, follow_redirects=True, headers=BROWSER, limits=httpx.Limits(max_connections=40))
    return _plain


async def page(url: str) -> dict:
    """{text, status} for one page. A plain request first; Oxylabs when the site refuses it. Kept once read."""
    key = "pagetext2:" + url
    hit = extras.blob_get(key)
    if hit and (hit["text"] or time.time() - hit.get("at", 0) < 3600):
        return hit
    host = re.sub(r"^https?://([^/]+).*", r"\1", url)
    out = {"text": "", "status": "unread", "at": time.time()}
    if UNREADABLE.search(host) or url.lower().endswith(".pdf"):
        out["status"] = "not readable"
    else:
        async with GATE:
            try:
                r = await _client().get(url)
                if r.status_code == 200 and "html" in r.headers.get("content-type", "html"):
                    text = extras.page_text(r.text[:1_500_000])
                    if len(text) > 400:
                        m = PUBLISHED.search(r.text[:400_000])
                        out = {"text": text[:80000], "status": "read", "at": time.time(), "published": m.group(1) if m else None}
                elif r.status_code in (404, 410):
                    out["status"] = "gone"
            except (httpx.HTTPError, UnicodeError, ValueError):
                pass
            if not out["text"] and out["status"] != "gone" and extras.oxylabs_ready():
                try:
                    got = await asyncio.wait_for(extras.scrape(url), 40)
                    if len(got.get("text") or "") > 400:
                        out = {"text": got["text"][:80000], "status": "read", "at": time.time()}
                except (asyncio.TimeoutError, httpx.HTTPError):
                    pass
    extras.blob_put(key, out)
    return out


ENDINGS = {"group", "holdings", "holding", "se", "ic", "sca", "sicav", "sicar", "raif", "gp", "associates", "company",
           "i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x", "1", "2", "3", "4", "5", "6", "7", "8", "9"}
SPELLED = {"one": "1", "two": "2", "three": "3", "four": "4", "five": "5", "six": "6", "seven": "7", "eight": "8", "nine": "9",
           "ten": "10"}
DIGITS = {v: k for k, v in SPELLED.items()}


LEGAL_FIRST = re.compile(r"^(UAB|OÜ|SIA|AS|AB|Oy|SAS|SA|GmbH)\s+(?=\S)")


def variants(name: str) -> list[str]:
    """Ways a page may write the investor: the full name, and the name without its fund or company words when what
    is left is distinctive ('Lifeline', 'Ten Eleven', 'Goldman Sachs'), never a common word ('World', 'True')."""
    name = re.sub(r"\s*\(.*?\)\s*", " ", name)
    name = re.sub(r"\s+gesellschaft mit beschränkter haftung\b.*$", "", name, flags=re.I).strip()
    bare = LEGAL_FIRST.sub("", name).strip()   # 'UAB Contrarian Ventures' is written 'Contrarian Ventures'
    out = [name] + ([bare] if bare and bare != name and len(bare.split()) > 1 else [])
    words = (bare if len(out) > 1 else name).split()
    while len(words) > 1 and graph.norm(words[-1]) in graph.FUND_WORDS | graph.LEGAL | graph.TAIL | ENDINGS:
        words = words[:-1]
        rest = " ".join(words)
        if len(words) > 1 or (len(rest) >= 6 and rest.lower() not in graph.GENERIC_BASE):
            out.append(rest)
    typed, key = re.sub(r"[^a-z0-9]", "", name.lower()), graph.norm(name)
    if typed in graph.FULL_OF:   # "NEA" on Cala's side, "New Enterprise Associates" on the page, or the other way round
        out.append(graph.FULL_OF[typed])
    out += [short if short == "a16z" else short.upper() for short, full in graph.FULL_OF.items()
            if graph.norm(full) == key and short != typed]
    return list(dict.fromkeys(out))


def _pattern(phrase: str) -> re.Pattern:
    """The phrase as pages write it: 'Larsen And Toubro' is 'Larsen & Toubro', 'Episode One' is 'Episode 1'."""
    parts = []
    for w in re.split(r"[\s\-.]+", phrase):
        low = w.lower()
        if not w:
            continue
        if low in ("and", "&"):
            parts.append(r"(?:and|&|\+)")
        elif low in SPELLED or low in DIGITS:
            parts.append(rf"(?:{re.escape(w)}|{SPELLED.get(low) or DIGITS[low]})")
        else:
            parts.append(re.escape(w))
    return re.compile(r"(?<![\w])" + r"[\s\-.]*".join(parts) + r"(?![\w])", re.I)


def _find(text: str, phrase: str) -> list[int]:
    return [m.start() for m in _pattern(phrase).finditer(text)]


BREAK = re.compile(r"(?<=[a-zäöåéü0-9)\]\"”’%€$]{2})[.!?]\s+(?=[A-ZÄÖÅÉÜ\"“(\[0-9])|\n")


# A full stop after one of these does not end a sentence: "Oct. 28, 2026", "Calif. — Nominal", "Inc. The round".
ABBR = re.compile(r"(?<![\w])(?:jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec|calif|mass|wash|inc|corp|ltd|co|no|st|vs|approx|est|mr|ms|dr)$", re.I)


SPACED = re.compile(r"[ \t]+([,.;])(?=[ \t\n]|$|[\"”’)])")


def tidy(text: str) -> str:
    """A page's markup leaves a space before a comma or a full stop ('led by <a>Sofina</a> , the'): the reader never sees it."""
    text = re.sub(r"[ \t]*(?:<!--|--+>)[ \t]*", " ", text or "")   # what is left of a comment in the page's markup
    return re.sub(r"(?<=s) (['’])(?= )", r"\1", SPACED.sub(r"\1", text))   # "Menlo Ventures ' Anthology fund"


def _breaks(text: str, lo: int, hi: int):
    for m in BREAK.finditer(text, lo, hi):
        if text[m.start()] == "." and ABBR.search(text[max(lo, m.start() - 8):m.start()]):
            continue
        yield m


def _sentence(text: str, at: int) -> tuple[int, int]:
    """The sentence around text[at]. 'U.S. Investor', 'Inc. said' and 'Oct. 28' do not end one."""
    lo, start = max(0, at - 700), max(0, at - 700)
    for m in _breaks(text, lo, at):
        start = m.end()
    m = next(_breaks(text, at, min(len(text), at + 700)), None)
    end = m.start() + 1 if m else min(len(text), at + 700)
    for _ in range(3):   # a line break in the middle of a sentence: "The round\nwas led by X, with existing\ninvestors"
        if start > lo and text[start - 1] == "\n" and text[start:start + 1].islower():
            prev = lo
            for m in _breaks(text, lo, start - 1):
                prev = m.end()
            start = prev
        elif end < len(text) and text[end - 1:end] == "\n" and text[end:end + 40].lstrip()[:1].islower():
            m = next(_breaks(text, end, min(len(text), end + 400)), None)
            end = m.start() + 1 if m else min(len(text), end + 400)
        else:
            break
    return start, end


# A word for leading that takes the leader after it ("led by X", "lead investor X", "johti X") ...
LED_BY = re.compile(
    r"(?<![\w-])(?:(?:co-?)?led|spearheaded|headed|anchored|angeführt|liderad[ao]s?|encabezad[ao]s?|menée?s?|emmenée?s?|dirigée?s?|"
    r"guidat[oa]|geleid|aangevoerd|leds|ledd|ledet|anført)\s+(?:jointly\s+|together\s+|primarily\s+|mainly\s+|largely\s+|again\s+|once again\s+)?(?:by|von|vom|por|par|av|af|da|door)\b"
    r"|(?<![\w-])angeführt\s+(?:wird|wurde|wurden)\s+die\s+[\wäöüß-]+\s+(?:von|vom)\b"
    r"|(?<![\w-])(?:co-?)?lead[- ]?investors?(?:\s+(?:is|are|was|were|in the round (?:is|was)))?\s*[:,]?"
    r"|(?<![\w-])(?:pääsijoittaja(?:na|t)?(?:\s+(?:on|oli|toimii|toimi))?|kierrosta johti|kierroksen johti|johti|vetäjänä(?:\s+toimi)?)(?![\w-])"
    r"|(?<![\w-])chef de file\s*[:,]?", re.I)
# ... and one the leader comes before ("X led", "X leads the round", "X as lead investor").
LEADS_AFTER = re.compile(
    r"^(?:\s*\([^)]{0,50}\))?,?\s*(?<![\w-])(?:(?:has|have|had|also|again|is|are|was|were|will|which|who|that|today|now)\s+){0,3}"
    r"(?:(?:thrilled|proud|excited|delighted|pleased|happy|honou?red)\s+(?=to\s+(?:have\s+|be\s+)?(?:co-?)?(?:led|lead|leading)\b))?"
    r"(?:to have (?:co-?)?led|to be (?:co-?)?leading|to (?:co-?)lead|(?:co-?)?led|(?:co-?)?leads|(?:co-?)?leading|to lead|will lead|lead(?= (?:the|a|an|its|this|that|\S+['’]s))|spearheaded|spearheads|anchored|"
    r"as (?:the |a )?(?:sole |co-?)?leads?(?: investors?)?|\((?:co-?)?lead(?: investor)?\)|johtaa|johti|toimi(?:i)? pääsijoittajana|"
    r"führt|führte|lidera|lideró|mène|a mené)(?![\w-])", re.I)
# Where the list of leaders ends and the rest of the syndicate begins.
STOP = re.compile(
    r"(?<![\w-])(?:with participation|participation from|participation by|with (?:additional |further |strong )?(?:support|backing|investments?|contributions?)|as well as|in addition to|"
    r"joined by|and joined|alongside|along with|together with|followed by|including|included|includes|"
    r"(?:and\s+|,\s*)?(?:supported|backed|accompanied|complemented|rounded out|topped up|bolstered|joined) by|"
    r"with (?:the )?(?:support|backing|participation|involvement) (?:of|from)|saw participation|"
    r"other investors|also participat\w+|additional investment|while|whereas|mukana|osallistui\w*|lisäksi|sekä kierrokseen|"
    r"beteiligt\w*|unter beteiligung|con la participación|avec la participation|aux côtés|med deltagande)(?![\w-])"
    r"|,?\s+with\b|,\s*(?:and\s+)?existing investors?\b|[;:!?]", re.I)
PASSIVE = re.compile(r"\s+(?:by|von|vom|por|par|av|af|da|door)\b", re.I)
JOINING = re.compile(r"(?<![\w-])(?:participat\w+|joined|joins|joining|to join|invested|invests|to invest|backed|backs|supported|took part|osallistu\w+|mukana)(?![\w-])", re.I)


# The name opens a list of leaders: "A (a16z), B and C co-led the round".
LIST_LEADS = re.compile(
    r"^(?:\s*\([^)]{0,50}\))?(?:\s*,\s*(?:the\s+)?[A-Z0-9][^,.;:()]{1,60}?(?:\s*\([^)]{0,50}\))?){0,4}\s*,?\s+(?:and|&|ja|und|et|e|y|och|og)\s+"
    r"(?:the\s+)?[A-Z0-9][^,.;:]{1,70}?\s+(?:(?:have|has|had|jointly|together|both|all)\s+){0,2}"
    r"(?:co-?led|co-?lead|led|lead|are leading|are co-?leading|johtivat|as (?:the )?(?:co-?)?leads?(?: investors?)?)(?![\w-])")


# After the name: it is the subject of a joining verb, alone or in a list ("led by A, and B joined", "led by A. B, C and D participated").
JOINS_AFTER = re.compile(
    r"^(?:\s+[A-Z][\w&.'’-]*){0,3}(?:\s*\([^)]{0,50}\))?(?:\s*,\s*(?:the\s+)?[A-Z0-9][^,.;:()]{1,60}?(?:\s*\([^)]{0,50}\))?){0,5}"
    r"(?:\s*,?\s+(?:and|&|as well as|ja|und|et|y|och|og)\s+(?:the\s+)?[A-Z0-9][^,.;:]{1,70}?)?\s*,?\s+"
    r"(?i:(?:(?:have|has|had|also|both|all|each|will|is|are|was|were|again)\s+){0,3}"
    r"(?:participat(?:ed|es|e|ing)|joined|joins|joining|invested|invests|investing|took part|followed|came in|contributed|supported|backed|"
    r"osallistui\w*|beteiligten sich))(?![\w-])(?!\s+(?:by|von|av|af)\b)")


AS_LEAD = re.compile(r"(?<![\w-])as\s+(?:(?:the|a|an|its|their|sole)\s+)?(?:[\w-]+\s+){0,2}$", re.I)
INVESTORS_SUCH_AS = re.compile(r"^\s*(?:its\s+|the\s+)?(?:existing|new|returning|current|previous)\s+investors?,?\s+(?:including|such as|like)\s+", re.I)


def _says_led(sent: str, at: int, end: int) -> bool:
    """Does this sentence say the name at sent[at:end] led? The leading word has to attach to the name itself:
    'led by A and joined by B' makes A the lead, not B, and 'B joined the round led by A' does not make B one."""
    rest = sent[end:end + 110]
    m = LEADS_AFTER.match(rest)
    if m and not PASSIVE.match(rest[m.end():]) and not STOP.search(rest[:m.end()]) and not JOINING.search(rest[:m.end()]):
        return True
    m = LIST_LEADS.match(sent[end:end + 260])
    if m and not PASSIVE.match(sent[end + m.end():]) and not STOP.search(m.group()) and not JOINING.search(m.group()):
        return True
    if JOINS_AFTER.match(sent[end:end + 260]):   # "led by A, and B joined": B is named after the leading word, as one who joined
        return False
    for m in LED_BY.finditer(sent[:at]):
        if "investor" in m.group().lower() and AS_LEAD.search(sent[:m.start()]):
            continue   # "A as the German lead investor, B and C": the word belongs to A, before it
        seg = INVESTORS_SUCH_AS.sub(" ", sent[m.end():at])   # "led by existing investors including A, B"
        if not STOP.search(seg) and at - m.end() < 220:
            return True
    return False


def _says_followed(sent: str, at: int, end: int) -> bool:
    """Does this sentence name someone else as the lead and this name among the rest of the round?"""
    for m in LEAD_WORDS.finditer(sent[:at]):
        if STOP.search(sent[m.end():at]):
            return True
    if LEAD_WORDS.search(sent[:at]) and JOINS_AFTER.match(sent[end:end + 260]):   # 'A led the round, and B participated'
        return True
    rest = sent[end:end + 160]   # 'B joined the round led by A'
    m = JOINING.search(rest)
    return bool(m and LED_BY.search(rest[m.end():]))


def _spans(text: str, phrase: str) -> list[tuple[int, int]]:
    return [(m.start(), m.end()) for m in _pattern(phrase).finditer(text)]


EARLIER = re.compile(r"(?<![\w-])(?:last year|a year ago|years? ago|previously|previous (?:round|funding|financing|raise)|earlier round|prior round|back in|"
                     r"aiemmin|viime vuonna|edellise\w+|zuvor|l'an dernier|el año pasado)(?![\w-])", re.I)


def _other_round(sent: str, stage: str | None, year: str | None) -> bool:
    """Is this sentence about some other round of the company: another stage, another year, or 'last year'?"""
    said = stages_on_page(sent)
    if stage in STAGES_ON_PAGE and said and stage not in said:
        return True
    years = set(re.findall(r"(?<!\d)(?:19|20)\d\d(?!\d)", sent))
    if year and years and year not in years and str(int(year) - 1) not in years and str(int(year) + 1) not in years:
        return True
    return bool(EARLIER.search(sent))


ROUND_IN = re.compile(r"(?:round|investment|funding|financing|raise|seed|series [a-h])\s+(?:in|of|for|into)\s+"
                      r"((?:[A-Z][\w&.'’-]*)(?:\s+[A-Z][\w&.'’-]*){0,3})")
NOT_A_COMPANY = re.compile(r"^(?:january|february|march|april|may|june|july|august|september|october|november|december|q[1-4]|"
                           r"europe|finland|sweden|norway|denmark|germany|france|spain|italy|the|its|this|a|an|"
                           r"london|berlin|paris|helsinki|stockholm|asia|africa|america|india|china|japan|israel|"
                           r"uk|us|usa|eu|ai|new|north|south|latin|silicon|series|seed|pre)\b", re.I)


def _other_company(sent: str, company: str | None) -> bool:
    """'Cherry Ventures leads a €6M round in Marble Imaging' on a page about Heywa Labs: a teaser for another deal.
    True when the sentence says whose round it is, and it is not this company's."""
    if not company or any(_find(sent, k) for k in company_keys(company)):
        return False
    return any(not NOT_A_COMPANY.match(m.group(1)) for m in ROUND_IN.finditer(sent))


def read(text: str, investor: str, company: str | None = None, stage: str | None = None, year: str | None = None) -> dict:
    """What the page says about `investor`, and the sentence it rests on. status:
    lead      the page says it led            follower  the page names another lead and lists it in the round
    named     named, no word on who led       absent    not on the page"""
    text = tidy(text)
    hits = sorted({sp for v in variants(investor) for sp in _spans(text, v)})
    if not hits:
        return {"status": "absent", "quote": None}
    best = under = None
    for at, end in hits:
        a, b = _sentence(text, at)
        if b - a > 700:   # a page without sentence breaks: a window around the name
            a, b = max(a, at - 260), min(b, end + 260)
        sent = text[a:b]
        # a sentence about an earlier round, or about another company's round, proves nothing about this one
        other = _other_round(sent, stage, year) or _other_company(sent, company)
        led = not other and _says_led(sent, at - a, end - a)
        followed = not other and not led and _says_followed(sent, at - a, end - a)
        score = (4 if led else 2 if followed else 0) + (1 if company and _find(sent, company_key(company)) else 0) + \
            (1 if LEAD_WORDS.search(sent) else 0) + (1 if LED_BY.search(sent[:at - a]) else 0)
        if best is None or score > best[0]:
            best = (score, sent, "lead" if led else "follower" if followed else "named", at - a)
        if followed and (under is None or score > under[0]):
            under = (score, sent, at - a)
    _, sent, led, at = best
    quote = _trim(sent, at)
    if led != "lead" and len(quote) < 45:
        quote = None   # a bare name in a list or a footer says nothing
    out = {"status": led, "quote": quote}
    if under and led == "lead":
        out["listed"] = _trim(under[1], under[2])   # another sentence lists it under someone else's lead
    return out


CHROME = re.compile(r"^(?:skip to (?:main )?content|jump to content|toggle navigation|menu|search)\b[\s:|·-]*", re.I)


def _trim(sent: str, at: int) -> str:
    """The sentence as it reads on the page: at most 330 characters around the name, cut between words, without the
    spaces a page's markup leaves before a comma or a full stop, and without a 'Skip to content' link in front."""
    lead_in = len(sent) - len(sent.lstrip())
    sent, at = sent.strip(), max(0, at - lead_in)
    m = CHROME.match(sent)
    if m and m.end() <= at:
        sent, at = sent[m.end():], at - m.end()
    if len(sent) > 330:
        a = max(0, at - 170)
        if a:
            sp = sent.find(" ", a, at)   # cut between words, never inside one
            a = sp + 1 if sp >= 0 else a
        # the word that makes it a lead claim stays in the quote, even when it sits far before the name
        said = [m.start() for m in LED_BY.finditer(sent[:at]) if at - m.end() < 220]
        if said and said[-1] < a:
            a = said[-1]
        b = max(a + 320, min(len(sent), at + 110))
        if b < len(sent):
            sp = sent.rfind(" ", a, b)
            b = sp if sp > at else b
        body = sent[a:b].strip()
        if a:
            body = body.lstrip(" ,.;:)–—-")
        sent = ("… " if a else "") + body + (" …" if b < len(sent) else "")
    sent = re.sub(r"\s+", " ", sent)
    # a byline or a share link glued on after the full stop ("... infrastructure. by") is not part of the sentence
    sent = re.sub(r"(?<=[.!?”\"])\s+(?:by|share|read more|more|tags?|source|photo)\s*:?$", "", sent, flags=re.I)
    return re.sub(r" ([,.;])(?= |$|[\"”’)])", r"\1", sent)


def company_key(company: str) -> str:
    return re.sub(r"\.(io|ai|com|fi|vc|co|app)$", "", re.sub(r"\s+(oy|oyj|ab|ltd|inc|gmbh|as|sas|bv)\.?$", "", company.strip(), flags=re.I), flags=re.I)


TAILS = ("labs", "ai", "hq", "app", "tech", "health", "technologies")
COMMON_FIRST = {"the", "nord", "nordic", "open", "first", "new", "blue", "green", "smart", "digital", "global", "north", "data"}


def company_keys(company: str) -> list[str]:
    """Ways a page may write the company: 'Redpine Technology' is 'Redpine' in the article about it."""
    key = company_key(company)
    out = [company, key]
    first = re.split(r"[\s.]+", key)[0]
    if len(first) >= 5 and first.lower() not in COMMON_FIRST:
        out.append(first)
    if len(key) >= 4 and " " not in key.strip():   # 'Measur' is 'Measurlabs' on its own blog, 'Verda' is 'Verda AI'
        out += [f"{key} {tail}" for tail in TAILS]
    bare = re.sub(rf"\s+(?:{'|'.join(TAILS)})$", "", key, flags=re.I)   # and the other way: 'Cala AI' is 'Cala' in the press
    if bare != key and len(bare) >= 4 and bare.lower() not in COMMON_FIRST:
        out.append(bare)
    return list(dict.fromkeys(out))


def amount_on_page(text: str, amount: float) -> bool:
    """Is this amount written on the page? '2.5 million', '2,5 M€', 'EUR 2.5m', '150,000', '150k'."""
    def num(x: float) -> str:
        s = f"{x:.2f}".rstrip("0").rstrip(".")
        whole, _, frac = s.partition(".")
        return re.escape(whole) + (rf"[.,]{frac}\d?" if frac else r"(?:[.,]0)?")
    pats = []
    near = {round(amount, -int(math.floor(math.log10(amount))) + d) for d in (0, 1, 2)} if amount > 0 else set()
    for a in sorted(x for x in near if x != amount and abs(x - amount) / amount <= 0.02):
        if _amount_pats(a, num, text):   # 59,749,995 in a filing is "$60M" in the announcement
            return True
    return _amount_pats(amount, num, text)


def _amount_pats(amount: float, num, text: str) -> bool:
    pats = []
    if amount >= 1e9:
        pats.append(num(amount / 1e9) + r"\s*-?\s*(?:b\b|bn\b|billion|miljard|mrd|milliard)")
    if amount >= 1e6:
        pats.append(num(amount / 1e6) + r"\s*-?\s*(?:m\b|mn\b|mm\b|mio|mill|milj|m€|m\$|meur|musd|msek|mnok|mdkk|mgbp|me\b)")
        pats.append(num(amount / 1e3) + r"\s*-?\s*(?:k\b|t€|tuhat|thousand)")
    else:
        pats.append(num(amount / 1e3) + r"\s*-?\s*(?:k\b|t€|tuhat|thousand|000\b)")
        pats.append(num(amount / 1e6) + r"\s*-?\s*(?:m\b|mn\b|mio|mill|milj|m€|meur|musd)")
    digits = f"{int(amount):,}"
    pats.append(r"[.,\s ]".join(re.escape(g) for g in digits.split(",")))
    return any(re.search(r"(?<![\d.,])" + p, text, re.I) for p in pats)


STAGES_ON_PAGE = {
    "PRE_SEED": r"pre-?\s?seed", "SEED": r"(?<!pre-)(?<!pre)(?<!pre )\bseed\b|siemenrahoitus|siemenvaihe",
    "SERIES_A": r"\bs[eé]ries?[\s-]?a\b|\b(?:an|the|its|our|their)\s+(?-i:A)[- ]round\b|\ba-kierros|\ba-sarjan",
    "SERIES_B": r"\bs[eé]ries?[\s-]?b\b|\b(?:a|the|its|our|their)\s+(?-i:B)[- ]round\b|\bb-kierros",
    "SERIES_C": r"\bs[eé]ries?[\s-]?c\b|\b(?:a|the|its|our|their)\s+(?-i:C)[- ]round\b", "SERIES_D": r"\bs[eé]ries?[\s-]?d\b",
    "SERIES_E": r"\bs[eé]ries?[\s-]?e\b", "SERIES_F": r"\bs[eé]ries?[\s-]?f\b",
}
ALSO = re.compile(r"(?:also|previously|earlier|who|which|that|had)\s+$", re.I)


def stages_at_lead(sent: str) -> list[str]:
    """Stage labels that sit on the leading phrase itself: 'a pre-seed round led by X', 'X leads the Series A'.
    A stage named elsewhere in the sentence ('…, following its seed round') says nothing about which round X led."""
    out = []
    for key, pat in STAGES_ON_PAGE.items():
        for m in re.finditer(pat, sent, re.I):
            after = sent[m.end():m.end() + 70]
            lead = LEAD_WORDS.search(after)
            if lead and not STOP.search(after[:lead.start()]) and not re.search(r"[.;]", after[:lead.start()]):
                out.append(key)
                break
            before = sent[max(0, m.start() - 45):m.start()]
            verb = None
            for verb in re.finditer(r"(?<![\w-])(?:co-?)?(?:led|leads|leading|lead)\s+(?:(?:the|a|an|its|our|their|this)\s+)?(?:[\w€$£.,-]+\s+){0,4}$", before, re.I):
                pass
            if verb and not ALSO.search(sent[max(0, m.start() - 45 - 12):max(0, m.start() - 45) + verb.start()]):
                out.append(key)
                break
    return out


def stages_on_page(text: str) -> list[str]:
    return [k for k, pat in STAGES_ON_PAGE.items() if re.search(pat, text, re.I)]


# ---------------------------------------------------------------------------------------- one round

NEAR_DAYS = 150   # a page dated further than this from the round is about some other event


def _near(src: dict, when: str | None) -> bool:
    if not when or not src.get("date"):
        return True
    try:
        from datetime import date
        return abs((date.fromisoformat(src["date"][:10]) - date.fromisoformat(when[:10])).days) <= NEAR_DAYS
    except ValueError:
        return True


def pick_pages(rd: dict, limit: int = 4) -> list[dict]:
    """The pages to re-read for a round: one cited for each lead Cala names, one cited for the amount, primary first."""
    when = rd.get("date")
    out: dict[str, dict] = {}

    def take(srcs: list[dict], n: int = 1, near: bool = True) -> None:
        good = sorted((x for x in srcs if (not near or _near(x, when)) and not x["url"].lower().endswith((".pdf", ".xml"))
                       and not UNREADABLE.search(re.sub(r"^https?://([^/]+).*", r"\1", x["url"]))),
                      key=lambda x: (not _near(x, when), x.get("rank") != "PRIMARY", x.get("rank") == "AGGREGATOR",
                                     x.get("rank") == "FILING"))
        for x in good[:n]:
            out.setdefault(x["url"], x)

    leads = [i for i in rd.get("investors", []) if i.get("is_lead")][:4]
    for i in leads:   # a lead's own pages count even when dated far from the round: Cala may hold two events as one
        take(i.get("sources") or [], near=False)
    take([x for x in rd.get("sources") or [] if "amount" in (x.get("backs") or [])])
    take(rd.get("sources") or [], 2)
    for i in leads:
        take(i.get("sources") or [], 2, near=False)
    return list(out.values())[:limit]


async def check_round(rd: dict) -> dict:
    """Re-read the pages cited for one round. Returns what they say:
    leads   {investor key: {quote, url, publisher}}   investors a page says led the round
    followers, mentions: the same shape, for investors a page lists under another lead, or only names
    named   [investor keys]                           investors a page names
    read    how many pages were read and are about this company
    amount  True/False/None   is the amount Cala gives written on one of them
    stages  stage labels the pages use
    """
    company = (rd.get("issuer") or {}).get("name")
    srcs = pick_pages(rd)
    pages = await asyncio.gather(*(page(x["url"]) for x in srcs))
    out = {"id": rd["id"], "tried": len(srcs), "read": 0, "off_topic": 0, "leads": {}, "followers": {}, "mentions": {},
           "named": [], "also_named": [], "amount": None, "stages": [], "headline": [], "pages": [], "published": {}, "dated": {},
           "page_stages": {}}
    for src, pg in zip(srcs, pages):
        text = tidy(pg["text"])
        if not text:
            out["pages"].append({"url": src["url"], "publisher": src.get("publisher"), "status": pg["status"]})
            continue
        if company and not any(_find(text, k) for k in company_keys(company)):
            out["off_topic"] += 1
            out["pages"].append({"url": src["url"], "publisher": src.get("publisher"), "status": "other company"})
            continue
        out["read"] += 1
        out["pages"].append({"url": src["url"], "publisher": src.get("publisher"), "status": "read"})
        if pg.get("published"):
            out["published"][src["url"]] = pg["published"]
        on_page = stages_on_page(text)
        out["page_stages"][src["url"]] = on_page
        if pg.get("published") or src.get("date"):
            out["dated"][src["url"]] = (pg.get("published") or src["date"])[:10]
        for i in rd.get("investors", []):
            key = graph.norm(i["name"])
            # which round a sentence is about is settled across all the round's pages, by the caller
            got = read(text, i["name"], company, None, (rd.get("date") or "")[:4] or None)
            if got["status"] == "absent":
                continue
            if key not in out["named"]:
                out["named"].append(key)
            book = {"lead": "leads", "follower": "followers", "named": "mentions"}[got["status"]]
            if got["quote"]:
                out[book].setdefault(key, {"quote": got["quote"], "url": src["url"], "publisher": src.get("publisher")})
            if got.get("listed"):
                out["followers"].setdefault(key, {"quote": got["listed"], "url": src["url"], "publisher": src.get("publisher")})
        for key, name in rd.get("look_for") or []:   # the investors who said yes: does a page name them in this round?
            if key not in out["also_named"] and any(_spans(text, v) for v in variants(name)):
                out["also_named"].append(key)
        if rd.get("amount"):
            out["amount"] = bool(out["amount"]) or amount_on_page(text, rd["amount"])
        for st in on_page:
            if st not in out["stages"]:
                out["stages"].append(st)
        for st in stages_on_page(text[:260]):   # the headline: the label the page itself gives this round
            if st not in out["headline"]:
                out["headline"].append(st)
    return out


LATE: set[asyncio.Task] = set()


async def check_rounds(rounds: list[dict], seconds: float) -> dict[str, dict]:
    """Check many rounds at once, for at most `seconds`. A page that is slow is left to finish in the background:
    it is kept once read, so the next walk has it."""
    tasks = {rd["id"]: asyncio.create_task(check_round(rd)) for rd in rounds}
    if not tasks:
        return {}
    # Most pages answer in a few seconds. Once nearly all are in, do not hold the walk for the last slow ones.
    done, late = await asyncio.wait(tasks.values(), timeout=min(seconds, 6))
    if len(late) > max(1, len(tasks) // 8):
        done, late = await asyncio.wait(tasks.values(), timeout=max(0.1, seconds - 6))
    for t in late:
        LATE.add(t)
        t.add_done_callback(LATE.discard)
    return {rid: t.result() for rid, t in tasks.items() if t in done and not t.exception()}


def pending() -> int:
    return len(LATE)


async def settle(seconds: float = 60) -> None:
    """Wait for pages still being read in the background."""
    if LATE:
        await asyncio.wait(list(LATE), timeout=seconds)
