"""Soft Yes as an MCP server, so a founder's own assistant can gather the round.

One endpoint, POST /mcp, speaking JSON-RPC as MCP's streamable HTTP transport allows: a plain JSON reply per request,
no session. The tools return text for the assistant and, for hosts that draw MCP Apps (SEP-1865), the data for a card
drawn inside the chat: the walk, the network, the draft, the round and the claim check. One HTML resource draws them all.
Everything is the same sourced Cala data the web app shows; the text is assembled in code, never by a language model.
"""
from __future__ import annotations

import asyncio
import os
import pathlib
import re
import secrets
import time
from typing import Awaitable, Callable

from . import chat, extras, graph, scout, walk

PUBLIC_URL = os.environ.get("SOFTYES_PUBLIC_URL", "https://soft-yes.fly.dev").rstrip("/")
VERSIONS = ("2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05")
STAGES = ["PRE_SEED", "SEED", "SERIES_A", "SERIES_B", "SERIES_C"]


def _stage_code(v) -> str | None:
    """'Series A', 'series-a' and 'SERIES_A' are one stage to the person asking."""
    code = re.sub(r"[^A-Z]+", "_", str(v or "").upper()).strip("_")
    code = {"PRESEED": "PRE_SEED", "A": "SERIES_A", "B": "SERIES_B", "C": "SERIES_C"}.get(code, code)
    return code if code in STAGES else None
FIRST_ANSWER_S = 45   # an assistant should not wait longer than this; the rest is on the run's page
STORED_FOR_S = 6 * 3600   # a walk stored this recently is given as it is; the cards open at once
SEARCH_STORED_S = 3 * 86400   # an investor search stored this recently is given as it is
SECTORS = {"ai": "artificial intelligence", "a.i.": "artificial intelligence", "genai": "generative ai", "gen ai": "generative ai",
           "ml": "machine learning", "climate": "climate tech", "climatetech": "climate tech", "health": "health tech",
           "healthtech": "health tech", "bio": "biotech", "biotechnology": "biotech", "saas": "software as a service",
           "defence": "defense", "defence tech": "defense tech", "deep tech": "deeptech", "climate technology": "climate tech",
           "artificial intelligence ai": "artificial intelligence", "ai ml": "artificial intelligence",
           "ai/ml": "artificial intelligence", "applied ai": "artificial intelligence", "ai research": "artificial intelligence"}
PLACES = {"nordic": "Nordics", "nordic countries": "Nordics", "nordic region": "Nordics", "eu": "Europe", "european union": "Europe",
          "european": "Europe", "baltic": "Baltics", "baltic states": "Baltics", "united states": "US", "usa": "US", "u.s.": "US",
          "united kingdom": "UK", "u.k.": "UK", "britain": "UK"}


def _sector(v) -> str:
    """'AI startups' and 'an AI lab' are the field 'artificial intelligence': one stored search answers them all."""
    s = re.sub(r"\s+", " ", re.sub(r"[^\w &+/'-]", " ", str(v or "").lower())).strip()
    s = re.sub(r"^(an?|the|my|our) ", "", s)
    s = re.sub(r" (start-?ups?|compan(y|ies)|labs?|industry|sector|space|businesse?s?|products?|tools?)$", "", s).strip()
    return SECTORS.get(s, s)[:60]


def _place(v) -> str | None:
    """'the Nordics', 'Nordic countries' and 'nordics' are one place: one stored search answers them all."""
    s = re.sub(r"\s+", " ", str(v or "")).strip()[:40]
    s = re.sub(r"^the ", "", s, flags=re.I)
    if not s:
        return None
    return PLACES.get(s.lower(), s if s.isupper() and len(s) <= 3 else s[0].upper() + s[1:])


def _find_key(args: dict) -> str:
    """One key for a search as the assistant asked for it, so the card can ask how far the same search has got."""
    part = lambda v: re.sub(r"[^a-z0-9]+", "", str(v or "").lower())  # noqa: E731
    many = lambda v: ",".join(sorted(part(x) for x in ([v] if isinstance(v, str) else v or []) if part(x)))  # noqa: E731
    return "find|" + "|".join([part(args.get("sector")), part(args.get("stage")), part(args.get("place")), many(args.get("like")),
                               many(args.get("investors")), part(args.get("company"))])

# The card. One fixed address: a chat host keeps a connector's tool list for the session, so the address must not move.
UI_URI = "ui://soft-yes/app.html"
UI_MIME = "text/html;profile=mcp-app"
UI_FILE = pathlib.Path(__file__).with_name("mcp_app.html")
UI = {"ui": {"resourceUri": UI_URI, "visibility": ["model", "app"]}, "ui/resourceUri": UI_URI}
APP_ONLY = {"ui": {"visibility": ["app"]}}
READS = {"readOnlyHint": True, "openWorldHint": True}

TIER_LABEL = {t["id"]: t["label"].lower() for t in walk.TIERS}

INSTRUCTIONS = (
    "Soft Yes finds a founder the investors for their round from Cala's funding graph, and gets them from investors who "
    "said \"we're in once you have a lead\" to a lead and a filled round. "
    "Every fact comes from Cala's funding graph and is checked against the page Cala cites. No fact is stated by a "
    "language model, so add none of your own.\n\n"
    "0. No soft yes yet, or the founder asks which investors fit what they build (\"find me pre-seed investors for an AI "
    "company\", \"who invests in companies like ours\", \"who could X's investors introduce me to\"): call find_investors "
    "right away with the field in two or three plain words, the stage and the place if they said them, companies like "
    "theirs if they named any, and the investors or the company they already know. Do not ask questions first. It draws "
    "the list in the chat with each investor's signals, so do not repeat it. Make this one call only: given a company or "
    "investors the founder knows, find_investors itself reads the rounds those investors sat in and marks who they could "
    "introduce, so do not also call find_lead or explore_network. The chat shows one drawing per answer.\n"
    "1. The soft yeses. If the founder names the investors, call find_lead with those names right away. If they ask "
    "about a company by name, call find_lead with company right away. In both cases do not search mail first, do not "
    "ask which company it is for, and use only what is said in this chat, nothing from memory. Only when they name "
    "neither an investor nor a company and a mail connector such as Gmail is available, search their mail for "
    "investor replies that commit once there is a lead (\"we're in once you have a lead\", \"happy to follow\", "
    "\"come back when you have a lead\", \"we would join the round\"), and pass each one to find_lead in soft_yeses "
    "with the firm, the person, the date and the exact sentence. Never invent one. Nothing found: ask for names.\n"
    "2. Call find_lead. It draws the walk in the chat, so do not repeat its lists. Say in two or three sentences who to "
    "start with and why.\n"
    "3. Call explore_network when the founder asks who their investors know, who is one hop from a fund, or who can "
    "open a door.\n"
    "4. Call draft_intro for the lead they pick. If a mail connector can create drafts, save the message as a draft, "
    "never send it, addressed to the person who gave the soft yes, with subject and body exactly as returned. Then call "
    "round_tracker to mark that lead as asked.\n"
    "5. round_tracker shows where the round stands. Update it when mail shows an ask went out or a reply came in.\n"
    "6. check_claim verifies who led a company's round against the page Cala cites, for a founder or for an investor "
    "who received an ask."
)

