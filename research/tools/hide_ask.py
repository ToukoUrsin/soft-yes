"""Does the investor search find a company's real investors when that company is hidden?

For each stored field search, each company Cala named is taken out in turn and the search is asked again by field,
stage and place only (no investor the founder knows). A hit: at least one investor Cala holds for the hidden
company (in its rounds or on its cap table) is on the list. The same investors are also looked for on the lists of the other fields, as the chance line.

Runs from Cala answers already in the cache: nothing new is fetched, so an investor whose record was never read
gets no signals from it. Usage: .venv/bin/python research/tools/hide_ask.py  (writes research/hide_ask.json)
"""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from softyes import cala as cala_mod  # noqa: E402
from softyes import scout  # noqa: E402

cala_mod.CREDIT_CAP = 0   # cached answers only

ASKS = [
    {"sector": "artificial intelligence", "stage": "PRE_SEED", "place": "Europe"},
    {"sector": "artificial intelligence", "stage": "PRE_SEED", "place": None},
    {"sector": "climate tech", "stage": "SEED", "place": "Nordics"},
    {"sector": "robotics", "stage": "SEED", "place": "Europe"},
]


async def main() -> None:
    cala = cala_mod.get()
    full = []
    for a in ASKS:
        r = await scout.scout(cala, {**a, "like": [], "mine": [], "order": True})
        full.append(r)
        print(f"{a['sector']} {a['stage']} {a['place']}: {len(r['companies'])} companies, {len(r['order'])} investors", flush=True)
    rows = []
    for n, (a, r) in enumerate(zip(ASKS, full)):
        for co in r["companies"]:
            real = r["of"].get(co["name"]) or []   # in its rounds or on its cap table in Cala
            if not real:
                continue
            h = await scout.scout(cala, {**a, "like": [], "mine": [], "hide": co["id"]})
            order = h["order"]
            top = set(order[:scout.SHOWN])
            other = [set(x["order"]) for m, x in enumerate(full) if m != n and x["ask"]["sector"] != r["ask"]["sector"]]
            rows.append({"field": f"{a['sector']}, {a['stage']}, {a['place'] or 'anywhere'}", "company": co["name"], "real": len(real),
                         "on_list": sum(k in order for k in real), "in_first": sum(k in top for k in real), "list": len(order),
                         "other_fields": [sum(k in o for k in real) for o in other]})
            print(f"  {co['name'][:30]:30} real {len(real):>2} | on the list {rows[-1]['on_list']:>2} | first {scout.SHOWN} {rows[-1]['in_first']:>2} "
                  f"| list {len(order):>3} | other fields {rows[-1]['other_fields']}", flush=True)
    n = len(rows)
    chance_n = sum(len(x["other_fields"]) for x in rows)
    out = {"companies": n, "any_on_list": sum(1 for x in rows if x["on_list"]), "any_in_first": sum(1 for x in rows if x["in_first"]),
           "investors": sum(x["real"] for x in rows), "investors_on_list": sum(x["on_list"] for x in rows),
           "investors_in_first": sum(x["in_first"] for x in rows),
           "chance_lists": chance_n, "chance_any": sum(1 for x in rows for c in x["other_fields"] if c), "shown": scout.SHOWN, "rows": rows}
    (ROOT / "research" / "hide_ask.json").write_text(json.dumps(out, indent=1, ensure_ascii=False))
    print({k: v for k, v in out.items() if k != "rows"})


asyncio.run(main())
