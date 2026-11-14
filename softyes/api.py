"""HTTP API for Soft Yes. Serves the built frontend from web/dist."""
from __future__ import annotations

import asyncio
import difflib
import collections
import json
import os
import re
import secrets
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.encoders import jsonable_encoder
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse

from . import cala as cala_mod
from . import extras, graph, knowledge, mcp as mcp_mod, pagecheck, walk as walk_mod
from .cala import BASE, CREDIT_CAP, BudgetExceeded, CalaError, Ledger

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "web" / "dist"
FRAMING = os.environ.get("SOFTYES_FRAMING", "softyes")  # softyes | investor_check | conflict_check

EXAMPLES = [
    {"id": "nordic-deeptech", "title": "Tesi + Innovestor", "blurb": "Nordic deep tech, Series A",
     "soft_yeses": [{"name": "Tesi", "ids": ["df5be140-d50e-4e21-bb4f-d8f1e4ad3959"], "kind": "fund"},
                    {"name": "Innovestor", "ids": ["6a966907-4006-4a4b-8d11-2330f76cb3cd"], "kind": "fund"}],
     "stage": "SERIES_A"},
    {"id": "eic", "title": "EIC Fund", "blurb": "EIC Accelerator equity needs a lead investor",
     "soft_yeses": [{"name": "EIC Fund", "ids": ["02a2a281-4d2f-4647-9af3-cae7ac067489"], "kind": "fund"}],
     "stage": "SERIES_A"},
    {"id": "seed-europe", "title": "Seedcamp + Bpifrance", "blurb": "European seed",
     "soft_yeses": [{"name": "Seedcamp", "ids": ["d2d11954-6bab-5ac9-8684-a54406623104",
                                                  "aa87dde8-7dc3-4fc0-957f-143da6ddc0b7"], "kind": "fund"},
                    {"name": "Bpifrance", "ids": ["340af901-9ea9-424b-b09d-ec471bbe4f63",
                                                   "96cc5581-3419-4dc9-bb45-828af172ac35",
                                                   "b8f60f04-9fb0-4a59-8913-8ad92cba937c"], "kind": "fund"}],
     "stage": "SEED"},
]

# Real companies, walked from the investors Cala lists in them. `ids`: the Cala entities the company is held under.
REAL = [
    {"id": "cala", "ids": ["81cfdabc-53f7-426a-b358-a942e159ca0f", "2bdea5e8-a630-4098-9fb1-3f84bbaa77a2"]},
    {"id": "context", "ids": ["d6caeb7d-27ca-4967-b7f3-86b207310fa0"]},
    {"id": "flow", "ids": ["f1970456-a6e4-4b95-91a8-58c5a92d9bfe"]},
    {"id": "verda", "ids": ["3d3edba6-f4d7-432b-80d3-d07872e11def"]},
    {"id": "afterquery", "ids": ["f50e8c58-4d32-4395-978b-5f0be8cfa7d8"]},
]

INDEX: dict[str, dict] = {}   # norm(name) -> {key, name, ids, kind, type, description, rounds}
ISSUERS: dict[str, dict] = {}   # company id -> {id, name, rounds}: companies Cala holds a funding round for


def _index_add(uid: str, name: str, etype: str | None, description: str | None = None, rounds: int = 0) -> None:
    name = graph.pretty(name)
    key = graph.norm(name)
    if not key or not uid:
        return
    e = INDEX.setdefault(key, {"key": key, "name": name, "ids": [], "kind": graph.kind(etype), "type": etype,
                               "description": None, "rounds": 0})
    if uid not in e["ids"]:
        e["ids"].append(uid)
    # Several Cala entities can share one name (a Swedish shell company and the Helsinki fund). The description shown
    # is the one that reads like an investor, and an organisation's before a company's.
    fit = (2 if description and graph.INVESTOR_WORDS.search(description) else 0) + (1 if etype == "Organization" else 0)
    if description and (not e["description"] or fit > e.get("_fit", 0)):
        e["description"], e["_fit"] = description, fit
    if e["name"].isupper() and not name.isupper():
        e["name"] = name
    e["rounds"] += rounds


def _index_response(url: str, body, resp: dict) -> None:
    """Learn investor names from anything Cala already told us, so autocomplete costs nothing."""
    if "/entities?" in url:
        for x in resp.get("entities", []):
            if x.get("entity_type") in ("Company", "Organization", "Person"):
                _index_add(x["id"], x["name"], x.get("entity_type"), x.get("description"))
    elif body == graph.ROUND_BODY:
        for x in ((resp.get("relationships") or {}).get("incoming") or {}).get("PARTICIPATES_IN_FUNDING_ROUND", []):
            if (x.get("properties") or {}).get("role") in (None, "INVESTOR"):
                _index_add(x["id"], x["name"], x.get("entity_type"), None, 1)
            elif (x.get("properties") or {}).get("role") == "ISSUER" and x.get("id") and x.get("name"):
                co = ISSUERS.setdefault(x["id"], {"id": x["id"], "name": graph.pretty(x["name"]), "rounds": set(),
                                                  "description": x.get("description")})
                co["rounds"].add(resp.get("id") or url)
    elif body == graph.COMPANY_BODY and resp.get("id") and resp.get("name"):
        inv = ((resp.get("relationships") or {}).get("incoming") or {}).get("INVESTED_IN", [])
        out = ((resp.get("relationships") or {}).get("outgoing") or {}).get("PARTICIPATES_IN_FUNDING_ROUND", [])
        if inv or out:   # a company read before, with investors or rounds on record
            co = ISSUERS.setdefault(resp["id"], {"id": resp["id"], "name": graph.pretty(resp["name"]), "rounds": set(),
                                                 "description": None})
            co["rounds"].update(r["id"] for r in out)
            co["investors"] = len(inv)
            co["description"] = co.get("description") or ((resp.get("properties") or {}).get("description") or {}).get("value") \
                or resp.get("description")
    elif body == graph.INVESTOR_BODY and resp.get("name"):
        _index_add(resp["id"], resp["name"], resp.get("entity_type"), resp.get("description"))


def _index_walked(result: dict) -> None:
    """Remember how many rounds Cala holds for each investor a walk read, so the picker shows the count the result shows."""
    for s in result.get("soft_yeses", []):
        e = INDEX.get(graph.norm(s["name"]))
        if e and s.get("rounds_in_cala"):
            e["walked"] = s["rounds_in_cala"]
    for x in result.get("leads", []) + result.get("second_ring", []):
        e = INDEX.get(x["key"])
        if e and (x.get("pulse") or {}).get("rounds") and not e.get("walked"):
            e["walked"] = x["pulse"]["rounds"]


