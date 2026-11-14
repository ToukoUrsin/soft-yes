"""Walk every stored run again through the local server, so stored results match the current logic.

Cala answers are cached, so this costs no credits unless the logic now asks Cala something new.
Usage: python3 deploy/refresh_runs.py [base_url]
"""
import concurrent.futures
import json
import sqlite3
import sys
import time
import urllib.request
from pathlib import Path

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8655"
DB = Path(__file__).resolve().parent.parent / "data" / "cache.db"


def walk(row):
    run_id, inputs = row
    t = time.time()
    req = urllib.request.Request(BASE + "/api/walk", data=inputs.encode(), headers={"content-type": "application/json"})
    done = None
    try:
        for line in urllib.request.urlopen(req, timeout=900):
            line = line.decode().strip()
            if line.startswith("data:"):
                ev = json.loads(line[5:])
                if ev["t"] in ("done", "error"):
                    done = ev
    except Exception as exc:  # noqa: BLE001
        return f"{run_id} EXC {type(exc).__name__} {exc}"[:160]
    if not done or done["t"] == "error":
        return f"{run_id} ERROR {done and done.get('message')}"
    r = done["result"]
    names = "+".join(s["name"] for s in r["soft_yeses"])
    same = "" if r["run_id"] == run_id else f" (now {r['run_id']})"
    return f"{run_id}{same} {names}: {len(r['leads'])} leads, fresh {r['ledger']['fresh']}, {round(time.time() - t)}s"


rows = sqlite3.connect(DB).execute("select run_id, inputs from runs order by created").fetchall()
with concurrent.futures.ThreadPoolExecutor(3) as pool:
    for line in pool.map(walk, rows):
        print(line, flush=True)
