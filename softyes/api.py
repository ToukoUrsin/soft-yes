"""HTTP API for Soft Yes. Serves the built frontend from web/dist."""
from __future__ import annotations

import asyncio
import json
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse

from . import cala as cala_mod
from . import extras, graph, walk as walk_mod
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

INDEX: dict[str, dict] = {}   # norm(name) -> {key, name, ids, kind, type, description, rounds}


def _index_add(uid: str, name: str, etype: str | None, description: str | None = None, rounds: int = 0) -> None:
    name = graph.pretty(name)
    key = graph.norm(name)
    if not key or not uid:
        return
    e = INDEX.setdefault(key, {"key": key, "name": name, "ids": [], "kind": graph.kind(etype), "type": etype,
                               "description": None, "rounds": 0})
    if uid not in e["ids"]:
        e["ids"].append(uid)
    if description and not e["description"]:
        e["description"] = description
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
    elif body == graph.INVESTOR_BODY and resp.get("name"):
        _index_add(resp["id"], resp["name"], resp.get("entity_type"), resp.get("description"))


def build_index() -> None:
    INDEX.clear()
    c = cala_mod.get()
    with c.dblock:
        rows = c.db.execute("select url, body, response from calls").fetchall()
    for url, body, resp in rows:
        try:
            _index_response(url, json.loads(body) if body else None, json.loads(resp))
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


app = FastAPI(title="Soft Yes", lifespan=lifespan)


def _credits() -> dict:
    c = cala_mod.get()
    return {"used": c.credits_used(), "cap": CREDIT_CAP, "cached_calls": c.total_cached()}


@app.get("/api/config")
async def config():
    return {"framing": FRAMING, "stages": [{"id": s, "name": graph.STAGE_NAMES[s]} for s in graph.STAGE_ORDER[:5]],
            "credits": _credits(), "index_size": len(INDEX), "gemini": extras.gemini_ready(),
            "oxylabs": extras.oxylabs_ready(), "slush": extras.slush_directory()}


@app.get("/api/examples")
async def examples():
    return {"examples": EXAMPLES}


def _local_hits(q: str, limit: int) -> list[dict]:
    nq = graph.norm(q)
    if not nq:
        return []
    words = q.lower().split()
    hits = []
    for e in INDEX.values():
        name = e["name"].lower()
        if e["key"].startswith(nq):
            tier = 0
        elif all(any(w.startswith(x) for w in name.split()) for x in words):
            tier = 1
        elif nq in e["key"] and len(nq) >= 4:
            tier = 2
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
        head = min(members, key=lambda m: (not graph.INVESTOR_WORDS.search(m["name"]), len(m["name"])))
        ids = [i for m in members for i in m["ids"]][:6]
        out.append({**head, "ids": ids, "rounds": sum(m["rounds"] for m in members),
                    "description": head.get("description") or next((m["description"] for m in members if m.get("description")), None),
                    "entities": [{"name": m["name"], "ids": m["ids"]} for m in members][:6]})
    nq = graph.norm(q)
    # the name as typed first, then the firm Cala knows best; a marketing agency called Seaya goes below Seaya Ventures
    out.sort(key=lambda f: (not _investor_like(f), nq not in (f["key"], graph.root(f["name"])[0]),
                            -(f["rounds"] + 3 * len(f["entities"])), len(f["name"])))
    return out[:limit]


@app.get("/api/suggest")
async def suggest(q: str = "", limit: int = 7):
    q = q.strip()[:60]
    if len(q) < 2:
        return {"items": [], "source": "none"}
    local = _local_hits(q, 20)
    source = "index"
    if len(q) >= 3 and not any(e["rounds"] for e in local):  # nothing with a track record locally: ask Cala
        try:
            found = await graph.search(cala_mod.get(), q, limit=8)
            for f in found:
                _index_add(f["id"], f["raw_name"], f["type"], f["description"])
            local = _local_hits(q, 20) or [INDEX[graph.norm(f["name"])] for f in found if graph.norm(f["name"]) in INDEX]
            source = "cala"
        except CalaError:
            source = "index"
    return {"items": [{**e, "known_rounds": e["rounds"]} for e in _families(local, limit, q)], "source": source}


