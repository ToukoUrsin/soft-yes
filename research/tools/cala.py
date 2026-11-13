"""Tiny cached Cala client for exploring the graph.

Usage (key comes from the environment, never argv):
  hsec exec --only JUNCTION_CALA_API_KEY -- python3 cala.py find "Lightspeed" [Type ...]
  ... cala.py intro <uuid>
  ... cala.py get <uuid> '<json body>'
  ... cala.py query "<input>"
  ... cala.py search "<input>"

Every response is cached in ../cache/<sha>.json so a repeat costs no credits.
"""
import hashlib
import json
import os
import pathlib
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = "https://api.cala.ai/v1"
CACHE = pathlib.Path(__file__).resolve().parent.parent / "cache"
CACHE.mkdir(exist_ok=True)


def call(method, path, body=None, params=None):
    url = BASE + path
    if params:
        url += "?" + urllib.parse.urlencode(params, doseq=True)
    key = hashlib.sha256(json.dumps([method, url, body], sort_keys=True).encode()).hexdigest()[:20]
    f = CACHE / f"{key}.json"
    if f.exists():
        return json.loads(f.read_text())["response"]
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        "X-API-KEY": os.environ["JUNCTION_CALA_API_KEY"],
        "Content-Type": "application/json",
        "User-Agent": "cala-explorer/0.1",
    })
    t = time.time()
    for attempt in range(6):
        try:
            with urllib.request.urlopen(req, timeout=180) as r:
                resp = json.loads(r.read())
                hdrs = {k: v for k, v in r.headers.items() if "credit" in k.lower() or "rate" in k.lower()}
            break
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < 5:  # free tier: 10 requests a minute
                time.sleep(13)
                continue
            print(f"HTTP {e.code}: {e.read()[:600]!r}", file=sys.stderr)
            sys.exit(1)
    dt = round(time.time() - t, 1)
    f.write_text(json.dumps({"method": method, "url": url, "body": body, "seconds": dt,
                             "headers": hdrs, "response": resp}, ensure_ascii=False))
    print(f"[{dt}s {hdrs}]", file=sys.stderr)
    return resp


def main():
    cmd, *a = sys.argv[1:]
    if cmd == "find":
        p = {"name": a[0], "limit": 8}
        if a[1:]:
            p["entity_types"] = a[1:]
        out = call("GET", "/entities", params=p)
    elif cmd == "intro":
        out = call("GET", f"/entities/{a[0]}/introspection")
    elif cmd == "get":
        out = call("POST", f"/entities/{a[0]}", body=json.loads(a[1]) if a[1:] else None)
    elif cmd == "query":
        out = call("POST", "/knowledge/query", body={"input": a[0]})
    elif cmd == "search":
        out = call("POST", "/knowledge/search", body={"input": a[0]})
    else:
        sys.exit("unknown command")
    print(json.dumps(out, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
