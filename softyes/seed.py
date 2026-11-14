"""Start-up step on the public host: merge the Cala cache snapshot shipped in the image into the live one.

The live cache sits on a volume and keeps what visitors' walks fetched. Every deploy carries a newer snapshot
from the build machine. Cala answers are added when missing; stored runs and blobs are replaced only by newer ones.
"""
from __future__ import annotations

import os
import shutil
import sqlite3
from pathlib import Path

from . import cala

TABLES = (
    "create table if not exists calls(key text primary key, method text, url text, body text, response text,"
    " seconds real, ts real)",
    "create table if not exists runs(run_id text primary key, created real, inputs text, result text)",
    "create table if not exists blobs(key text primary key, created real, value text)",
)


def main() -> None:
    seed = os.environ.get("SOFTYES_SEED")
    if not seed or not Path(seed).exists():
        return
    live = cala.DB_PATH
    live.parent.mkdir(parents=True, exist_ok=True)
    if not live.exists():
        shutil.copyfile(seed, live)
        print(f"seed: started the cache from the snapshot ({Path(seed).stat().st_size >> 20} MB)", flush=True)
        return
    db = sqlite3.connect(live, isolation_level=None)
    for ddl in TABLES:
        db.execute(ddl)
    db.execute("attach database ? as seed", (seed,))
    db.execute("begin")
    calls = db.execute("insert or ignore into calls select * from seed.calls").rowcount
    runs = db.execute("insert or replace into runs select s.* from seed.runs s left join runs r on r.run_id = s.run_id"
                      " where r.run_id is null or s.created > r.created").rowcount
    blobs = db.execute("insert or replace into blobs select s.* from seed.blobs s left join blobs b on b.key = s.key"
                       " where b.key is null or s.created > b.created").rowcount
    db.execute("commit")
    db.close()
    print(f"seed: merged {calls} Cala answers, {runs} runs, {blobs} blobs", flush=True)


if __name__ == "__main__":
    main()