def build_index() -> None:
    INDEX.clear()
    ISSUERS.clear()
    c = cala_mod.get()
    with c.dblock:
        rows = c.db.execute("select url, body, response from calls").fetchall()
        runs = c.db.execute("select result from runs order by created").fetchall() \
            if c.db.execute("select 1 from sqlite_master where name='runs'").fetchone() else []
    for url, body, resp in rows:
        try:
            _index_response(url, json.loads(body) if body else None, json.loads(resp))
        except (ValueError, KeyError, TypeError):
            continue
    for (result,) in runs:
        try:
            _index_walked(json.loads(result))
        except (ValueError, KeyError, TypeError):
            continue


@asynccontextmanager
async def lifespan(app: FastAPI):
    c = cala_mod.get()
    cala_mod.import_research_cache(c)
    with c.dblock:
        c.db.execute("create table if not exists runs(run_id text primary key, created real, inputs text, result text)")
        c.db.execute("create table if not exists blobs(key text primary key, created real, value text)")
    build_index()
    warm = asyncio.create_task(extras.slush_firms())  # who is at Slush: read once, in the background
    yield
    warm.cancel()


BACKGROUND: set[asyncio.Task] = set()   # walks that outlive the request that started them
WARMING: set[str] = set()               # run ids being walked ahead of the founder asking
PATIENCE = 8.0   # seconds an answer may take before it is sent behind a trickle of spaces


