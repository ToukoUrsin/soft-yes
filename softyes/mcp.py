"""Soft Yes as an MCP server, so a founder's own assistant can do the walk.

One endpoint, POST /mcp, speaking JSON-RPC as MCP's streamable HTTP transport allows: a plain JSON reply
per request, no session. Four read-only tools. Everything they return is the same sourced Cala data the
web app shows; the text is assembled in code, never by a language model.
"""
from __future__ import annotations

import asyncio
import os
from typing import Awaitable, Callable

from . import extras, graph, walk

PUBLIC_URL = os.environ.get("SOFTYES_PUBLIC_URL", "https://soft-yes.fly.dev").rstrip("/")
VERSIONS = ("2025-06-18", "2025-03-26", "2024-11-05")
STAGES = ["PRE_SEED", "SEED", "SERIES_A", "SERIES_B", "SERIES_C"]
FIRST_ANSWER_S = 45   # an assistant should not wait longer than this; the rest is on the run's page

TIER_LABEL = {t["id"]: t["label"].lower() for t in walk.TIERS}

TOOLS = [
    {"name": "find_lead",
     "title": "Find a lead investor",
     "description": "A founder has investors who said \"we're in if you find a lead\". Give their names. Returns the investors "
                    "who led the rounds those investors joined before, ranked by how often they led next to them and whether "
                    "they still lead, with the shared round and its source for each, which investor to ask for the intro, and "
                    "whether each soft-yes investor itself leads or follows. Data: Cala's funding graph, every fact sourced.",
     "inputSchema": {"type": "object", "required": ["investors"], "properties": {
         "investors": {"type": "array", "minItems": 1, "maxItems": 6, "items": {"type": "string"},
                       "description": "Names of the investors who gave a soft yes, e.g. [\"Tesi\", \"Innovestor\"]"},
         "stage": {"type": "string", "enum": STAGES, "description": "The round being raised (optional)"}}},
     "annotations": {"readOnlyHint": True, "openWorldHint": True}},
    {"name": "check_investor",
     "title": "Does this investor lead or follow?",
     "description": "For one investor: how many of its rounds in Cala it led, whether it leads or follows by habit, and who "
                    "led when it followed.",
     "inputSchema": {"type": "object", "required": ["name"], "properties": {"name": {"type": "string"}}},
     "annotations": {"readOnlyHint": True, "openWorldHint": True}},
    {"name": "draft_intro",
     "title": "Write the intro request",
     "description": "After find_lead: writes the message for one lead from that run's facts only. kind 'intro_ask' goes to the "
                    "investor who said yes, asking for the introduction; 'direct' goes to the lead; 'slush' is a meeting note "
                    "under 300 characters. Returns the message and the facts it was written from.",
     "inputSchema": {"type": "object", "required": ["run_id", "lead"], "properties": {
         "run_id": {"type": "string", "description": "run_id returned by find_lead"},
         "lead": {"type": "string", "description": "The lead's name as find_lead returned it"},
         "kind": {"type": "string", "enum": ["intro_ask", "direct", "slush"]},
         "company": {"type": "string", "description": "The founder's company name"},
         "one_liner": {"type": "string", "description": "What the company does, one sentence"},
         "raising": {"type": "string", "description": "The round being raised, e.g. \"€4M Series A\""}}},
     "annotations": {"readOnlyHint": True, "openWorldHint": True}},
    {"name": "who_led",
     "title": "Who led this company's rounds, by the page",
     "description": "For one company: each funding round Cala holds, who Cala says led it, and what the page Cala cites for "
                    "that round says, quoted word for word. A lead the page credits to someone else is marked corrected. "
                    "Use it to check a \"led by\" claim before repeating it.",
     "inputSchema": {"type": "object", "required": ["company"], "properties": {
         "company": {"type": "string", "description": "The company's name, e.g. \"Verda\""}}},
     "annotations": {"readOnlyHint": True, "openWorldHint": True}},
]

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


