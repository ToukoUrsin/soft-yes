"""Print an investor's funding-round activity by year from Cala (cached).

  hsec exec --only JUNCTION_CALA_API_KEY -- python3 pulse.py <uuid> [<uuid> ...]
"""
import collections
import sys

from cala import call

BODY = {"properties": ["name"], "relationships": {"outgoing": {
    "PARTICIPATES_IN_FUNDING_ROUND": {"limit": 50}, "INVESTED_IN": {"limit": 50}}}}

for uid in sys.argv[1:]:
    d = call("POST", f"/entities/{uid}", body=BODY)
    out = d["relationships"]["outgoing"]
    rounds = out.get("PARTICIPATES_IN_FUNDING_ROUND", [])
    n, lead, last = collections.Counter(), collections.Counter(), ""
    for r in rounds:
        dates = sorted(s.get("date", "") for s in r["properties"].get("sources", []))
        first = dates[0] if dates else "????"
        n[first[:4]] += 1
        lead[first[:4]] += bool(r["properties"].get("is_lead"))
        last = max(last, first)
    name = d["properties"].get("name", {}).get("value")
    print(f"{name}: rounds={len(rounds)} invested_in={len(out.get('INVESTED_IN', []))} latest={last}")
    print("   year(n,led):", [(y, n[y], lead[y]) for y in sorted(n)])