async def _patient(work) -> Response:
    """A quick answer goes out as usual. A slow one starts the reply and sends a space every few seconds until the
    JSON is ready: a proxy hangs up on a line that stays silent for a minute, and JSON may begin with spaces.
    The work goes on if the reader leaves, so what it fetched is kept."""
    task = asyncio.ensure_future(work)
    BACKGROUND.add(task)
    task.add_done_callback(BACKGROUND.discard)
    task.add_done_callback(lambda t: t.cancelled() or t.exception())
    done, _ = await asyncio.wait({task}, timeout=PATIENCE)
    if done:
        return JSONResponse(jsonable_encoder(task.result()))

    async def body():
        while not task.done():
            yield b" "
            await asyncio.wait({task}, timeout=PATIENCE)
        try:
            out = jsonable_encoder(task.result())
        except HTTPException as exc:
            out = {"failed": exc.status_code, "detail": str(exc.detail)}
        except CalaError as exc:
            out = {"failed": 503 if isinstance(exc, BudgetExceeded) else 502, "detail": str(exc)}
        except Exception as exc:  # noqa: BLE001 - the reply has started, so the failure travels in it
            out = {"failed": 500, "detail": f"{type(exc).__name__}: {exc}"[:300]}
        yield json.dumps(out, ensure_ascii=False).encode()

    return StreamingResponse(body(), media_type="application/json",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Content-Encoding": "identity"})

app = FastAPI(title="Soft Yes", lifespan=lifespan)
app.add_middleware(GZipMiddleware, minimum_size=800)  # event streams are left alone


class Visitor:
    """Names who is asking, so the Cala client can keep one visitor from spending everyone's credits. Only on the public
    host (its proxy sends the caller's address); local work is not counted."""

    def __init__(self, inner) -> None:
        self.inner = inner

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.inner(scope, receive, send)
        headers = {k: v for k, v in scope["headers"]}
        address = headers.get(b"fly-client-ip", b"").decode("latin1")
        if not address:
            return await self.inner(scope, receive, send)
        m = re.search(r"(?:^|;\s*)sy_v=([A-Za-z0-9_-]{16,40})", headers.get(b"cookie", b"").decode("latin1"))
        fresh = None if m else secrets.token_urlsafe(16)
        token = cala_mod.VISITOR.set((m.group(1) if m else fresh, address))

        async def reply(message):
            if fresh and message["type"] == "http.response.start":
                cookie = f"sy_v={fresh}; Path=/; Max-Age=2592000; SameSite=Lax; Secure".encode()
                message = {**message, "headers": [*message.get("headers", []), (b"set-cookie", cookie)]}
            await send(message)

        try:
            await self.inner(scope, receive, reply)
        finally:
            cala_mod.VISITOR.reset(token)


app.add_middleware(Visitor)


def _credits() -> dict:
    c = cala_mod.get()
    left = cala_mod.visitor_left()
    return {"used": c.credits_used(), "cap": CREDIT_CAP, "cached_calls": c.total_cached(),
            **({"yours_left_today": left, "yours_a_day": cala_mod.VISITOR_CAP} if left is not None else {})}


@app.get("/api/config")
async def config():
    return {"framing": FRAMING, "stages": [{"id": s, "name": graph.STAGE_NAMES[s]} for s in graph.STAGE_ORDER[:5]],
            "credits": _credits(), "index_size": len(INDEX), "gemini": extras.gemini_ready(),
            "oxylabs": extras.oxylabs_ready(), "slush": extras.slush_directory(), "mcp": f"{mcp_mod.PUBLIC_URL}/mcp"}


@app.get("/api/examples")
async def examples():
    """The examples, each investor with every Cala entity the autocomplete would give it."""
    out = []
    for ex in EXAMPLES:
        softs = []
        for s_ in ex["soft_yeses"]:
            fam = next((f for f in _families(_local_hits(s_["name"], 20), 3, s_["name"])
                        if f["key"] == graph.norm(s_["name"])), None)
            ids = list(dict.fromkeys(s_["ids"] + (fam["ids"] if fam else [])))[:6]
            softs.append({**s_, "ids": ids})
        out.append({**ex, "soft_yeses": softs})
    real = []
    for ex in REAL:   # only from what is stored: an example never spends a credit
        try:
            d = await _company(ex["ids"], cache_only=True)
        except CalaError:
            d = None
        inputs = _company_inputs(d) if d else None
        if not inputs:
            continue
        stored = load_run(walk_mod.run_id(inputs))
        if not stored or stored.get("pending"):
            continue
        names = [s["name"] for s in inputs["soft_yeses"]]
        real.append({"id": ex["id"], "title": d["name"], "blurb": "From " + (names[0] if len(names) == 1 else ", ".join(names[:-1]) + " and " + names[-1]),
                     "soft_yeses": inputs["soft_yeses"], "stage": inputs["stage"], "company": inputs["company"],
                     "found": {"leads": len(stored["leads"]), "run_id": stored["run_id"],
                               "first": stored["leads"][0]["name"] if stored["leads"] and (stored.get("start") or {}).get("mode") in ("pick", "tie") else None}})
    return {"examples": out, "real": real}


def _local_hits(q: str, limit: int) -> list[dict]:
    nq = graph.norm(q)
    if not nq:
        return []
    words = q.lower().split()
    hits = []
    for e in INDEX.values():
        name = e["name"].lower()
        parts = re.findall(r"[a-z0-9åäöüéèñøæ]+", name)
        if e["key"].startswith(nq):
            tier = 0
        elif all(any(w.startswith(x) for w in name.split()) for x in words):
            tier = 1
        elif len(nq) >= 4 and any("".join(parts[n:]).startswith(nq) for n in range(1, len(parts))):
            tier = 2   # what was typed starts a later word of the name, not the middle of one ("Lockheed MartIN VENTUREs")
        else:
            continue
        hits.append((tier, -e["rounds"], len(e["name"]), e))
    hits.sort(key=lambda h: h[:3])
    out: list[dict] = []
    for *_, e in hits:
        # "Lifeline Ventures Fund IV" under "Lifeline Ventures": keep the one with a track record
        if any(e["key"].startswith(o["key"]) and o["rounds"] > 0 and e["rounds"] == 0 for o in out):
            continue
        out.append(e)
    return out[:limit]


def _investor_like(e: dict) -> bool:
    return e["rounds"] > 0 or bool(graph.INVESTOR_WORDS.search(f"{e['name']} {e.get('description') or ''}"))


def _families(hits: list[dict], limit: int, q: str = "") -> list[dict]:
    """Cala often holds one firm as several entities (the manager and each fund vehicle). Offer them as one investor."""
    out, done = [], set()
    for e in hits:
        if e["key"] in done:
            continue
        fam = graph.family(e["name"]) if e["type"] != "Person" and _investor_like(e) else None
        members = [e]
        if fam:
            members += [o for o in INDEX.values() if o["key"] != e["key"] and o["type"] != "Person"
                        and _investor_like(o) and "→" not in o["name"]
                        and (graph.family(o["name"]) == fam or o["key"] == fam)]
        members.sort(key=lambda m: (-m["rounds"], len(m["name"])))
        done.update(m["key"] for m in members)
        head = min(members, key=lambda m: (-m["rounds"], not graph.INVESTOR_WORDS.search(m["name"]), len(m["name"])))
        ids = [i for m in members for i in m["ids"]][:6]
        described = sorted((m for m in members if m.get("description")), key=lambda m: (-m.get("_fit", 0), -m["rounds"]))
        out.append({**head, "ids": ids, "rounds": sum(m["rounds"] for m in members),
                    "walked": max((m.get("walked") or 0 for m in members), default=0),
                    "description": described[0]["description"] if described else None,
                    "entities": [{"name": m["name"], "ids": m["ids"]} for m in members][:6]})
    nq = graph.norm(q)
    # the name as typed first, then the firm Cala knows best; a marketing agency called Seaya goes below Seaya Ventures
    def place(f: dict) -> int:
        typed = f["key"].startswith(nq) or (graph.root(f["name"])[0] or "").startswith(nq)
        exact = nq in (f["key"], graph.root(f["name"])[0])
        # an investor called what was typed, the exact name, a name that starts with it, then names that only contain it
        return 0 if _investor_like(f) and exact else 1 if _investor_like(f) and typed else 2 if exact else 3 if typed else \
            4 if _investor_like(f) else 5

    out.sort(key=lambda f: (place(f), -(f["rounds"] + 3 * len(f["entities"])), len(f["name"])))
    return out[:limit]


NICKNAMES = {"a16z": "Andreessen Horowitz", "yc": "Y Combinator", "usv": "Union Square Ventures",
             "nea": "New Enterprise Associates", "kp": "Kleiner Perkins", "gc": "General Catalyst", "lsvp": "Lightspeed",
             # names an investor used to carry, or carries in full
             "finnishindustryinvestment": "Tesi", "suomenteollisuussijoitus": "Tesi", "teollisuussijoitus": "Tesi",
             "europeaninnovationcouncil": "EIC Fund", "europeaninnovationcouncilfund": "EIC Fund",
             "andreessen": "Andreessen Horowitz", "ycombinator": "Y Combinator", "kleiner": "Kleiner Perkins",
             "bpi": "Bpifrance", "banquepubliquedinvestissement": "Bpifrance", "eqt": "EQT Ventures"}


def _nickname(q: str) -> str | None:
    nq, typed = graph.norm(q), re.sub(r"[^a-z0-9]", "", q.lower())
    if typed in NICKNAMES or nq in NICKNAMES:
        return NICKNAMES.get(typed) or NICKNAMES[nq]
    return next((v for k, v in NICKNAMES.items() if len(nq) >= 7 and k.startswith(nq)), None)


def _close(q: str, limit: int = 3) -> list[dict]:
    """A misspelt name ("Sequioa", "Andreesen Horowitz"): investors Cala has rounds for whose name is nearly the same."""
    full, first = graph.norm(q), graph.norm(q.split()[0]) if q.split() else ""
    want = graph.root(q)[0] or full
    roots: dict[str, dict] = {}
    for e in INDEX.values():
        if e["rounds"] > 0:
            for r in {graph.root(e["name"])[0] or e["key"], e["key"]}:
                if r not in roots or roots[r]["rounds"] < e["rounds"]:
                    roots[r] = e
    out: list[dict] = []
    # the whole name ("Acel Partnrs" ~ "Accel Partners"), its root, then its first word against well-known firms only
    for w, floor, cutoff in ((want, 1, 0.82), (full, 1, 0.82), (first, 3, 0.86)):
        if len(w) < (5 if w != first else 4):
            continue
        for r in difflib.get_close_matches(w, list(roots), n=limit, cutoff=cutoff):
            # "Zxqv Capital Partners" is not "IQ Capital Partners": the part that is the firm's own has to be close too
            own = graph.root(roots[r]["name"])[0] or roots[r]["key"]
            if w == full and w != want and difflib.SequenceMatcher(None, want, own).ratio() < 0.6:
                continue
            if r != w and roots[r]["rounds"] >= floor and roots[r] not in out:
                out.append(roots[r])
    return out[:limit]


def _related(q: str, name: str) -> bool:
    """Cala's search returns its nearest names even for a name it does not know; keep only real near-matches."""
    a, b = graph.root(q)[0] or graph.norm(q), graph.root(name)[0] or graph.norm(name)
    return bool(a and b) and (a.startswith(b) or b.startswith(a) or difflib.SequenceMatcher(None, a, b).ratio() >= 0.7)


@app.get("/api/suggest")
async def suggest(q: str = "", limit: int = 7):
    q = q.strip()[:60]
    if len(q) < 2:
        return {"items": [], "source": "none"}
    nick = _nickname(q)
    local = _local_hits(q, 20)
    source = "index"
    if len(q) >= 3 and not nick and not any(e["rounds"] for e in local):  # nothing with a track record locally: ask Cala
        try:
            found = await graph.search(cala_mod.get(), q, limit=8)
            for f in found:
                _index_add(f["id"], f["raw_name"], f["type"], f["description"])
            local = _local_hits(q, 20) or [INDEX[graph.norm(f["name"])] for f in found
                                           if graph.norm(f["name"]) in INDEX and _related(q, f["name"])]
            source = "cala"
        except CalaError:
            source = "index"
    near = [] if nick or any(e["rounds"] for e in local) else _close(q)
    items, seen = [], set()
    known_as = _families(_local_hits(nick, 3), 1, nick) if nick else []
    for e in known_as + [{**f, "did_you_mean": True} for f in _families(near, 3, q)] + _families(local, limit, q):
        shown = e["name"].lower()
        if shown in seen:   # two Cala entities that read the same: one row, both ids
            first = next(i for i in items if i["name"].lower() == shown)
            first["ids"] = list(dict.fromkeys(first["ids"] + e["ids"]))[:6]
            first["rounds"] += e["rounds"]
            first["entities"] = (first["entities"] + e.get("entities", []))[:6]
            continue
        seen.add(shown)
        items.append(dict(e))
    nq, out = graph.norm(q), []

    def typed(e: dict) -> bool:   # the name starts with what was typed: "sequoia", "first round", not "capital" or "ventures"
        words = q.lower().split()
        return e["key"].startswith(nq) or (graph.root(e["name"])[0] or "").startswith(nq) or \
            (len(words) >= 2 and e["name"].lower().startswith(words[0])
             and all(any(w.startswith(x) for w in e["name"].lower().split()) for x in words))

    for n, e in enumerate(items[:limit]):
        # `sure`: the row is what was typed (a known other name, the name itself, or the one well-known name that starts
        # with it), with a record in Cala. Enter takes the top row only then; a near miss, a namesake, a word from the
        # middle of a name ("capital") or a start two firms share ("north") has to be chosen.
        exact = nq == e["key"]
        rival = any(typed(o) and o["rounds"] >= e["rounds"] for o in items[1:limit])
        sure = n == 0 and e["rounds"] > 0 and not e.get("did_you_mean") and (bool(nick) or exact or (typed(e) and not rival))
        out.append({**{k: v for k, v in e.items() if not k.startswith("_")}, "known_rounds": e.get("walked") or e["rounds"], "sure": sure})
    return {"items": out, "source": source}


REGISTRY = re.compile(r"^(?:an?\s+)?(?:british|uk|united kingdom|french|italian|german|spanish|swedish|dutch|irish)[\s‑-]"
                      r"(?:based\s+)?[\w\s,&-]{0,60}?(?:company|firm|business)\b.{0,80}?\b(?:founded|incorporated|registered) in \d{4}",
                      re.I)   # a line from a company register, not a description of a startup


def _bare(name: str) -> str:
    """'Cala AI' and 'Cala' are one company to the person typing."""
    key = graph.norm(name)
    for tail in pagecheck.TAILS:
        if key.endswith(tail) and len(key) - len(tail) >= 4:
            return key[:-len(tail)]
    return key


@app.get("/api/companies")
async def companies(q: str = "", limit: int = 6):
    """The picker for the founder's own company. Companies Cala holds a funding round for come first (they are known
    from walks already made, so they cost nothing); a name not among them is put to Cala's own search."""
    q = q.strip()[:60]
    nq = graph.norm(q)
    if len(nq) < 2:
        return {"items": [], "source": "none"}
    rows: dict[str, dict] = {}

    def add(uid: str, name: str, description: str | None, typ: str | None) -> None:
        known = ISSUERS.get(uid) or {}
        rows.setdefault(uid, {"id": uid, "name": graph.pretty(name), "type": typ, "rounds": len(known.get("rounds") or ()),
                              "investors": known.get("investors") or 0,
                              "description": description or known.get("description")})

    def fits(name: str) -> bool:
        key = graph.norm(name)
        return key.startswith(nq) or any(w.startswith(q.lower()) for w in name.lower().split()[1:])

    for co in ISSUERS.values():
        if fits(co["name"]):
            add(co["id"], co["name"], co.get("description"), "Company")
    source = "index"
    if len(q) >= 3 and not any(graph.norm(r["name"]) == nq or _bare(r["name"]) == nq for r in rows.values()):
        try:
            for f in await graph.search(cala_mod.get(), q, limit=8):
                if f["type"] in ("Company", "Organization") and (fits(f["name"]) or _related(q, f["name"])):
                    _index_add(f["id"], f["raw_name"], f["type"], f["description"])
                    add(f["id"], f["name"], f["description"], f["type"])
            source = "cala"
        except CalaError:
            pass
    # one row per company: 'Cala' and 'Cala AI' are the same to the person typing, and the entity with rounds leads
    merged: dict[str, dict] = {}
    for r in sorted(rows.values(), key=lambda r: (-r["rounds"], -r["investors"], bool(REGISTRY.search(r["description"] or "")),
                                                   r["type"] != "Company", len(r["name"]))):
        m = merged.get(_bare(r["name"]))
        registry = bool(REGISTRY.search(r["description"] or ""))
        if m and not (registry and not m["registry"]) and len(m["ids"]) < 4:
            m["ids"].append(r["id"])
            m["description"] = m["description"] or r["description"]
            continue
        if m:
            continue   # a namesake from a company register under a startup of the same name: not offered
        merged[_bare(r["name"])] = {"key": _bare(r["name"]), "name": r["name"], "ids": [r["id"]], "kind": "company",
                                    "type": r["type"], "description": r["description"], "rounds": r["rounds"],
                                    "known_rounds": r["rounds"], "investors": r["investors"], "registry": registry,
                                    "walked": 0, "entities": []}

    def place(m: dict) -> tuple:
        exact = nq in (graph.norm(m["name"]), m["key"])
        return (not (exact and (m["rounds"] or m["investors"])), not exact, not m["rounds"], m["registry"],
                not graph.norm(m["name"]).startswith(nq), -m["rounds"], len(m["name"]))

    items = sorted(merged.values(), key=place)[:limit]
    for n, m in enumerate(items):
        m["sure"] = n == 0 and nq in (graph.norm(m["name"]), m["key"]) and bool(m["rounds"] or m["investors"])
    return {"items": items, "source": source}


def _next_stage(stage: str | None) -> str | None:
    """The round after the one the company has done, among the stages the form offers (Series C stands for C and later)."""
    if stage in graph.STAGE_ORDER:
        return graph.STAGE_ORDER[min(graph.STAGE_ORDER.index(stage) + 1, 4)]
    return None


async def _company(ids: list[str], cache_only: bool = False) -> dict | None:
    """One company from the entities Cala holds it under. The entity with funding rounds decides who its investors
    are; a second entity of the same name only adds to it when the first names none."""
    c = cala_mod.get()
    got = []
    for uid in ids[:4]:
        try:
            d = await graph.company(c, uid, cache_only=cache_only)
        except BudgetExceeded:
            d = await graph.company(c, uid, cache_only=True)
        if d:
            got.append(d)
    if not got:
        return None
    got.sort(key=lambda d: (-len(d["rounds"]), -len(d["investors"])))
    d = dict(got[0])
    d["ids"] = [x["id"] for x in got]
    for other in got[1:]:
        for k in ("description", "website", "founded", "stage", "hq", "total_funding", "currency"):
            d[k] = d.get(k) or other.get(k)
        if not d["investors"]:
            d["investors"] = other["investors"]
    seen: dict[str, dict] = {}
    for inv in d["investors"]:
        _index_add(inv["id"], inv["name"], inv["type"])
        inv["key"] = graph.norm(inv["name"])
        known = INDEX.get(inv["key"], {})
        inv["ids"] = known.get("ids", [inv["id"]])[:6]
        inv["rounds"] = known.get("walked") or known.get("rounds") or 0
        if inv.get("kind") != "person":
            # Cala lists the investor under one of its entities ('General Catalyst Partners'): walk from the whole firm
            fam = next((f for f in _families(_local_hits(inv["name"], 20), 3, inv["name"])
                        if inv["id"] in f["ids"] or any(graph.norm(x["name"]) == inv["key"] for x in f["entities"])), None)
            if fam and (fam["rounds"] > inv["rounds"] or len(fam["ids"]) > len(inv["ids"])):
                inv.update({"name": fam["name"], "key": fam["key"], "rounds": fam.get("walked") or fam["rounds"],
                            "ids": list(dict.fromkeys([inv["id"]] + fam["ids"]))[:6]})
        if inv["key"] in seen:   # two entities of one firm on the cap table: one investor
            seen[inv["key"]]["ids"] = list(dict.fromkeys(seen[inv["key"]]["ids"] + inv["ids"]))[:6]
        else:
            seen[inv["key"]] = inv
    d["investors"] = list(seen.values())
    if d["investors"] or d["rounds"]:
        co = ISSUERS.setdefault(d["id"], {"id": d["id"], "name": d["name"], "rounds": set(), "description": d.get("description")})
        co["rounds"].update(r["id"] for r in d["rounds"])
        co["investors"] = len(d["investors"])
    # who to walk from when the founder only names the company: its funds, the ones Cala knows best first
    funds = sorted((v for v in d["investors"] if v.get("kind") != "person"), key=lambda v: -v["rounds"])
    d["softs"] = [v["key"] for v in funds[:6]]
    d["next_stage"] = _next_stage(d.get("stage"))
    return d


def _company_inputs(d: dict) -> dict | None:
    softs = [{"name": v["name"], "ids": v["ids"], "kind": v.get("kind") or "fund"} for v in d["investors"] if v["key"] in d["softs"]]
    if not softs:
        return None
    return _clean_inputs({"soft_yeses": softs, "stage": d["next_stage"], "company": {"id": d["id"], "ids": d["ids"], "name": d["name"]}})


@app.get("/api/company")
async def company(id: str, warm: bool = True):
    """The founder's own company as Cala knows it: stage, industries, and who already invested. The walk from its
    investors starts in the background at once, so the answer is close when the founder asks for it."""
    ids = [i for i in id.split(",") if len(i) == 36][:4]
    try:
        d = await _company(ids)
    except CalaError as exc:
        raise HTTPException(502, str(exc))
    if not d:
        raise HTTPException(404, "Cala has no such company")
    inputs = _company_inputs(d)
    d["run_id"] = walk_mod.run_id(inputs) if inputs else None
    d["walked"] = bool(inputs and load_run(d["run_id"]))
    if warm and inputs and not d["walked"] and d["run_id"] not in WARMING:
        async def silent(event: dict) -> None:
            return None

        async def ahead() -> None:
            try:
                await _run(inputs, silent)
            except Exception:  # noqa: BLE001 - only a head start; the founder's own walk reports its own failure
                pass
            finally:
                WARMING.discard(d["run_id"])

        WARMING.add(d["run_id"])
        task = asyncio.create_task(ahead())
        BACKGROUND.add(task)
        task.add_done_callback(BACKGROUND.discard)
    return d


def _clean_inputs(body: dict) -> dict:
    softs = []
    for s in (body.get("soft_yeses") or [])[:6]:
        ids = [i for i in (s.get("ids") or []) if isinstance(i, str) and len(i) == 36][:6]
        if ids and s.get("name"):
            softs.append({"name": str(s["name"])[:80], "ids": ids, "kind": s.get("kind", "fund")})
    if not softs:
        raise HTTPException(400, "Name at least one investor who said a soft yes.")
    stage = body.get("stage") if body.get("stage") in graph.STAGE_ORDER else None
    comp = body.get("company") if isinstance(body.get("company"), dict) else None
    if comp:
        ids = [i for i in (comp.get("ids") or []) if isinstance(i, str) and len(i) == 36][:4]
        comp = {"id": comp.get("id"), "name": str(comp.get("name", ""))[:80], **({"ids": ids} if ids else {}),
                **({"blind": True} if comp.get("blind") else {})}
    return {"soft_yeses": softs, "stage": stage, "company": comp, "deep": bool(body.get("deep"))}


def _save_run(inputs: dict, result: dict) -> None:
    c = cala_mod.get()
    with c.dblock:
        c.db.execute("insert or replace into runs values(?,?,?,?)",
                     (result["run_id"], result["created"], json.dumps(inputs), json.dumps(result, ensure_ascii=False)))


def load_run(run_id: str) -> dict | None:
    c = cala_mod.get()
    with c.dblock:
        row = c.db.execute("select result from runs where run_id=?", (run_id,)).fetchone()
    return json.loads(row[0]) if row else None


def _annotate(result: dict) -> dict:
    """Mark who is registered for Slush. Done on read, so a stored run picks up the live directory."""
    for e in result["leads"] + result["second_ring"] + result["soft_yeses"]:
        e["at_slush"] = extras.at_slush(e["name"])
    for e in result["leads"][:SAYS_TOP]:   # what the lead says on its own site, when it has been read already
        e["says"] = extras.says_line(e)
    result["slush"] = {**extras.slush_directory(),
                       "leads_attending": sum(1 for e in result["leads"] if e["at_slush"])}
    return result


async def _run(inputs: dict, emit) -> dict:
    """Two passes. The graph walk comes back in seconds and is shown at once. Investors with few rounds in
    the graph are then read again through Cala's knowledge search, which takes about a minute."""
    aliases = lambda key: list(INDEX.get(key, {}).get("ids", []))  # noqa: E731
    result = await walk_mod.walk(cala_mod.get(), inputs, emit, aliases=aliases)
    deep = {s["key"] for s in result["soft_yeses"]
            if inputs.get("deep") or (s.get("followed") or 0) < walk_mod.DEEP_BELOW}
    if deep:
        result["credits"] = _credits()
        # A first result is stored marked as unfinished, so a page that reloads or loses its stream can wait for the rest.
        result["pending"] = [s["name"] for s in result["soft_yeses"] if s["key"] in deep]
        _save_run(inputs, result)
        await emit({"t": "partial", "run_id": result["run_id"], "result": _annotate(result), "reading": result["pending"]})

        async def quiet(event: dict) -> None:   # the second pass repeats the graph walk from cache: do not replay it
            if event["t"] in ("knowledge", "captable", "note", "ledger") or \
                    (event["t"] == "round" and event.get("via") in ("knowledge", "cap_table")):
                await emit(event)

        result = await walk_mod.walk(cala_mod.get(), inputs, quiet, aliases=aliases, deep=deep)
    result["credits"] = _credits()
    _save_run(inputs, result)
    if result["page_check"]["late"]:
        # Some cited pages were slow. They are still being read: walk once more when they are in, and store that.
        async def settle() -> None:
            await pagecheck.settle(90)

            async def silent(event: dict) -> None:
                return None

            again = await walk_mod.walk(cala_mod.get(), inputs, silent, aliases=aliases, deep=deep or None)
            again["credits"] = _credits()
            _save_run(inputs, again)

        late = asyncio.create_task(settle())
        BACKGROUND.add(late)
        late.add_done_callback(BACKGROUND.discard)
    _annotate(result)
    for s in result["soft_yeses"]:
        for uid in s["ids"]:
            _index_add(uid, s["name"], None, s.get("description"), 0)
    for e in result["leads"] + result["second_ring"]:
        for uid in e["ids"]:
            _index_add(uid, e["name"], "Person" if e["kind"] == "person" else None, None, 0)
    _index_walked(result)
    for e in result["leads"] + result["second_ring"]:   # companies met on this walk: the company picker knows them from now on
        for d in e["evidence"]:
            iss = d.get("issuer") or {}
            if iss.get("id") and iss.get("name"):
                ISSUERS.setdefault(iss["id"], {"id": iss["id"], "name": iss["name"], "rounds": set(),
                                               "description": None})["rounds"].add(d["id"])
    return result


@app.post("/api/walk")
async def walk(request: Request):
    """Server-sent events: one `data: {...}` line per step of the walk, then {"t": "done", "result": ...}."""
    inputs = _clean_inputs(await request.json())
    queue: asyncio.Queue = asyncio.Queue()

    async def emit(event: dict) -> None:
        await queue.put(event)

    async def work() -> None:
        try:
            result = await _run(inputs, emit)
            await queue.put({"t": "done", "run_id": result["run_id"], "result": result})
        except Exception as exc:  # noqa: BLE001 - the stream must always end with a message
            await queue.put({"t": "error", "message": f"{type(exc).__name__}: {exc}"[:300]})
        await queue.put(None)

    task = asyncio.create_task(work())

    async def stream():
        try:
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), 10)
                except asyncio.TimeoutError:
                    yield ": still walking\n\n"   # the knowledge pass can be silent for a minute; keep the line open
                    continue
                if event is None:
                    break
                yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
        finally:
            if not task.done():
                await asyncio.shield(task)  # finish the walk so its calls are cached even if the tab closes

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