# Starter questions. A chat lists them under the connector (in Claude: + > Soft Yes), so nobody has to know what to type.
# Each one is only the founder's sentence; left empty, it asks with an example that is known to hold.
PROMPTS = [
    {"name": "find-investors", "title": "Find investors for what I build",
     "description": "From the field, the stage and the place: who backs companies like yours, who leads, who is active now. "
                    "Leave it empty to try pre-seed artificial intelligence in Europe.",
     "arguments": [{"name": "field", "description": "What you build, e.g. artificial intelligence", "required": False},
                   {"name": "round", "description": "The round, e.g. Pre-seed or Seed", "required": False},
                   {"name": "place", "description": "Where, e.g. Europe or Finland", "required": False},
                   {"name": "know", "description": "A company whose investors you know, e.g. Cala AI", "required": False}]},
    {"name": "find-a-lead", "title": "Find who could lead my round",
     "description": "From the investors who said they're in once you have a lead. Leave it empty to try Tesi and Innovestor.",
     "arguments": [{"name": "investors", "description": "Who said yes, e.g. Tesi, Innovestor", "required": False},
                   {"name": "round", "description": "The round, e.g. Seed or Series A", "required": False}]},
    {"name": "next-round", "title": "Who could lead a company's round",
     "description": "Starts from the investors already in the company. Leave it empty to try Cala AI.",
     "arguments": [{"name": "company", "description": "The company, e.g. Cala AI", "required": False}]},
    {"name": "who-led", "title": "Check who led a company's rounds",
     "description": "Each 'led' Cala holds, next to the sentence on the page it cites. Leave it empty to try Cala AI.",
     "arguments": [{"name": "company", "description": "The company, e.g. Cala AI", "required": False}]},
    {"name": "my-network", "title": "Who do my investors know",
     "description": "The rounds your investors joined and who sat in them. Leave it empty to try Tesi and Innovestor.",
     "arguments": [{"name": "investors", "description": "Your investors, e.g. Tesi, Innovestor", "required": False}]},
    {"name": "from-my-mail", "title": "Find the soft yeses in my mail",
     "description": "Needs a mail connector. Reads who said they're in once you have a lead, then finds the lead."},
    {"name": "my-round", "title": "Where does my round stand",
     "description": "The round tracker: who is in, who is asked, what is left."},
]


def _spoken(v, default: str) -> str:
    """'Tesi, Innovestor' as a founder says it: 'Tesi and Innovestor'."""
    parts = [x.strip() for x in re.split(r",|;|\band\b|&", str(v or "")) if x.strip()]
    if not parts:
        return default
    return parts[0] if len(parts) == 1 else f"{', '.join(parts[:-1])} and {parts[-1]}"


def _prompt_text(name: str, args: dict) -> str | None:
    company = str(args.get("company") or "").strip() or "Cala AI"
    if name == "find-investors":
        what = str(args.get("field") or "").strip() or "artificial intelligence"
        rnd = str(args.get("round") or "").strip().lower().removesuffix(" round") or "pre-seed"
        place = str(args.get("place") or "").strip() or ("" if args.get("field") else "Europe")
        know = str(args.get("know") or "").strip()
        return (f"We're building in {what}{' in ' + place if place else ''} and raising a {rnd} round. "
                f"Use Soft Yes to find the investors who fit"
                + (f", and who {know}'s investors could introduce us to." if know else "."))
    if name == "find-a-lead":
        given = str(args.get("investors") or "").strip()
        rnd = str(args.get("round") or "").strip() or ("" if given else "Series A")
        rnd = "round" if not rnd else rnd if re.match(r"series", rnd, re.I) else f"{rnd.lower().removesuffix(' round')} round"
        return (f"{_spoken(given, 'Tesi and Innovestor')} said they're in once we have a lead. "
                f"Use Soft Yes to find who could lead our {rnd}.")
    if name == "next-round":
        return f"Who could lead {company}'s next round? Use Soft Yes, starting from the investors already in."
    if name == "who-led":
        return f"Who led {company}'s rounds? Use Soft Yes to check each one against the page Cala cites."
    if name == "my-network":
        who = _spoken(args.get("investors"), "Tesi and Innovestor")
        return (f"Who {'do' if ' and ' in who else 'does'} {who} know? "
                f"Use Soft Yes to show the network and who opens which door.")
    if name == "from-my-mail":
        return ("Look in my mail for investors who said they're in once we have a lead. "
                "Then use Soft Yes to find who could lead the round.")
    if name == "my-round":
        return "Use Soft Yes to show where my round stands."
    return None

SOFT_YES = {"type": "object", "required": ["investor"], "properties": {
    "investor": {"type": "string", "description": "The investor's firm, e.g. \"Kfund\""},
    "person": {"type": "string", "description": "Who wrote, e.g. \"Ana Ruiz\""},
    "email": {"type": "string", "description": "Their address, for the draft later"},
    "said": {"type": "string", "description": "The sentence from the mail, word for word"},
    "date": {"type": "string", "description": "When they wrote, YYYY-MM-DD"}}}

