"""Cala client: every call is cached in SQLite forever, rate limited, and counted.

One Cala call costs one credit, so nothing is ever fetched twice. The key comes
from the environment (JUNCTION_CALA_API_KEY) and is never logged.
"""
from __future__ import annotations

import asyncio
import collections
import hashlib
import json
import os
import sqlite3
import threading
import time
import urllib.parse
from pathlib import Path

import httpx

BASE = "https://api.cala.ai/v1"
ROOT = Path(__file__).resolve().parent.parent
DB_PATH = ROOT / "data" / "cache.db"
PER_MINUTE = int(os.environ.get("CALA_PER_MINUTE", "80"))
CREDIT_CAP = int(os.environ.get("CALA_CREDIT_CAP", "2040"))  # fresh calls allowed since PLAN_START
PLAN_START = float(os.environ.get("CALA_PLAN_START", "1794611220"))  # 2026-11-13T23:07Z, first credit pack


class CalaError(RuntimeError):
    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


class BudgetExceeded(CalaError):
    """The credit cap is reached: only cached data can be served."""


class Ledger:
    """Counts what one run took from Cala."""

    def __init__(self) -> None:
        self.calls = 0
        self.fresh = 0
        self.seconds = 0.0

    def add(self, cached: bool, seconds: float) -> None:
        self.calls += 1
        if not cached:
            self.fresh += 1
            self.seconds += seconds

    def as_dict(self) -> dict:
        return {"cala_calls": self.calls, "fresh": self.fresh, "cached": self.calls - self.fresh}


class Cala:
    def __init__(self) -> None:
        DB_PATH.parent.mkdir(exist_ok=True)
        self.db = sqlite3.connect(DB_PATH, check_same_thread=False, isolation_level=None)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute(
            "create table if not exists calls(key text primary key, method text, url text, body text,"
            " response text, seconds real, ts real)"
        )
        self.dblock = threading.Lock()
        self._client: httpx.AsyncClient | None = None
        self._sem: asyncio.Semaphore | None = None
        self._window: collections.deque[float] = collections.deque()
        self._inflight: dict[str, asyncio.Future] = {}

    # -- cache ---------------------------------------------------------------
    @staticmethod
    def _key(method: str, url: str, body) -> str:
        return hashlib.sha256(json.dumps([method, url, body], sort_keys=True).encode()).hexdigest()[:20]

    def cached(self, method: str, url: str, body):
        with self.dblock:
            row = self.db.execute("select response from calls where key=?", (self._key(method, url, body),)).fetchone()
        return json.loads(row[0]) if row else None

    def store(self, method: str, url: str, body, response, seconds: float, ts: float | None = None) -> None:
        with self.dblock:
            self.db.execute(
                "insert or replace into calls values(?,?,?,?,?,?,?)",
                (self._key(method, url, body), method, url, json.dumps(body), json.dumps(response, ensure_ascii=False),
                 seconds, ts or time.time()),
            )

    def credits_used(self) -> int:
        with self.dblock:
            return self.db.execute("select count(*) from calls where ts>?", (PLAN_START,)).fetchone()[0]

    def total_cached(self) -> int:
        with self.dblock:
            return self.db.execute("select count(*) from calls").fetchone()[0]

    # -- network -------------------------------------------------------------
    async def _throttle(self) -> None:
        while True:
            now = time.time()
            while self._window and now - self._window[0] > 60:
                self._window.popleft()
            if len(self._window) < PER_MINUTE:
                self._window.append(now)
                return
            await asyncio.sleep(0.25)

    async def call(self, method: str, path: str, body=None, params=None, ledger: Ledger | None = None,
                   cache_only: bool = False):
        url = BASE + path
        if params:
            url += "?" + urllib.parse.urlencode(params, doseq=True)
        hit = self.cached(method, url, body)
        if hit is not None:
            if ledger:
                ledger.add(True, 0.0)
            return hit
        if cache_only:
            return None
        key = self._key(method, url, body)
        if key in self._inflight:  # the same call is already on the wire: wait for it
            resp = await self._inflight[key]
            if ledger:
                ledger.add(True, 0.0)
            return resp
        if self.credits_used() >= CREDIT_CAP:
            raise BudgetExceeded("Cala credit cap reached; serving cached graph only.")
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._inflight[key] = fut
        try:
            resp, seconds = await self._fetch(method, url, body)
            self.store(method, url, body, resp, seconds)
            if ledger:
                ledger.add(False, seconds)
            fut.set_result(resp)
            return resp
        except BaseException as exc:
            fut.set_exception(exc)
            fut.exception()  # mark retrieved
            raise
        finally:
            self._inflight.pop(key, None)

    async def _fetch(self, method: str, url: str, body):
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=180, headers={
                "X-API-KEY": os.environ["JUNCTION_CALA_API_KEY"],
                "Content-Type": "application/json",
                "User-Agent": "softyes/0.1",
            })
            self._sem = asyncio.Semaphore(8)
        assert self._sem is not None
        async with self._sem:
            last = "no attempt"
            for attempt in range(5):
                await self._throttle()
                t = time.time()
                try:
                    r = await self._client.request(method, url, json=body if body is not None else None)
                except httpx.HTTPError as exc:
                    last = type(exc).__name__
                    await asyncio.sleep(1.5 * (attempt + 1))
                    continue
                if r.status_code == 429 or r.status_code >= 500:
                    last = f"HTTP {r.status_code}"
                    await asyncio.sleep(4 * (attempt + 1))
                    continue
                if r.status_code >= 400:
                    raise CalaError(f"Cala {r.status_code}: {r.text[:300]}", r.status_code)
                return r.json(), round(time.time() - t, 2)
            raise CalaError(f"Cala unreachable after retries ({last})")


def import_research_cache(cala: Cala) -> int:
    """Bring the JSON files from the first exploration into the SQLite cache (free credits)."""
    n = 0
    for f in sorted((ROOT / "research" / "cache").glob("*.json")):
        d = json.loads(f.read_text())
        if cala.cached(d["method"], d["url"], d["body"]) is None:
            cala.store(d["method"], d["url"], d["body"], d["response"], d.get("seconds", 0.0), ts=f.stat().st_mtime)
            n += 1
    return n


_instance: Cala | None = None


def get() -> Cala:
    global _instance
    if _instance is None:
        _instance = Cala()
    return _instance