async def _holdout(run_id: str) -> dict:
    """The walk put to the test on the founder's own last round. Cala says who led it and the page is read. That lead
    is taken out of the starting investors, the company's own rounds are left out, and the walk runs from the rest:
    does it still reach the investor who led?"""
    result = load_run(run_id)
    if not result:
        raise HTTPException(404, "No such run")
    comp = (result.get("input") or {}).get("company") or {}
    if not comp.get("id"):
        return {"company": None}
    hit = extras.blob_get("holdout:" + run_id)
    if hit and hit.get("created", 0) >= result.get("created", 0) - 5:
        return hit
    c = cala_mod.get()
    out = {"company": {"id": comp["id"], "name": comp.get("name")}, "round": None, "created": time.time()}
    rounds = []
    for cid in (comp.get("ids") or [comp["id"]]):
        try:
            got = await walk_mod.check_company(c, cid, comp.get("name") or "")
        except BudgetExceeded:
            continue
        rounds += [r for r in got["rounds"] if any(i["is_lead"] for i in r["investors"])]
    rounds.sort(key=lambda r: r.get("date") or "", reverse=True)
    if not rounds:
        extras.blob_put("holdout:" + run_id, out)
        return out
    rd = rounds[0]
    leads = [i for i in rd["investors"] if i["is_lead"]]
    lead_keys = {graph.norm(i["name"]) for i in leads}
    softs = [s for s in result["input"]["soft_yeses"] if graph.norm(s["name"]) not in lead_keys]
    out["round"] = {"stage": rd.get("stage"), "stage_name": rd.get("stage_name"), "date": rd.get("date"),
                    "amount": rd.get("amount"), "currency": rd.get("currency"),
                    "leads": [{"name": i["name"], "check": i.get("check")} for i in leads]}
    out["from"] = [s["name"] for s in softs]
    if not softs:
        out["skipped"] = "The only investor to start from is the one who led."
        extras.blob_put("holdout:" + run_id, out)
        return out

    async def silent(event: dict) -> None:
        return None

    inputs = _clean_inputs({"soft_yeses": [{**s, "kind": "fund"} for s in softs], "stage": rd.get("stage"),
                            "company": {**comp, "blind": True}})
    again = load_run(walk_mod.run_id(inputs))
    if not again or again.get("pending") or "own" not in again:
        again = await _run(inputs, silent)
    found = []
    for i in leads:
        key = graph.norm(i["name"])
        e = next((e for e in again["leads"] if e["key"] == key or (i.get("id") and i["id"] in e["ids"])
                  or graph.family(e["name"]) == (graph.family(i["name"]) or key)), None)
        if e:
            found.append({"name": e["name"], "key": e["key"], "rank": e["rank"], "tier": e["tier"],
                          "through": [{"company": d["issuer"]["name"], "stage_name": d["stage_name"], "date": d["date"],
                                       "with": d["with"], "check": d.get("check"), "via": d.get("via")} for d in e["evidence"][:3]]})
    found.sort(key=lambda f: f["rank"])
    out.update({"run_id": again["run_id"], "of": len(again["leads"]), "found": found,
                "top": [e["name"] for e in again["leads"][:3]]})
    extras.blob_put("holdout:" + run_id, out)
    return out