TOOLS = [
    {"name": "find_investors",
     "title": "Find investors for what the founder builds",
     "description": "Finds investors for a founder from what they build, before anyone has said yes. Cala names the "
                    "companies in that field at that stage; from each one the funding graph is read (its rounds, who took "
                    "part, who led), every \"led\" is checked against the page Cala cites, and each investor's own record "
                    "in Cala is read. Returns investors ranked by signals counted from the graph: backed companies like "
                    "the founder's, leads rounds, invests at this stage, active in the last 12 months, round size, where "
                    "it sits, and a way in (a round it led or sat in with an investor the founder already knows, or with "
                    "an investor in a company the founder knows: \"who could X's investors introduce us to\"; when there is "
                    "no such round the graph is read further, up to three introductions, each link a round both sat in). Draws the "
                    "search and the list in the chat. Give sector, or like, or both. One call answers both who fits and "
                    "who can introduce them.",
     "inputSchema": {"type": "object", "properties": {
         "sector": {"type": "string", "description": "The field in two or three plain words, e.g. \"artificial intelligence\", "
                                                     "\"climate tech\", \"fintech\""},
         "stage": {"type": "string", "enum": STAGES, "description": "The round being raised"},
         "place": {"type": "string", "description": "A country, a city or a region, e.g. \"Finland\", \"Europe\", \"Nordics\""},
         "like": {"type": "array", "maxItems": 6, "items": {"type": "string"},
                  "description": "Companies like the founder's, by name, e.g. [\"Mistral AI\", \"Aleph Alpha\"]"},
         "investors": {"type": "array", "maxItems": 6, "items": {"type": "string"},
                       "description": "Investors the founder already has or knows: the way in is looked for through them"},
         "company": {"type": "string", "description": "A company whose investors the founder knows or can ask, e.g. their "
                                                     "own or a friend's: the way in is looked for through its investors"}}},
     "annotations": READS, "_meta": UI},
    {"name": "find_lead",
     "title": "Find who could lead the round",
     "description": "A founder has investors who said \"we're in once you have a lead\". Walks Cala's funding graph from "
                    "those investors: the rounds they joined, who led them, each \"led\" claim checked against the page "
                    "Cala cites, and returns who could lead now, ranked, with the sentence that proves it and which of "
                    "the founder's investors opens the door. Draws the walk in the chat. Give the investors as names, or "
                    "as soft_yeses when they come from the founder's mail (search the mail first if no names were given "
                    "and a mail connector is available). With only a company, starts from the investors Cala lists in it. "
                    "Not for a founder asking which investors fit what they build, also when they name a company whose "
                    "investors could introduce them: that is find_investors alone.",
     "inputSchema": {"type": "object", "properties": {
         "investors": {"type": "array", "maxItems": 6, "items": {"type": "string"},
                       "description": "Names of the investors who gave a soft yes, e.g. [\"Tesi\", \"Innovestor\"]"},
         "soft_yeses": {"type": "array", "maxItems": 6, "items": SOFT_YES,
                        "description": "Soft yeses found in the founder's mail, with the sentence each investor wrote"},
         "company": {"type": "string", "description": "The founder's company. Its own rounds are left out of the walk."},
         "stage": {"type": "string", "enum": STAGES, "description": "The round being raised (optional)"}}},
     "annotations": READS, "_meta": UI},
    {"name": "explore_network",
     "title": "Explore the founder's network",
     "description": "Draws the network around the founder's investors from Cala: every investor they have sat in a round "
                    "with, who led, and which of the founder's investors can open each door. Use it for \"who do my "
                    "investors know\", \"who have they co-invested with\", \"who can introduce me to X\" (pass target) and "
                    "\"who is one hop from this fund\" or \"who does this fund invest with\" (pass fund, which walks out from that "
                    "fund; never pass a fund the founder has not raised from as investors). Give run_id from find_lead, or "
                    "the investors' names.",
     "inputSchema": {"type": "object", "properties": {
         "run_id": {"type": "string", "description": "run_id returned by find_lead"},
         "investors": {"type": "array", "maxItems": 6, "items": {"type": "string"}},
         "target": {"type": "string", "description": "A fund the founder wants to reach: shows who opens that door"},
         "fund": {"type": "string", "description": "Walk one hop out from this fund instead of the founder's investors"}}},
     "annotations": READS, "_meta": UI},
    {"name": "draft_intro",
     "title": "Write the intro ask",
     "description": "After find_lead: writes the ask for one lead from that run's checked facts only. It goes to the "
                    "investor who already said yes, asking for the introduction: never a cold message to the lead. kind "
                    "'slush' is a meeting note under 300 characters. Returns the message and the facts it was written from. "
                    "If a mail connector can create drafts, save it as a draft exactly as written; never send it.",
     "inputSchema": {"type": "object", "required": ["run_id", "lead"], "properties": {
         "run_id": {"type": "string", "description": "run_id returned by find_lead"},
         "lead": {"type": "string", "description": "The lead's name as find_lead returned it"},
         "kind": {"type": "string", "enum": ["intro_ask", "slush"]},
         "company": {"type": "string", "description": "The founder's company name"},
         "one_liner": {"type": "string", "description": "What the company does, one sentence"},
         "raising": {"type": "string", "description": "The round being raised, e.g. \"€4M Series A\""},
         "to_name": {"type": "string", "description": "The person the message goes to, if known"},
         "to_email": {"type": "string", "description": "Their address, if known"}}},
     "annotations": READS, "_meta": UI},
    {"name": "round_tracker",
     "title": "Where the round stands",
     "description": "Shows the round in the chat: who said yes, which leads were asked, who replied, and each lead's latest "
                    "led round in Cala. Call it with run_id to start, and with tracker (the id it returns) and updates when "
                    "an ask went out, a reply came in or a lead committed.",
     "inputSchema": {"type": "object", "properties": {
         "run_id": {"type": "string", "description": "run_id returned by find_lead"},
         "tracker": {"type": "string", "description": "The tracker id returned earlier"},
         "company": {"type": "string"},
         "target_amount": {"type": "number", "description": "The round size, e.g. 4000000"},
         "currency": {"type": "string", "description": "EUR, USD or GBP"},
         "soft_amounts": {"type": "array", "items": {"type": "object", "required": ["investor", "amount"], "properties": {
             "investor": {"type": "string"}, "amount": {"type": "number"}}},
             "description": "What each soft-yes investor said it would put in, if it named a number"},
         "updates": {"type": "array", "items": {"type": "object", "required": ["investor", "status"], "properties": {
             "investor": {"type": "string", "description": "The lead's name"},
             "status": {"type": "string", "enum": list(chat.STATUS)},
             "via": {"type": "string", "description": "Who was asked for the introduction"},
             "date": {"type": "string"}, "note": {"type": "string"}}}}}},
     "annotations": {"readOnlyHint": False, "destructiveHint": False, "idempotentHint": True, "openWorldHint": False},
     "_meta": UI},
    {"name": "check_claim",
     "title": "Check who led a round, by the page",
     "description": "For one company: each funding round Cala holds, who Cala says led it, and what the page Cala cites "
                    "says, quoted word for word. A lead the page credits to someone else is marked corrected. Use it to "
                    "check a \"led by\" claim before repeating it, or when an investor wants to verify an ask they received.",
     "inputSchema": {"type": "object", "required": ["company"], "properties": {
         "company": {"type": "string", "description": "The company's name, e.g. \"Verda\""},
         "investor": {"type": "string", "description": "The investor the claim is about (optional)"}}},
     "annotations": READS, "_meta": UI},
    {"name": "check_investor",
     "title": "Does this investor lead or follow?",
     "description": "For one investor: how many of its rounds in Cala it led, whether it leads or follows by habit, and who "
                    "led when it followed.",
     "inputSchema": {"type": "object", "required": ["name"], "properties": {"name": {"type": "string"}}},
     "annotations": READS},
    # called by the card itself, never by the assistant
    {"name": "walk_progress",
     "title": "How far a walk has got",
     "description": "For the card: how far the walk it is waiting for has got.",
     "inputSchema": {"type": "object", "properties": {"key": {"type": "string"}}},
     "annotations": {"readOnlyHint": True}, "_meta": APP_ONLY},
    {"name": "find_progress",
     "title": "How far a search has got",
     "description": "For the card: how far the investor search it is waiting for has got, and the list when it is done.",
     "inputSchema": {"type": "object", "properties": {"key": {"type": "string"}}},
     "annotations": {"readOnlyHint": True}, "_meta": APP_ONLY},
    {"name": "tracker_set",
     "title": "Set a lead's status",
     "description": "For the card: set one lead's status in the round tracker.",
     "inputSchema": {"type": "object", "required": ["tracker", "investor", "status"], "properties": {
         "tracker": {"type": "string"}, "investor": {"type": "string"}, "status": {"type": "string", "enum": list(chat.STATUS)}}},
     "annotations": {"readOnlyHint": False, "destructiveHint": False, "idempotentHint": True}, "_meta": APP_ONLY},
    {"name": "flag_claim",
     "title": "Send a correction to Cala's list",
     "description": "For the card: put a lead claim the cited page does not bear out on the list of corrections for Cala.",
     "inputSchema": {"type": "object", "required": ["company", "cala"], "properties": {
         "company": {"type": "string"}, "round": {"type": "string"}, "cala": {"type": "string"},
         "page": {"type": "array", "items": {"type": "string"}}, "quote": {"type": "string"}, "url": {"type": "string"}}},
     "annotations": {"readOnlyHint": False, "destructiveHint": False, "idempotentHint": True}, "_meta": APP_ONLY},
]