class Server:
    """`suggest(name)` resolves a name to Cala entities, `run(inputs, emit)` walks, `load(run_id)` reads a stored run."""

    def __init__(self, suggest: Callable[[str], Awaitable[dict]], run: Callable[[dict, Callable], Awaitable[dict]],
                 load: Callable[[str], dict | None], check: Callable[[str], Awaitable[dict]] | None = None):
        self.suggest, self.run, self.load, self.check = suggest, run, load, check

    async def who_led(self, args: dict) -> dict:
        name = str(args.get("company") or "").strip()
        if len(name) < 2 or not self.check:
            return _error("Name a company, e.g. {\"company\": \"Verda\"}.")
        d = await self.check(name)
        if not d.get("company"):
            return _error(f"Cala does not know a company called {name}.")
        co = d["company"]["name"]
        if not d["rounds"]:
            n = d.get("investors_in_cala")
            return {"content": [{"type": "text", "text": f"Cala holds no funding rounds for {co}"
                                 + (f", only {n} investors without their rounds, so there is no lead claim to check."
                                    if n else ".")}], "isError": False,
                    "structuredContent": {"company": co, "rounds": []}}
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

    async def _resolve(self, names: list[str]) -> tuple[list[dict], list[str]]:
        softs, unknown = [], []
        for name in names[:6]:
            items = (await self.suggest(str(name)[:60]))["items"]
            if not items:
                unknown.append(str(name))
                continue
            it = items[0]
            softs.append({"name": it["name"], "ids": it["ids"][:6], "kind": it.get("kind", "fund")})
        return softs, unknown

    async def _walk(self, inputs: dict) -> tuple[dict, bool]:
        first: dict = {}

        async def emit(event: dict) -> None:
            if event["t"] == "partial":
                first["result"] = event["result"]

        task = asyncio.create_task(self.run(inputs, emit))
        try:
            return await asyncio.wait_for(asyncio.shield(task), FIRST_ANSWER_S), False
        except asyncio.TimeoutError:
            if "result" in first:
                return first["result"], True   # the walk goes on in the background and is stored when done
            return await task, False

    async def find_lead(self, args: dict) -> dict:
        names = args.get("investors")
        if isinstance(names, str):
            names = [names]
        if not names:
            return _error("Give at least one investor who said yes, e.g. {\"investors\": [\"Tesi\"]}.")
        softs, unknown = await self._resolve(names)
        if not softs:
            return _error(f"Cala does not know an investor called {' or '.join(unknown)}. Check the spelling.")
        stage = args.get("stage") if args.get("stage") in STAGES else None
        result, partial = await self._walk({"soft_yeses": softs, "stage": stage, "company": None, "deep": False})
        text = result_text(result, partial)
        if unknown:
            text += f"\nNot found in Cala, so left out: {', '.join(unknown)}."
        return {"content": [{"type": "text", "text": text}], "structuredContent": result_data(result), "isError": False}

    async def check_investor(self, args: dict) -> dict:
        softs, unknown = await self._resolve([args.get("name") or ""])
        if not softs:
            return _error(f"Cala does not know an investor called {args.get('name')}.")
        result, _ = await self._walk({"soft_yeses": softs, "stage": None, "company": None, "deep": False})
        s = result["soft_yeses"][0]
        out = [f"# {s['name']}: {s['verdict']}", "", s["insight"]]
        if s.get("usual_leads"):
            out += ["", "Who led when it followed: " + ", ".join(f"{u['name']} ({u['deals']})" for u in s["usual_leads"])]
        for d in (s.get("followed_rounds") or [])[:6]:
            lead = f", led by {' and '.join(d['leads'])}" if d.get("leads") else ""
            out.append(f"- {_deal(d)}{lead}{_src(d.get('sources') or [])}")
        out += ["", f"Every round and source: {PUBLIC_URL}/r/{result['run_id']}"]
        return {"content": [{"type": "text", "text": "\n".join(out)}],
                "structuredContent": {"name": s["name"], "verdict": s["verdict"], "insight": s["insight"],
                                      "rounds": s.get("rounds_in_cala"), "led": s.get("led"), "run_id": result["run_id"]},
                "isError": False}

    async def draft_intro(self, args: dict) -> dict:
        result = self.load(str(args.get("run_id") or ""))
        if not result:
            return _error("No such run. Call find_lead first and pass its run_id.")
        want = graph.norm(str(args.get("lead") or ""))
        pool = result["leads"] + result["second_ring"]
        lead = next((e for e in pool if e["key"] == want), None) or next((e for e in pool if want and want in e["key"]), None)
        if not lead:
            return _error("That run has no such lead. Leads in it: " + ", ".join(e["name"] for e in result["leads"][:12]))
        kind = args.get("kind") if args.get("kind") in ("intro_ask", "direct", "slush") else "intro_ask"
        founder = {k: str(args.get(k) or "")[:200] for k in ("company", "one_liner", "raising")}
        d = await extras.draft(result, lead, kind, founder)
        text = (f"Subject: {d['subject']}\n\n" if d.get("subject") else "") + d["body"] + "\n\n---\n" + d["note"] + \
            "\nFacts it was written from:\n" + "\n".join(f"- {f}" for f in d["facts"])
        return {"content": [{"type": "text", "text": text}],
                "structuredContent": {"subject": d.get("subject"), "body": d["body"], "facts": d["facts"],
                                      "written_by": d.get("model") or "template", "checked_against_facts": True},
                "isError": False}

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
                       "capabilities": {"tools": {"listChanged": False}},
                       "serverInfo": {"name": "soft-yes", "title": "Soft Yes", "version": "1.0.0"},
                       "instructions": "Soft Yes finds who could lead a funding round, starting from the investors who told a "
                                       "founder \"we're in if you find a lead\". Call find_lead with their names, then draft_intro "
                                       "for the lead the founder picks. Every fact comes from Cala with its source; quote the "
                                       "sources, and do not add facts of your own to the drafts."})
        if method == "ping":
            return ok({})
        if method == "tools/list":
            return ok({"tools": TOOLS})
        if method == "tools/call":
            fn = {"find_lead": self.find_lead, "check_investor": self.check_investor, "draft_intro": self.draft_intro,
                  "who_led": self.who_led}.get(params.get("name"))
            if not fn:
                return {"jsonrpc": "2.0", "id": mid, "error": {"code": -32602, "message": f"Unknown tool: {params.get('name')}"}}
            try:
                return ok(await fn(params.get("arguments") or {}))
            except Exception as exc:  # noqa: BLE001 - a tool failure is a result the assistant can read, not a crash
                return ok(_error(f"Soft Yes could not finish: {type(exc).__name__}: {exc}"[:300]))
        if method in ("resources/list", "prompts/list"):
            return ok({method.split("/")[0]: []})
        return {"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": f"Method not found: {method}"}}


def _error(text: str) -> dict:
    return {"content": [{"type": "text", "text": text}], "isError": True}