@app.get("/api/holdout")
async def holdout(run_id: str):
    return await _patient(_holdout(run_id))


@app.get("/api/run/{run_id}")
async def run(run_id: str):
    result = load_run(run_id)
    if not result:
        raise HTTPException(404, "No such run")
    if result.get("pending") and time.time() - result["created"] > 240:
        result.pop("pending")   # the second pass never reported back (a restart): the first result stands
    return _annotate(result)


@app.get("/api/investor")
async def investor(ids: str, name: str = ""):
    """Investor check: does this investor lead or follow, and who leads when it follows?"""
    return await _patient(_investor(ids, name))


async def _investor(ids: str, name: str = "") -> dict:
    id_list = [i for i in ids.split(",") if len(i) == 36][:6]   # as many as a soft yes carries, so both share one walk
    if not id_list:
        raise HTTPException(400, "ids required")
    c = cala_mod.get()
    if not name:
        inv = await graph.investor(c, id_list[0])
        name = inv["name"] if inv else "Investor"
    inputs = {"soft_yeses": [{"name": name, "ids": id_list, "kind": "fund"}], "stage": None, "company": None}

    # Answer with the first result. A thin record is read further in the background and stored; the page waits for it.
    first: dict = {}
    got = asyncio.Event()

    async def emit(event: dict) -> None:
        if event["t"] == "partial":
            first["result"] = event["result"]
            got.set()

    task = asyncio.create_task(_run(inputs, emit))
    BACKGROUND.add(task)
    task.add_done_callback(BACKGROUND.discard)
    waiter = asyncio.create_task(got.wait())
    await asyncio.wait({task, waiter}, return_when=asyncio.FIRST_COMPLETED)
    waiter.cancel()
    try:
        result = dict(task.result() if task.done() else first["result"])
    except BudgetExceeded as exc:
        raise HTTPException(503, str(exc)) from exc
    except CalaError as exc:
        raise HTTPException(502, f"Cala did not answer: {exc}"[:200]) from exc
    result["profile"] = await extras.best_profile(c, {"id": id_list[0], "ids": id_list})
    return result