PROGRESS: dict[str, dict] = {}   # walks under way, by what the assistant asked for, so a waiting card can show them
FINDS: dict[str, dict] = {}      # investor searches under way, the same way
SEARCHES: dict[str, asyncio.Task] = {}   # one search per question at a time, by its run id

SAID = {"lead": "the page says it led", "report": "known from a report, no round page", "follower": "the page names another lead",
        "unstated": "the page names it but does not say it led", "other": "the page says it led another round of this company",
        "absent": "the page does not name it", "off": "the cited page is about something else",
        "unread": "the cited page could not be read"}




def _src(sources: list[dict]) -> str:
    return f" ({sources[0]['url']})" if sources else ""


def _deal(d: dict) -> str:
    money = extras.fmt_money(d.get("amount"), d.get("currency"))
    parts = [(d.get("issuer") or {}).get("name") or "a company", d.get("stage_name") if d.get("stage") else None, money or None,
             extras.fmt_date(d.get("date")) or None]
    return ", ".join(p for p in parts if p)


def lead_lines(e: dict, n: int | None = None) -> list[str]:
    head = f"{n}. {e['name']}" if n else e["name"]
    label = TIER_LABEL.get(e.get("tier")) if n else None
    if label:
        head += f" [{label}]"
    if e.get("at_slush"):
        head += " (registered for Slush)"
    out = [head, "   " + "; ".join(w["text"] for w in e.get("why", []))]
    if e.get("doubt"):
        out.append("   Caution: " + e["doubt"]["text"])
    ask = e.get("ask")
    if ask and ask.get("last"):
        out.append(f"   Ask {ask['name']} for the intro. Round they share: {_deal(ask['last'])}{_src(ask['last'].get('sources') or [])}")
    for d in e["evidence"][1:3]:
        out.append(f"   Also: {_deal(d)}, with {' and '.join(d['with'])}{_src(d.get('sources') or [])}")
    for d in e["evidence"][:3]:
        if d.get("caution"):
            out.append("   Caution: " + d["caution"])
    return out


def result_text(r: dict, partial: bool) -> str:
    i = r["input"]
    names = " and ".join(s["name"] for s in i["soft_yeses"])
    out = [f"# Who could lead, given a soft yes from {names}" + (f" ({i['stage_name']})" if i.get("stage_name") else ""), "",
           r["headline"], "", "## The investors who said yes"]
    for s in r["soft_yeses"]:
        out.append(f"- {s['name']}: {s['insight']}")
    out += ["", "## Who could lead, ranked"]
    if not r["leads"]:
        out.append("Cala lists no round these investors joined that someone else led.")
    for e in r["leads"][:8]:
        out += lead_lines(e, e["rank"])
    if len(r["leads"]) > 8:
        out.append(f"... and {len(r['leads']) - 8} more on the page below.")
    if r.get("second_ring"):
        out += ["", "## Sat in those rounds without leading, but lead elsewhere"]
        for e in r["second_ring"][:3]:
            out += lead_lines(e)
    led = r["ledger"]
    out += ["", f"Every round and source: {PUBLIC_URL}/r/{r['run_id']}",
            f"Built on {led['facts']} Cala facts from {led['sources']} sources. No fact here was stated by a language model.",
            f"For the intro request, call draft_intro with run_id \"{r['run_id']}\" and the lead's name."]
    if partial:
        out.append("Cala's graph is thin for one of these investors, so reports are still being read; the page above fills in "
                   "within a minute.")
    return "\n".join(out)


def result_data(r: dict) -> dict:
    return {"run_id": r["run_id"], "url": f"{PUBLIC_URL}/r/{r['run_id']}", "headline": r["headline"],
            "soft_yeses": [{"name": s["name"], "verdict": s["verdict"], "insight": s["insight"], "rounds": s.get("rounds_in_cala"),
                            "led": s.get("led")} for s in r["soft_yeses"]],
            "leads": [{"rank": e["rank"], "name": e["name"], "confidence": TIER_LABEL.get(e.get("tier")),
                       "why": [w["text"] for w in e["why"]],
                       "ask": (e.get("ask") or {}).get("name"), "led_recent": e.get("led_recent"),
                       "at_slush": bool(e.get("at_slush")), "caution": (e.get("doubt") or {}).get("text"),
                       "shared_rounds": [{"company": (d.get("issuer") or {}).get("name"), "stage": d.get("stage_name"),
                                          "date": d.get("date"), "amount": d.get("amount"), "currency": d.get("currency"),
                                          "with": d["with"], "sources": [s["url"] for s in d.get("sources") or []]}
                                         for d in e["evidence"][:4]]} for e in r["leads"][:12]],
            "cala_facts": r["ledger"]["facts"], "sources": r["ledger"]["sources"], "facts_from_a_language_model": 0}


def _app_html() -> str:
    try:
        return UI_FILE.read_text(encoding="utf-8")
    except OSError:
        return "<!doctype html><meta charset=utf-8><p>The Soft Yes card is not built on this server.</p>"


def _names(args: dict) -> tuple[list[str], dict[str, dict]]:
    """The investors as the assistant gave them, and what the founder's mail says of each, by name."""
    names, mail = [], {}
    for row in args.get("soft_yeses") or []:
        if isinstance(row, dict) and str(row.get("investor") or "").strip():
            name = str(row["investor"]).strip()[:60]
            names.append(name)
            mail[name] = {k: str(row[k])[:400 if k == "said" else 120] for k in ("person", "email", "said", "date") if row.get(k)}
    given = args.get("investors")
    for name in ([given] if isinstance(given, str) else given or []):
        if str(name).strip() and str(name).strip() not in names:
            names.append(str(name).strip()[:60])
    return names[:6], mail


