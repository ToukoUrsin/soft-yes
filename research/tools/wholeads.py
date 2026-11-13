"""Who leads when this investor follows? Walks investor -> rounds -> lead investors in Cala (cached).

  hsec exec --only JUNCTION_CALA_API_KEY -- python3 wholeads.py <investor-uuid> [max_rounds]
"""
import collections
import sys

from cala import call

uid = sys.argv[1]
max_rounds = int(sys.argv[2]) if len(sys.argv) > 2 else 15

inv = call("POST", f"/entities/{uid}", body={"properties": ["name"], "relationships": {"outgoing": {
    "PARTICIPATES_IN_FUNDING_ROUND": {"limit": 50}}}})
me = inv["properties"]["name"]["value"]
rounds = inv["relationships"]["outgoing"].get("PARTICIPATES_IN_FUNDING_ROUND", [])
led = sum(bool(r["properties"].get("is_lead")) for r in rounds)
print(f"{me}: {len(rounds)} rounds in Cala, led {led}")


def first_date(r):
    return min([s.get("date", "9999") for s in r["properties"].get("sources", [])] or ["9999"])


followed = sorted((r for r in rounds if not r["properties"].get("is_lead")), key=first_date, reverse=True)
leads = collections.defaultdict(list)
for r in followed[:max_rounds]:
    d = call("POST", f"/entities/{r['id']}", body={
        "properties": ["announcement_date", "transaction_value", "transaction_value_units", "round_label"],
        "relationships": {"incoming": {"PARTICIPATES_IN_FUNDING_ROUND": {"limit": 50}}}})
    p = {k: v.get("value") for k, v in d["properties"].items()}
    parts = d["relationships"]["incoming"].get("PARTICIPATES_IN_FUNDING_ROUND", [])
    issuer = next((x["name"] for x in parts if x["properties"].get("role") == "ISSUER"), "?")
    round_leads = [x["name"] for x in parts if x["properties"].get("is_lead") and x["id"] != uid]
    others = [x["name"] for x in parts if x["properties"].get("role") == "INVESTOR"
              and not x["properties"].get("is_lead") and x["id"] != uid]
    amount = p.get("transaction_value")
    print(f"  {p.get('announcement_date')} {issuer} {p.get('round_label')} "
          f"{amount} {p.get('transaction_value_units')} | LED BY {round_leads or '-'} | also {others[:6]}")
    for name in round_leads:
        leads[name].append(f"{issuer} {p.get('round_label')} {p.get('announcement_date')}")

print("\nWho leads when", me, "follows:")
for name, deals in sorted(leads.items(), key=lambda kv: -len(kv[1])):
    print(f"  {len(deals)}x {name}: {deals}")