def _lead(run_id: str, lead_key: str) -> tuple[dict, dict]:
    result = load_run(run_id)
    if not result:
        raise HTTPException(404, "No such run")
    lead = next((e for e in result["leads"] + result["second_ring"] if e["key"] == lead_key), None)
    if not lead:
        raise HTTPException(404, "No such lead in this run")
    return result, lead


@app.post("/api/draft")
async def draft(request: Request):
    body = await request.json()
    result, lead = _lead(body.get("run_id", ""), body.get("lead_key", ""))
    kind = body.get("kind") if body.get("kind") in ("intro_ask", "direct", "slush") else "intro_ask"
    founder = {k: str((body.get("founder") or {}).get(k, ""))[:200] for k in ("company", "one_liner", "raising", "name")}
    return await _patient(extras.draft(result, lead, kind, founder, llm=body.get("llm", True) is not False))


@app.get("/api/says")
async def says(run_id: str, lead_key: str):
    """What the lead says on its own site (Oxylabs + Gemini, quotes checked verbatim) next to what Cala shows it did."""
    result, lead = _lead(run_id, lead_key)
    return await _patient(extras.says(cala_mod.get(), lead))


SAYS_TOP = 5   # the leads whose own site is read without being asked


@app.get("/api/says/top")
async def says_top(run_id: str):
    """Says vs did for the first leads of a run, one line each: the fund's own sentence from its site (Oxylabs reads the
    site, Gemini points at sentences, code keeps only those found on the page word for word) next to Cala's count."""
    result = load_run(run_id)
    if not result:
        raise HTTPException(404, "No such run")
    leads = result["leads"][:SAYS_TOP]

    async def one(lead: dict) -> dict:
        try:
            got = await asyncio.wait_for(extras.says(cala_mod.get(), lead), 75)
        except Exception as exc:  # noqa: BLE001  one slow or broken site must not hide the others
            return {"key": lead["key"], "name": lead["name"], "says": None, "reason": f"{type(exc).__name__}"[:60]}
        return {"key": lead["key"], "name": lead["name"], "says": extras.says_line(lead, got), "reason": got.get("reason")}

    async def work() -> dict:
        return {"run_id": run_id, "items": list(await asyncio.gather(*(one(e) for e in leads)))}

    return await _patient(work())