class Server:
    """`suggest(name)` resolves a name to Cala entities, `run(inputs, emit)` walks, `load(run_id)` reads a stored run,
    `check(name)` reads a company's rounds against their pages, `company(name)` finds the founder's company and the
    walk that starts from it, `holdout(run_id)` is the walk tested on that company's own last round."""

    def __init__(self, suggest: Callable[[str], Awaitable[dict]], run: Callable[[dict, Callable], Awaitable[dict]],
                 load: Callable[[str], dict | None], check: Callable[[str], Awaitable[dict]] | None = None,
                 company: Callable[[str], Awaitable[dict | None]] | None = None,
                 holdout: Callable[[str], Awaitable[dict | None]] | None = None,
                 search: Callable[[dict, Callable], Awaitable[dict]] | None = None):
        self.suggest, self.run, self.load, self.check, self.company, self.holdout = suggest, run, load, check, company, holdout
        self.search = search   # `search(inputs, emit)` finds investors from a field: scout.scout on the server's Cala client

    # ------------------------------------------------------------------------------------- investors from a field

    async def _search(self, inputs: dict, key: str) -> tuple[dict | None, dict]:
        """The stored search, or a fresh one. A fresh one that takes longer than an assistant should wait goes on in the
        background: (None, how far it has got) comes back, and the card asks find_progress for the rest."""
        rid = scout.run_id(inputs)
        stored = extras.blob_get("scout:" + rid, SEARCH_STORED_S)
        # a search whose link pages were still being read is read once more: the pages are kept by then, Cala's answers too
        again = stored and stored.get("late") and stored.get("late_runs", 0) < 3 and time.time() - stored.get("created", 0) > 40
        if stored and stored.get("v") == scout.VERSION and not again:
            return stored, {}
        for old in [k for k, v in FINDS.items() if time.time() - v["started"] > 1800]:
            FINDS.pop(old, None)
        seen = FINDS.get(key) if FINDS.get(key, {}).get("run_id") == rid and FINDS[key]["state"] == "searching" else None
        if not seen:
            seen = FINDS[key] = {"state": "searching", "started": time.time(), "run_id": rid, "step": "field", "names": [], "found": 0,
                                 "companies": None, "rounds": None, "pages": None, "investors": None, "reading": [], "calls": 0}

        async def emit(event: dict) -> None:
            seen["calls"] = event.get("cala_calls") or seen["calls"]
            step = event.get("step")
            if step:
                seen["step"] = step
            if step == "companies":
                seen["names"], seen["found"] = event.get("names") or [], event.get("found") or 0
            elif step == "rounds":
                seen["rounds"], seen["companies"] = event.get("rounds"), event.get("companies")
            elif step == "pages":
                seen["pages"] = {k: event.get(k) for k in ("pages", "confirmed", "corrected")}
            elif step == "investors":
                seen["investors"], seen["reading"] = event.get("investors"), (event.get("reading") or [])[:8]

        async def work() -> dict:
            try:
                r = await self.search(inputs, emit)
                r["late_runs"] = ((stored or {}).get("late_runs", 0) + 1) if r.get("late") else 0
                extras.blob_put("scout:" + rid, r)
                if r["page_check"]["claims"]:
                    extras.blob_put("check:scout:" + rid, {"page_check": r["page_check"]})
                seen["state"] = "done"
                return r
            except Exception as exc:  # noqa: BLE001
                seen["state"], seen["error"] = "failed", f"{type(exc).__name__}: {exc}"[:200]
                raise
            finally:
                SEARCHES.pop(rid, None)

        task = SEARCHES.get(rid)
        if not task:
            task = SEARCHES[rid] = asyncio.create_task(work())
        try:
            return await asyncio.wait_for(asyncio.shield(task), FIRST_ANSWER_S), seen
        except asyncio.TimeoutError:
            return None, seen

    async def find_investors(self, args: dict) -> dict:
        if not self.search:
            return _error("This server cannot search investors.")
        sector = _sector(args.get("sector"))
        like = [str(x).strip()[:60] for x in ([args["like"]] if isinstance(args.get("like"), str) else args.get("like") or [])
                if str(x).strip()][:6]
        if len(sector) < 2 and not like:
            return _error("Say what the founder builds, e.g. {\"sector\": \"artificial intelligence\"}, or name companies like "
                          "theirs in like.")
        given = args.get("investors")
        names = [str(x).strip()[:60] for x in ([given] if isinstance(given, str) else given or []) if str(x).strip()][:6]
        mine, unknown = await self._resolve(names) if names else ([], [])
        mine = [{"name": m["name"], "ids": m["ids"]} for m in mine]
        via = None
        if str(args.get("company") or "").strip() and self.company:
            comp = await self.company(str(args["company"]).strip()[:80])
            if comp and (comp.get("inputs") or {}).get("soft_yeses"):
                via = comp["name"] if not mine else None
                have = {i for m in mine for i in m["ids"]}
                mine += [{"name": s["name"], "ids": s["ids"]} for s in comp["inputs"]["soft_yeses"] if not have & set(s["ids"])]
            elif not names:
                unknown.append(str(args["company"]).strip()[:80])
        inputs = {"sector": sector, "stage": _stage_code(args.get("stage")), "place": _place(args.get("place")),
                  "like": like, "mine": mine[:scout.MINE], "via_company": via}
        key = _find_key(args)
        result, seen = await self._search(inputs, key)
        if result is None:
            what = " ".join(x for x in (graph.STAGE_NAMES.get(inputs["stage"] or "", ""), sector or "companies like " + ", ".join(like),
                                        scout.in_words(inputs["place"])) if x)
            text = (f"Cala is still being read for {what}. The search and the list are drawn in "
                    "the chat, and the card fills in by itself, usually within a minute or two. Tell the founder that in one "
                    "sentence and name no investor yet. To read the list yourself, call find_investors again with the same "
                    "arguments.")
            return {"content": [{"type": "text", "text": text}], "isError": False,
                    "structuredContent": {"view": "find", "pending": True, "key": key, "ask": {
                        "sector": sector or None, "stage": inputs["stage"], "stage_name": graph.STAGE_NAMES.get(inputs["stage"] or ""),
                        "place": inputs["place"], "like": like, "mine": [m["name"] for m in mine], "via_company": via},
                        "queries": [q for _, q in scout.queries(sector, inputs["stage"], inputs["place"])] if sector else [],
                        "progress": _seen(seen)}}
        text = scout.text(result, PUBLIC_URL)
        if unknown:
            text += f"\nNot found in Cala, so left out: {', '.join(unknown)}."
        return {"content": [{"type": "text", "text": text}], "structuredContent": scout.view(result, PUBLIC_URL), "isError": False}

    async def find_progress(self, args: dict) -> dict:
        seen = FINDS.get(str(args.get("key") or ""))
        if not seen:
            return {"content": [{"type": "text", "text": "No search under way."}], "structuredContent": {"state": "none"}, "isError": False}
        out = _seen(seen)
        if seen["state"] == "done":
            stored = extras.blob_get("scout:" + seen["run_id"])
            if stored:
                out["result"] = scout.view(stored, PUBLIC_URL)
        return {"content": [{"type": "text", "text": f"{seen['calls']} Cala calls so far."}], "structuredContent": out, "isError": False}

    async def who_led(self, args: dict) -> dict:
        name = str(args.get("company") or "").strip()
        if len(name) < 2 or not self.check:
            return _error("Name a company, e.g. {\"company\": \"Verda\"}.")
        d = args.get("_read") or await self.check(name)
        if not d.get("company"):
            return _error(f"Cala does not know a company called {name}.")
        co = d["company"]["name"]
        if not d["rounds"]:
            n = d.get("investors_in_cala")
            text = f"Cala's graph holds no funding rounds for {co}" + (
                f", only {n} investors without their rounds, so there is no lead claim to check." if n else ".")
            quotes = (d.get("knowledge") or {}).get("quotes") or []
            if quotes:
                text += "\n\nCala's knowledge search read these pages. What they say about who led, word for word:\n\n" + \
                    "\n".join(f"- \"{q['quote']}\" ([{q['publisher']}]({q['url']}))" for q in quotes)
            return {"content": [{"type": "text", "text": text}], "isError": False,
                    "structuredContent": {"company": co, "rounds": [], "said_on_pages": quotes}}
        out, rows = [f"# {co}: who led, by the page Cala cites", ""], []
        for r in d["rounds"]:
            head = " ".join(x for x in (r["stage_name"], (r.get("date") or "")[:7]) if x)
            out.append(f"## {head}")
            if not r["investors"]:
                out.append("Cala names no lead for this round.")
            for i in r["investors"]:
                ck = i.get("check") or {}
                line = f"- {i['name']}: " + ("Cala says it led; " if i["cala_lead"] else "Cala does not flag it; ") + \
                    SAID.get(ck.get("status"), "not checked")
                if ck.get("led_by"):
                    line += f" ({', '.join(ck['led_by'])} led)"
                if ck.get("quote"):
                    line += f'. "{ck["quote"]}" ({ck.get("url")})'
                out.append(line)
                rows.append({"round": head, "investor": i["name"], "cala_says_lead": i["cala_lead"], "page": ck.get("status"),
                             "page_names_lead": ck.get("led_by"), "quote": ck.get("quote"), "url": ck.get("url")})
            out.append("")
        pc = d["page_check"]
        out.append(f"{pc['pages']} page{'s' if pc['pages'] != 1 else ''} read: {pc['confirmed']} lead "
                   f"claim{'s' if pc['confirmed'] != 1 else ''} confirmed word for word, {pc['corrected']} corrected. "
                   f"Every checked claim: {PUBLIC_URL}/audit")
        return {"content": [{"type": "text", "text": "\n".join(out)}],
                "structuredContent": {"company": co, "claims": rows, "pages_read": pc["pages"], "confirmed": pc["confirmed"],
                                      "corrected": pc["corrected"]}, "isError": False}

    async def check_claim(self, args: dict) -> dict:
        name = str(args.get("company") or "").strip()
        if len(name) < 2 or not self.check:
            return _error("Name a company, e.g. {\"company\": \"Verda\"}.")
        d = await self.check(name)
        out = await self.who_led({"company": name, "_read": d})
        if out.get("isError"):
            return out
        view = chat.claim_view(d, str(args.get("investor") or "").strip() or None, f"{PUBLIC_URL}/audit")
        out["structuredContent"] = view
        return out

    async def _resolve(self, names: list[str]) -> tuple[list[dict], list[str]]:
        softs, unknown = [], []
        for name in names[:6]:
            items = (await self.suggest(str(name)[:60]))["items"]
            if not items:
                unknown.append(str(name))
                continue
            it = items[0]
            if any(s["ids"][0] == it["ids"][0] for s in softs):
                continue
            softs.append({"name": it["name"], "ids": it["ids"][:6], "kind": it.get("kind", "fund"), "asked": str(name)})
        return softs, unknown

    async def _walk(self, inputs: dict, key: str | None = None) -> tuple[dict, bool]:
        stored = self.load(walk.run_id(inputs))
        if stored and not stored.get("pending") and time.time() - (stored.get("created") or 0) < STORED_FOR_S:
            return stored, False
        first: dict = {}
        seen: dict = {"state": "walking", "started": time.time(), "investors": [], "rounds": 0, "latest": [],
                      "leads": set(), "pages": None, "calls": 0}
        if key:
            for old in [k for k, v in PROGRESS.items() if time.time() - v["started"] > 900]:
                PROGRESS.pop(old, None)
            PROGRESS[key] = seen

        async def emit(event: dict) -> None:
            if event["t"] == "partial":
                first["result"] = event["result"]
            if event.get("cala_calls"):
                seen["calls"] = event["cala_calls"]
            if event["t"] == "investor":
                seen["investors"].append({k: event.get(k) for k in ("name", "rounds", "led", "followed")})
            elif event["t"] == "round":
                seen["rounds"] += 1
                rd = event["round"]
                seen["latest"] = (seen["latest"] + [{"company": (rd.get("issuer") or {}).get("name"), "stage_name": rd.get("stage_name"),
                                                     "leads": [x["name"] for x in event.get("leads") or []][:2]}])[-6:]
                seen["leads"].update(x["key"] for x in event.get("leads") or [])
            elif event["t"] == "pages":
                seen["pages"] = {k: event.get(k) for k in ("state", "rounds", "pages", "confirmed", "corrected")}

        task = asyncio.create_task(self.run(inputs, emit))
        try:
            return await asyncio.wait_for(asyncio.shield(task), FIRST_ANSWER_S), False
        except asyncio.TimeoutError:
            if "result" in first:
                return first["result"], True   # the walk goes on in the background and is stored when done
            return await task, False
        finally:
            seen["state"] = "done"

    async def walk_progress(self, args: dict) -> dict:
        seen = PROGRESS.get(str(args.get("key") or ""))
        if not seen:
            return {"content": [{"type": "text", "text": "No walk under way."}], "structuredContent": {"state": "none"}, "isError": False}
        out = {**seen, "leads": len(seen["leads"]), "seconds": round(time.time() - seen["started"], 1)}
        return {"content": [{"type": "text", "text": f"{out['rounds']} rounds opened."}], "structuredContent": out, "isError": False}

    async def _inputs(self, args: dict) -> tuple[dict | None, dict, list[str], str | None]:
        """What to walk from: the investors given, or the ones Cala lists in the company. Also the mail behind each."""
        names, mail = _names(args)
        stage = _stage_code(args.get("stage"))
        comp = None
        if str(args.get("company") or "").strip() and self.company:
            comp = await self.company(str(args["company"]).strip()[:80])
        if not names:
            if not comp or not comp.get("inputs"):
                return None, {}, [], None
            inputs = dict(comp["inputs"])
            if stage:
                inputs["stage"] = stage
            return inputs, {}, [], comp["name"]
        softs, unknown = await self._resolve(names)
        if not softs:
            return None, {}, unknown, None
        said = {graph.norm(s["name"]): mail[s["asked"]] for s in softs if s["asked"] in mail}
        inputs = {"soft_yeses": [{k: s[k] for k in ("name", "ids", "kind")} for s in softs], "stage": stage,
                  "company": comp["ref"] if comp else None, "deep": False}
        return inputs, said, unknown, (comp or {}).get("name")

    async def find_lead(self, args: dict) -> dict:
        inputs, said, unknown, _ = await self._inputs(args)
        if not inputs:
            if unknown:
                return _error(f"Cala does not know an investor called {' or '.join(unknown)}. Check the spelling.")
            if args.get("company"):
                return _error(f"Cala lists no investors for a company called {args['company']}. Name the investors who said yes.")
            return _error("Give the investors who said yes, e.g. {\"investors\": [\"Tesi\"]}, or the founder's company.")
        result, partial = await self._walk(inputs, chat.progress_key(args))
        text = result_text(result, partial)
        if unknown:
            text += f"\nNot found in Cala, so left out: {', '.join(unknown)}."
        held = None
        if (inputs.get("company") or {}).get("id") and self.holdout:
            try:   # the walk tested on the company's own last round; an extra, so it never holds the answer up for long
                held = await asyncio.wait_for(self.holdout(result["run_id"]), 12)
            except Exception:  # noqa: BLE001
                held = None
        view = chat.walk_view(result, f"{PUBLIC_URL}/r/{result['run_id']}", said, held, partial)
        if view.get("own") and view["own"].get("found"):
            o = view["own"]
            text += (f"\n\nChecked on the company's own {str(o['stage_name']).lower()}: with that round left out and the walk run "
                     f"from {' and '.join(o['from'])} alone, {o['found']['name']} comes out number {o['found']['rank']} of "
                     f"{o['of']}. It led that round.")
        text += ("\n\nThe walk is drawn in the chat with every source. For where the round stands, call round_tracker with "
                 "this run_id.")
        return {"content": [{"type": "text", "text": text}], "structuredContent": view, "isError": False}

    async def explore_network(self, args: dict) -> dict:
        fund = str(args.get("fund") or "").strip()
        path: list[str] = []
        result = None
        if fund:
            before = self.load(str(args.get("run_id") or "")) if args.get("run_id") else None
            softs, unknown = await self._resolve([fund])
            if not softs:
                return _error(f"Cala does not know an investor called {fund}.")
            if before:
                path = [s["name"] for s in before["soft_yeses"]]
            result, _ = await self._walk({"soft_yeses": [{k: s[k] for k in ("name", "ids", "kind")} for s in softs], "stage": None,
                                          "company": None, "deep": False})
        elif args.get("run_id"):
            result = self.load(str(args["run_id"]))
            if not result:
                return _error("No such run. Call find_lead first and pass its run_id, or give the investors' names.")
        else:
            inputs, _, unknown, _ = await self._inputs(args)
            if not inputs:
                return _error("Give run_id from find_lead, or the investors' names.")
            result, _ = await self._walk(inputs)
        view = chat.network_view(result, f"{PUBLIC_URL}/r/{result['run_id']}", str(args.get("target") or "") or None, path)
        if fund:
            view["fund"] = result["soft_yeses"][0]["name"]   # walked out from a fund that is not the founder's investor
        text = chat.network_text(view)
        if args.get("target"):
            text += "\n\n" + _door_text(view, str(args["target"]))
        return {"content": [{"type": "text", "text": text}], "structuredContent": view, "isError": False}

    async def check_investor(self, args: dict) -> dict:
        softs, unknown = await self._resolve([args.get("name") or ""])
        if not softs:
            return _error(f"Cala does not know an investor called {args.get('name')}.")
        result, _ = await self._walk({"soft_yeses": [{k: s[k] for k in ("name", "ids", "kind")} for s in softs], "stage": None,
                                      "company": None, "deep": False})
        s = result["soft_yeses"][0]
        out = [f"# {s['name']}: {s['verdict']}", "", s["insight"]]
        if s.get("usual_leads"):
            out += ["", "Who led when it followed: " + ", ".join(f"{u['name']} ({u['deals']})" for u in s["usual_leads"])]
        for d in (s.get("followed_rounds") or [])[:6]:
            lead = f", led by {' and '.join(dict.fromkeys(d['leads']))}" if d.get("leads") else ""
            out.append(f"- {_deal(d)}{lead}{_src(d.get('sources') or [])}")
        out += ["", f"Every round and source: {PUBLIC_URL}/r/{result['run_id']}"]
        return {"content": [{"type": "text", "text": "\n".join(out)}],
                "structuredContent": {"name": s["name"], "verdict": s["verdict"], "insight": s["insight"],
                                      "rounds": s.get("rounds_in_cala"), "led": s.get("led"), "run_id": result["run_id"]},
                "isError": False}

    def _find_lead(self, result: dict, name: str) -> dict | None:
        want = graph.norm(name)
        pool = result["leads"] + result["second_ring"]
        return next((e for e in pool if e["key"] == want), None) or \
            next((e for e in pool if want and (want in e["key"] or e["key"] in want)), None)

    async def draft_intro(self, args: dict) -> dict:
        result = self.load(str(args.get("run_id") or ""))
        if not result:
            return _error("No such run. Call find_lead first and pass its run_id.")
        lead = self._find_lead(result, str(args.get("lead") or ""))
        if not lead:
            return _error("That run has no such lead. Leads in it: " + ", ".join(e["name"] for e in result["leads"][:12]))
        kind = "slush" if args.get("kind") == "slush" else "intro_ask"   # there is no cold message to the lead
        if kind == "intro_ask" and not (lead.get("ask") or {}).get("name"):
            return _error(f"None of the investors who said yes sat in a round {lead['name']} led, so there is nobody to ask for this "
                          "introduction. Pick a lead with a door, or call explore_network to see who opens it.")
        founder = {k: str(args.get(k) or "")[:200] for k in ("company", "one_liner", "raising")}
        d = await extras.draft(result, lead, kind, founder)
        to = {k: str(args.get("to_" + k) or "")[:120] for k in ("name", "email") if args.get("to_" + k)}
        text = (f"Subject: {d['subject']}\n\n" if d.get("subject") else "") + d["body"] + "\n\n---\n" + d["note"] + \
            "\nFacts it was written from:\n" + "\n".join(f"- {f}" for f in d["facts"])
        if kind != "slush":
            text += ("\n\nIf a mail connector can create drafts, save this as a draft now with the subject and body exactly as "
                     "above, and do not send it. Then call round_tracker to mark this lead as asked.")
        view = chat.draft_view(result, lead, d, f"{PUBLIC_URL}/r/{result['run_id']}", to)
        return {"content": [{"type": "text", "text": text}],
                "structuredContent": {**view, "written_from": "checked facts only", "checked_against_facts": True},
                "isError": False}

    # ------------------------------------------------------------------------------------- the round

    def _tracker(self, args: dict) -> tuple[dict | None, dict | None]:
        state = extras.blob_get("tracker:" + str(args["tracker"])[:40]) if args.get("tracker") else None
        result = self.load((state or {}).get("run_id") or str(args.get("run_id") or ""))
        if not result:
            return None, None
        if not state:
            state = {"id": f"{result['run_id']}-{secrets.token_hex(3)}", "run_id": result["run_id"], "created": time.time(),
                     "company": None, "target": {}, "softs": {},
                     # the shortlist is where a round starts: the first leads on the list, not yet asked
                     "leads": {e["key"]: {"name": e["name"], "status": "to_ask"} for e in result["leads"][:5]}}
        return state, result

    def _apply(self, state: dict, result: dict, updates: list) -> list[str]:
        missed = []
        for u in updates or []:
            if not isinstance(u, dict) or u.get("status") not in chat.STATUS or not str(u.get("investor") or "").strip():
                continue
            lead = self._find_lead(result, str(u["investor"]))
            key = lead["key"] if lead else graph.norm(str(u["investor"]))
            if not lead and key not in state["leads"]:
                missed.append(str(u["investor"]))
            row = state["leads"].setdefault(key, {"name": lead["name"] if lead else str(u["investor"])[:80]})
            row["status"] = u["status"]
            for k in ("via", "date", "note"):
                if u.get(k):
                    row[k] = str(u[k])[:160]
            if u["status"] != "to_ask" and not row.get("date"):
                row["date"] = time.strftime("%Y-%m-%d")
        state["updated"] = time.time()
        return missed

    async def round_tracker(self, args: dict) -> dict:
        state, result = self._tracker(args)
        if not state:
            return _error("No such round. Call find_lead first, then round_tracker with its run_id.")
        if args.get("company"):
            state["company"] = str(args["company"])[:80]
        if isinstance(args.get("target_amount"), (int, float)) and args["target_amount"] > 0:
            state["target"] = {"amount": float(args["target_amount"]),
                               "currency": args.get("currency") if args.get("currency") in ("EUR", "USD", "GBP") else "EUR"}
        for row in args.get("soft_amounts") or []:
            if isinstance(row, dict) and isinstance(row.get("amount"), (int, float)):
                key = graph.norm(str(row.get("investor") or ""))
                hit = next((s["key"] for s in result["soft_yeses"] if s["key"] == key or key in s["key"] or s["key"] in key), None)
                if hit:
                    state["softs"][hit] = {"amount": float(row["amount"])}
        missed = self._apply(state, result, args.get("updates") or [])
        extras.blob_put("tracker:" + state["id"], state)
        view = chat.tracker_view(state, result, f"{PUBLIC_URL}/r/{result['run_id']}")
        text = chat.tracker_text(view)
        if missed:
            text += f"\nNot on this walk's list, added as given: {', '.join(missed)}."
        return {"content": [{"type": "text", "text": text}], "structuredContent": view, "isError": False}

    async def tracker_set(self, args: dict) -> dict:
        state, result = self._tracker(args)
        if not state or not args.get("tracker"):
            return _error("No such round.")
        self._apply(state, result, [{"investor": args.get("investor"), "status": args.get("status")}])
        extras.blob_put("tracker:" + state["id"], state)
        view = chat.tracker_view(state, result, f"{PUBLIC_URL}/r/{result['run_id']}")
        return {"content": [{"type": "text", "text": chat.tracker_text(view)}], "structuredContent": view, "isError": False}

    async def flag_claim(self, args: dict) -> dict:
        row = {"company": str(args.get("company") or "")[:120], "round": str(args.get("round") or "")[:60],
               "cala": str(args.get("cala") or "")[:120], "page": [str(p)[:120] for p in (args.get("page") or [])[:3]],
               "quote": str(args.get("quote") or "")[:400], "url": str(args.get("url") or "")[:400], "at": time.time()}
        if not row["company"] or not row["cala"]:
            return _error("Name the company and the lead Cala gives.")
        flags = (extras.blob_get("flags") or {}).get("rows") or []
        same = lambda f: (f["company"], f["cala"], f["url"]) == (row["company"], row["cala"], row["url"])  # noqa: E731
        if not any(same(f) for f in flags):
            flags.append(row)
        extras.blob_put("flags", {"rows": flags[-500:]})
        return {"content": [{"type": "text", "text": f"On the list of corrections for Cala: {PUBLIC_URL}/audit"}],
                "structuredContent": {"flagged": True, "count": len(flags), "url": f"{PUBLIC_URL}/audit"}, "isError": False}

    # ------------------------------------------------------------------------------------- the protocol

    async def handle(self, msg: dict) -> dict | None:
        """One JSON-RPC message in, one out (None for a notification)."""
        mid, method, params = msg.get("id"), msg.get("method"), msg.get("params") or {}
        if mid is None:
            return None

        def ok(result: dict) -> dict:
            return {"jsonrpc": "2.0", "id": mid, "result": result}

        if method == "initialize":
            asked = params.get("protocolVersion")
            return ok({"protocolVersion": asked if asked in VERSIONS else VERSIONS[0],
                       "capabilities": {"tools": {"listChanged": False}, "resources": {"listChanged": False, "subscribe": False},
                                        "prompts": {"listChanged": False}},
                       "serverInfo": {"name": "soft-yes", "title": "Soft Yes", "version": "2.0.0"},
                       "instructions": INSTRUCTIONS})
        if method == "ping":
            return ok({})
        if method == "tools/list":
            return ok({"tools": TOOLS})
        if method == "tools/call":
            fn = {"find_lead": self.find_lead, "explore_network": self.explore_network, "draft_intro": self.draft_intro,
                  "round_tracker": self.round_tracker, "check_claim": self.check_claim, "who_led": self.who_led,
                  "check_investor": self.check_investor, "walk_progress": self.walk_progress, "tracker_set": self.tracker_set,
                  "flag_claim": self.flag_claim, "find_investors": self.find_investors,
                  "find_progress": self.find_progress}.get(params.get("name"))
            if not fn:
                return {"jsonrpc": "2.0", "id": mid, "error": {"code": -32602, "message": f"Unknown tool: {params.get('name')}"}}
            try:
                return ok(await fn(params.get("arguments") or {}))
            except Exception as exc:  # noqa: BLE001 - a tool failure is a result the assistant can read, not a crash
                return ok(_error(f"Soft Yes could not finish: {type(exc).__name__}: {exc}"[:300]))
        if method == "resources/list":
            return ok({"resources": [{"uri": UI_URI, "name": "soft-yes-card", "title": "Soft Yes",
                                      "description": "The card Soft Yes draws in the chat: the investor search, the walk through "
                                                     "Cala's graph, the network, the draft, the round and the claim check.",
                                      "mimeType": UI_MIME}]})
        if method == "resources/read":
            if params.get("uri") != UI_URI:
                return {"jsonrpc": "2.0", "id": mid, "error": {"code": -32002, "message": f"Resource not found: {params.get('uri')}"}}
            return ok({"contents": [{"uri": UI_URI, "mimeType": UI_MIME, "text": _app_html(),
                                     "_meta": {"ui": {"prefersBorder": False, "csp": {"resourceDomains": ["https://assets.claude.ai"]},
                                                      "permissions": {"clipboardWrite": {}}}}}]})
        if method == "resources/templates/list":
            return ok({"resourceTemplates": []})
        if method == "prompts/list":
            return ok({"prompts": PROMPTS})
        if method == "prompts/get":
            meta = next((p for p in PROMPTS if p["name"] == params.get("name")), None)
            text = _prompt_text(params.get("name"), params.get("arguments") or {}) if meta else None
            if not text:
                return {"jsonrpc": "2.0", "id": mid, "error": {"code": -32602, "message": f"Unknown prompt: {params.get('name')}"}}
            return ok({"description": meta["title"], "messages": [{"role": "user", "content": {"type": "text", "text": text}}]})
        return {"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": f"Method not found: {method}"}}