@app.get("/api/company")
async def company(id: str):
    """The founder's own company as Cala knows it: stage, industries, and who already invested."""
    c = cala_mod.get()
    try:
        d = await graph.company(c, id)
    except BudgetExceeded:
        d = await graph.company(c, id, cache_only=True)
    except CalaError as exc:
        raise HTTPException(502, str(exc))
    if not d:
        raise HTTPException(404, "Cala has no such company")
    for inv in d["investors"]:
        _index_add(inv["id"], inv["name"], inv["type"])
        inv["key"] = graph.norm(inv["name"])
        inv["ids"] = INDEX.get(inv["key"], {}).get("ids", [inv["id"]])
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
        comp = {"id": comp.get("id"), "name": str(comp.get("name", ""))[:80]}
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
        _save_run(inputs, result)
        await emit({"t": "partial", "run_id": result["run_id"], "result": _annotate(result),
                    "reading": [s["name"] for s in result["soft_yeses"] if s["key"] in deep]})

        async def quiet(event: dict) -> None:   # the second pass repeats the graph walk from cache: do not replay it
            if event["t"] in ("knowledge", "captable", "note", "ledger") or \
                    (event["t"] == "round" and event.get("via") in ("knowledge", "cap_table")):
                await emit(event)

        result = await walk_mod.walk(cala_mod.get(), inputs, quiet, aliases=aliases, deep=deep)
    result["credits"] = _credits()
    _save_run(inputs, result)
    _annotate(result)
    for s in result["soft_yeses"]:
        for uid in s["ids"]:
            _index_add(uid, s["name"], None, s.get("description"), 0)
    for e in result["leads"] + result["second_ring"]:
        for uid in e["ids"]:
            _index_add(uid, e["name"], "Person" if e["kind"] == "person" else None, None, len(e["evidence"]))
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
                event = await queue.get()
                if event is None:
                    break
                yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
        finally:
            if not task.done():
                await asyncio.shield(task)  # finish the walk so its calls are cached even if the tab closes

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.get("/api/run/{run_id}")
async def run(run_id: str):
    result = load_run(run_id)
    if not result:
        raise HTTPException(404, "No such run")
    return _annotate(result)


@app.get("/api/investor")
async def investor(ids: str, name: str = ""):
    """Investor check: does this investor lead or follow, and who leads when it follows?"""
    id_list = [i for i in ids.split(",") if len(i) == 36][:4]
    if not id_list:
        raise HTTPException(400, "ids required")
    c = cala_mod.get()
    if not name:
        inv = await graph.investor(c, id_list[0])
        name = inv["name"] if inv else "Investor"
    inputs = {"soft_yeses": [{"name": name, "ids": id_list, "kind": "fund"}], "stage": None, "company": None}

    async def emit(_):
        return None

    result = await _run(inputs, emit)
    try:
        result["profile"] = await graph.profile(c, id_list[0])
    except CalaError:
        result["profile"] = None
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
    return await extras.draft(result, lead, kind, founder, llm=body.get("llm", True) is not False)


@app.get("/api/says")
async def says(run_id: str, lead_key: str):
    """What the lead says on its own site (Oxylabs + Gemini, quotes checked verbatim) next to what Cala shows it did."""
    result, lead = _lead(run_id, lead_key)
    return await extras.says(cala_mod.get(), lead)


@app.get("/api/conflicts")
async def conflicts(run_id: str, lead_key: str, company_id: str = "", about: str = ""):
    result, lead = _lead(run_id, lead_key)
    return await extras.conflicts(cala_mod.get(), lead, company_id or ((result["input"].get("company") or {}).get("id") or ""),
                                  about[:300])


@app.get("/api/ask")
async def ask(run_id: str, lead_key: str, q: str = ""):
    """One cited answer from Cala's knowledge search about this lead."""
    result, lead = _lead(run_id, lead_key)
    return await extras.ask(cala_mod.get(), lead, q[:200])


@app.get("/api/references")
async def references(run_id: str, lead_key: str):
    """Founders whose rounds this lead led, named by Cala: who to call for a reference."""
    result, lead = _lead(run_id, lead_key)
    return await extras.references(cala_mod.get(), lead)


@app.get("/api/slush")
async def slush(run_id: str, lead_key: str):
    result, lead = _lead(run_id, lead_key)
    return await extras.slush(lead)


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