@app.get("/api/conflicts")
async def conflicts(run_id: str, lead_key: str, company_id: str = "", about: str = ""):
    result, lead = _lead(run_id, lead_key)
    return await _patient(extras.conflicts(
        cala_mod.get(), lead, company_id or ((result["input"].get("company") or {}).get("id") or ""), about[:300]))


@app.get("/api/ask")
async def ask(run_id: str, lead_key: str, q: str = ""):
    """One cited answer from Cala's knowledge search about this lead."""
    result, lead = _lead(run_id, lead_key)
    return await _patient(extras.ask(cala_mod.get(), lead, q[:200]))


@app.get("/api/references")
async def references(run_id: str, lead_key: str):
    """Founders whose rounds this lead led, named by Cala: who to call for a reference."""
    result, lead = _lead(run_id, lead_key)
    return await _patient(extras.references(cala_mod.get(), lead))


@app.get("/api/slush")
async def slush(run_id: str, lead_key: str):
    result, lead = _lead(run_id, lead_key)
    return await _patient(extras.slush(lead))


def _load_annotated(run_id: str) -> dict | None:
    result = load_run(run_id)
    return _annotate(result) if result else None


MCP = mcp_mod.Server(suggest=lambda name: suggest(name), run=lambda inputs, emit: _run(inputs, emit), load=_load_annotated,
                     check=lambda name: _check(q=name))


