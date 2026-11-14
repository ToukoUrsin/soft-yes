"""Read-only client for the Slush MCP (https://ai.slush.org/mcp): who from an investor is at Slush.

The connection carries the `mcp:read` scope only, so nothing here can send a meeting request.
Attendee names are never stored or returned: a lead gets a head count and job titles.
"""
from __future__ import annotations

import asyncio
import json
import os
import subprocess
import time

import httpx

from . import graph

URL = "https://ai.slush.org/mcp"
TOKEN_URL = "https://auth.slush.org/oauth/token"
SECRET = "JUNCTION_SLUSH_MCP_TOKEN_JSON"
PROTOCOL = "2025-06-18"
PAGE = 24

_token: dict | None = None
_lock = asyncio.Lock()
_shaken = False
_rid = 0


class SlushError(Exception):
    pass


def ready() -> bool:
    return bool(os.environ.get(SECRET))


async def _access(http: httpx.AsyncClient) -> str:
    global _token
    if _token is None:
        _token = json.loads(os.environ[SECRET])
    if time.time() - _token.get("obtained", 0) > _token.get("expires_in", 3600) - 180:
        r = await http.post(TOKEN_URL, data={"grant_type": "refresh_token", "refresh_token": _token["refresh_token"],
                                             "client_id": _token["client_id"]})
        if r.status_code != 200:
            raise SlushError(f"Slush sign-in expired ({r.status_code})")
        _token = {**_token, **r.json(), "obtained": time.time()}
        # the refresh token rotates: put the new pair back in the vault so a restart still works
        try:
            subprocess.run(["hsec", "set", SECRET], input=json.dumps(_token).encode(), timeout=15, check=False,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except (OSError, subprocess.SubprocessError):
            pass
    return _token["access_token"]


async def _rpc(http: httpx.AsyncClient, method: str, params: dict | None = None, notify: bool = False,
               versioned: bool = True) -> dict:
    global _rid
    _rid += 1
    body: dict = {"jsonrpc": "2.0", "method": method}
    if params is not None:
        body["params"] = params
    if not notify:
        body["id"] = _rid
    headers = {"Authorization": "Bearer " + await _access(http), "Content-Type": "application/json",
               "Accept": "application/json, text/event-stream", "User-Agent": "softyes/0.1"}
    if versioned:
        headers["MCP-Protocol-Version"] = PROTOCOL
    r = await http.post(URL, json=body, headers=headers)
    if r.status_code >= 400:
        raise SlushError(f"Slush MCP {r.status_code}: {r.text[:160]}")
    raw = r.text
    if "text/event-stream" in r.headers.get("content-type", ""):
        for line in raw.splitlines():
            if line.startswith("data:"):
                return json.loads(line[5:])
        return {}
    return json.loads(raw) if raw.strip() else {}


async def call(tool: str, args: dict, http: httpx.AsyncClient | None = None) -> dict:
    """One read tool call. The server speaks the 2025-06-18 handshake: initialize once, then call."""
    global _shaken
    own = http is None
    http = http or httpx.AsyncClient(timeout=40)
    try:
        async with _lock:
            if not _shaken:
                await _rpc(http, "initialize", {"protocolVersion": PROTOCOL, "capabilities": {},
                                                "clientInfo": {"name": "softyes", "version": "0.1"}}, versioned=False)
                await _rpc(http, "notifications/initialized", notify=True)
                _shaken = True
        d = await _rpc(http, "tools/call", {"name": tool, "arguments": args})
        if "error" in d:
            raise SlushError(str(d["error"])[:200])
        res = d.get("result") or {}
        text = (res.get("content") or [{}])[0].get("text") or "{}"
        if res.get("isError"):
            raise SlushError(text[:200])
        try:
            return json.loads(text)
        except ValueError:
            return {"text": text}
    finally:
        if own:
            await http.aclose()


INVESTOR_TYPES = ["vc-investor", "cvc-investor", "pe-investor", "angel-investor", "lp-investor", "ma-investor"]
MAX_PAGE = 50  # the tool refuses pages past 50


async def investors() -> dict[str, dict]:
    """Every investor attending Slush, grouped by firm: {norm(firm): {firm, people: [{id, title, type}]}}.

    Names are dropped on arrival. The directory is read one investor type at a time, page by page.
    """
    firms: dict[str, dict] = {}
    seen: set[str] = set()

    async def crawl(http: httpx.AsyncClient, kind: str) -> None:
        for page in range(1, MAX_PAGE + 1):
            d = await call("search_people", {"filters": [{"name": "company_type", "values": [kind]}],
                                             "page": page, "pageSize": PAGE}, http)
            for u in d.get("users") or []:
                uid, firm = u.get("user_id"), (u.get("company_name") or "").strip()
                key = graph.norm(firm)
                if not key or not uid or uid in seen:
                    continue
                seen.add(uid)
                f = firms.setdefault(key, {"firm": graph.pretty(firm), "people": []})
                f["people"].append({"id": uid, "title": (u.get("title") or "").strip()[:80], "type": kind})
            if not d.get("has_more"):
                return

    async with httpx.AsyncClient(timeout=90) as http:
        await asyncio.gather(*[crawl(http, k) for k in INVESTOR_TYPES])
    return firms


def match(firms: dict[str, dict], name: str) -> dict | None:
    """The attending firm that is this investor: same name once legal suffixes and punctuation are gone."""
    key = graph.norm(name)
    if not key:
        return None
    if key in firms:
        return firms[key]
    if len(key) >= 6:
        hits = [f for k, f in firms.items() if k.startswith(key) or (len(k) >= 6 and key.startswith(k))]
        if len(hits) == 1:
            return hits[0]
    return None