def _door_text(view: dict, target: str) -> str:
    """Who among the founder's investors has sat in a round with the fund they want to reach."""
    net = view.get("net") or {"names": [], "rounds": [], "softs": 0}
    want = graph.norm(target)
    idx = next((i for i, n in enumerate(net["names"]) if i >= net["softs"] and (graph.norm(n) == want or want in graph.norm(n))), None)
    if idx is None:
        return (f"None of these investors has sat in a round with {target} in Cala. To look one hop further, call "
                f"explore_network with fund set to one of the investors above.")
    doors: dict[int, list[str]] = {}
    for row in net["rounds"]:
        if any(i[0] == idx for i in row["i"]):
            for m in row["m"]:
                doors.setdefault(m, []).append(", ".join(x for x in (row["c"], row["s"], row["d"]) if x))
    if not doors:
        return f"{net['names'][idx]} is in these rounds, but none that one of the founder's investors joined."
    lines = [f"Who opens the door to {net['names'][idx]}:"]
    for m, rounds in sorted(doors.items(), key=lambda kv: -len(kv[1])):
        lines.append(f"- {net['names'][m]}: {len(rounds)} shared round{'s' if len(rounds) != 1 else ''} ({'; '.join(rounds[:3])})")
    return "\n".join(lines)


def _seen(seen: dict) -> dict:
    return {**seen, "seconds": round(time.time() - seen["started"], 1)}


def _error(text: str) -> dict:
    return {"content": [{"type": "text", "text": text}], "isError": True}