@app.post("/mcp")
async def mcp(request: Request):
    """Soft Yes for a founder's own assistant: MCP over streamable HTTP, a plain JSON reply per request."""
    try:
        body = await request.json()
    except ValueError:
        return JSONResponse({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Parse error"}}, status_code=400)
    messages = body if isinstance(body, list) else [body]
    replies = [r for r in [await MCP.handle(m) for m in messages if isinstance(m, dict)] if r]
    if not replies:
        return Response(status_code=202)
    return JSONResponse(replies if isinstance(body, list) else replies[0])


@app.get("/mcp")
async def mcp_get():
    return JSONResponse({"detail": "This is an MCP server. Add this address to your assistant as a connector, or POST JSON-RPC."},
                        status_code=405, headers={"Allow": "POST"})


@app.get("/api/audit")
async def audit():
    """Everything the page check has found so far, across every stored walk: how many of Cala's lead flags the cited
    pages confirm word for word, and each place a page disagrees with Cala (lead, amount or stage), with the sentence."""
    db = cala_mod.get().db
    claims: dict[tuple, str] = {}
    found: dict[tuple, dict] = {}
    runs = 0
    stored = [(raw, True) for (raw,) in db.execute("select result from runs order by created")]
    if _has_blobs(db):   # companies checked on their own count too
        stored += [(raw, False) for (raw,) in db.execute("select value from blobs where key like 'check:%' order by created")]
    for raw, is_walk in stored:
        pc = (json.loads(raw).get("page_check") or {})
        if not pc.get("claims"):
            continue
        runs += is_walk
        for rid, key, status in pc["claims"]:
            claims[(rid, key)] = status
        for f in (pc.get("findings") or []) + (pc.get("confirmed_rows") or []):
            found[(f["kind"], f["round"], graph.norm(f["cala"]) if f["kind"] in ("lead", "confirmed") else "")] = f
    by = collections.Counter(claims.values())
    pages = db.execute("select count(*) from blobs where key like 'pagetext2:%' and value like '%\"status\": \"read\"%'").fetchone()[0] \
        if _has_blobs(db) else 0
    rows = sorted(found.values(), key=lambda f: f.get("date") or "", reverse=True)
    return {"walks": runs, "rounds": len({rid for rid, _ in claims}), "pages": pages, "claims": len(claims),
            "confirmed": by["lead"], "corrected": by["follower"], "unstated": by["unstated"] + by["absent"] + by["other"],
            "unread": by["unread"] + by["off"],
            "leads": [f for f in rows if f["kind"] == "lead" and claims.get((f["round"], graph.norm(f["cala"]))) == "follower"][:150],
            "confirmed_rows": [f for f in rows if f["kind"] == "confirmed"
                               and claims.get((f["round"], graph.norm(f["cala"]))) == "lead"],
            "amounts": [f for f in rows if f["kind"] == "amount"][:80],
            "stages": [f for f in rows if f["kind"] == "stage"][:80]}


@app.get("/api/backtest")
async def backtest():
    """The walk tested on rounds that already happened: each one hidden with everything dated after it, the walk run
    from its followers, and the real lead looked for on the list. Computed offline from the cache (softyes.backtest)."""
    b = extras.blob_get("backtest:v1")
    if not b or not b.get("tested"):
        return {"available": False}
    d = b.get("detail") or {}
    base = d.get("base") or {}

    def part(name: str) -> dict:
        x = {**(b.get(name) or {}), **(d.get(name) or {})}
        return {k: x.get(k) for k in ("tested", "hit", "top5", "base_rate", "lift", "median_list")}

    hits = [e for e in b.get("examples") or [] if e.get("rank") and e.get("confirmed_on_page")
            and e["earlier"]["company"] != e["company"] and e["rank"] <= 8]
    miss = [e for e in b.get("examples") or [] if not e.get("rank") and len(e.get("followers") or []) == 2]
    return {"available": True, "computed": b.get("computed"), "method": b.get("method"),
            "tested": b["tested"], "hit": b["hit"], "top5": b["top5"], "top10": b.get("top10"),
            "median_list": b.get("median_list"), "base_rate": b.get("base_rate"), "lift": b.get("lift"),
            "top5_base": base.get("top5_rate"), "chance": base.get("chance_random_does_as_well"),
            "two": part("two_followers"), "one": part("one_follower"),
            "followers": d.get("followers_tested"), "years": d.get("years"),
            "examples": hits[:3] + miss[-1:]}


@app.get("/api/check")
async def check(q: str = "", id: str = ""):
    """The page check for any company: its rounds in Cala, who Cala says led each, and what the cited pages say."""
    return await _patient(_check(q, id))


async def _check(q: str = "", id: str = "") -> dict:
    c = cala_mod.get()
    q, matches = graph.plain_name(q), []
    name = ""
    try:
        if not id:
            if len(q) < 2:
                raise HTTPException(400, "Name a company.")
            try:
                found = await graph.search(c, q, limit=8)
            except BudgetExceeded:
                found = await graph.search(c, q, limit=8, cache_only=True)
            nq = graph.norm(q)
            found = [f for f in found if f["type"] != "Person"]
            # the name as typed first, then a company before an organisation
            found.sort(key=lambda f: (graph.norm(f["name"]) != nq, not graph.norm(f["name"]).startswith(nq), f["type"] != "Company"))
            if not found:
                return {"company": None, "matches": [], "rounds": [], "q": q}
            matches = [{"id": f["id"], "name": f["name"], "description": graph.fix_text(f.get("description"))} for f in found[:5]]
            out = None
            for f in found[:4]:   # Cala can hold a company twice: take the entity that has the rounds
                got = await walk_mod.check_company(c, f["id"], f["name"])
                if got["rounds"]:
                    out = got
                    break
                if out is None or (got.get("investors_in_cala") or 0) > (out.get("investors_in_cala") or 0):
                    out = got   # no rounds anywhere: the entity Cala knows investors for
            id = out["company"]["id"]
        else:
            prof = await graph.company(c, id, cache_only=False)
            name = (prof or {}).get("name") or q or "This company"
            out = await walk_mod.check_company(c, id, name)
    except CalaError as exc:
        raise HTTPException(503 if isinstance(exc, BudgetExceeded) else 502, str(exc))
    out["company"]["description"] = next((m["description"] for m in matches if m["id"] == id), None)
    out["matches"], out["q"] = matches, q
    if not out["rounds"]:
        # The graph holds no round for it. Ask Cala's knowledge search, and keep only sentences from the pages it read.
        try:
            out["knowledge"] = await knowledge.company_leads(c, out["company"]["name"])
        except CalaError:
            out["knowledge"] = None
    if out["page_check"]["claims"]:
        extras.blob_put("check:" + id, {"page_check": out["page_check"]})
    return out


def _has_blobs(db) -> bool:
    return bool(db.execute("select 1 from sqlite_master where name = 'blobs'").fetchone())


@app.get("/api/health")
async def health():
    return {"ok": True, **_credits()}


@app.exception_handler(CalaError)
async def cala_error(_, exc: CalaError):
    return JSONResponse({"detail": str(exc)}, status_code=503 if isinstance(exc, BudgetExceeded) else 502)


@app.get("/{path:path}")
async def spa(path: str):
    if path.startswith("api/"):
        raise HTTPException(404)
    f = (DIST / path).resolve()
    if path and f.is_file() and DIST.resolve() in f.parents:
        headers = {"Cache-Control": "public, max-age=31536000, immutable"} if "/assets/" in str(f) else {}
        return FileResponse(f, headers=headers)
    index = DIST / "index.html"
    if index.is_file():
        return FileResponse(index, headers={"Cache-Control": "no-cache"})
    return JSONResponse({"detail": "Frontend not built yet. API is at /api."}, status_code=200)
