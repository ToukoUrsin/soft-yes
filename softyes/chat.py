"""What the views drawn inside a chat are given: a stored run cut down to what one card shows.

A tool result may not be large (a chat host drops the card past about 150,000 characters), and the card needs far less
than the run's page does. Nothing is added here: every field is copied from the run, shortened or left out.
"""
from __future__ import annotations

import datetime
import re

from . import extras, graph, scout

LEADS = 12        # leads a card carries; the rest are on the run's page
ROUNDS = 60       # rounds the walk drawing carries
NET_ROUNDS = 140  # rounds the network map carries
QUOTE = 280       # characters of a page sentence shown in a card

STATUS = ("to_ask", "asked", "replied", "meeting", "leading", "passed")
STATUS_LABEL = {"to_ask": "Not asked", "asked": "Asked", "replied": "Replied", "meeting": "Meeting", "leading": "Leading",
                "passed": "Passed"}


def _money(d: dict) -> str | None:
    return extras.fmt_money(d.get("amount"), d.get("currency")) or None


def _clip(quote: str | None, name: str | None = None, limit: int = QUOTE) -> str | None:
    """A long sentence cut around the investor's name, on word boundaries."""
    if not quote:
        return None
    q = " ".join(quote.split())
    if len(q) <= limit:
        return q
    at = -1
    for cut in _spellings(name or ""):
        at = q.lower().find(cut.lower())
        if at >= 0:
            break
    start = max(0, min(len(q) - limit, (at if at >= 0 else 0) - limit // 2))
    piece = q[start:start + limit]
    if start > 0:
        piece = "… " + piece.split(" ", 1)[-1]
    if start + limit < len(q):
        piece = piece.rsplit(" ", 1)[0] + " …"
    return piece


def _spellings(name: str) -> list[str]:
    """The name as a page may write it: in full, then without its trailing words ('Lightspeed' for the firm)."""
    words = name.split()
    out = [" ".join(words[:n]) for n in range(len(words), 0, -1)]
    return [w for w in out if len(w) >= 4] or ([name] if name else [])


def _brief(d: dict | None) -> dict | None:
    if not d:
        return None
    return {"company": (d.get("issuer") or {}).get("name"), "stage_name": d.get("stage_name") if d.get("stage") else None,
            "date": d.get("date"), "amount": _money(d)}


def _evidence(d: dict, name: str) -> dict:
    ck = d.get("check") or {}
    return {"id": d["id"], **_brief(d), "status": ck.get("status"), "quote": _clip(ck.get("quote"), name),
            "url": ck.get("url") or next((s["url"] for s in d.get("sources") or []), None),
            "publisher": ck.get("publisher") or next((s["publisher"] for s in d.get("sources") or []), None),
            "with": d.get("with") or [], "co_leads": [c for c in d.get("co_leads") or [] if c not in (d.get("co_doubt") or [])][:2],
            "via": d.get("via")}


def _lead(e: dict, labels: dict) -> dict:
    ask = e.get("ask") or {}
    return {"key": e["key"], "name": e["name"], "rank": e.get("rank"), "tier": e.get("tier"), "tier_label": labels.get(e.get("tier")),
            "now": e.get("tier") == "active", "led_recent": e.get("led_recent"), "confirmed": e.get("confirmed"),
            "checked": e.get("checked"), "why": [w["text"] for w in e.get("why") or []][:4],
            "caution": (e.get("doubt") or {}).get("text"),
            "door": {"key": ask.get("key"), "name": ask.get("name"), "deals": ask.get("deals"), "round": _brief(ask.get("last"))}
            if ask.get("name") else None,
            "doors": [{"key": a["key"], "name": a["name"], "deals": a["deals"]} for a in e.get("asks") or []][:4],
            "evidence": [_evidence(d, e["name"]) for d in e["evidence"][:3]], "rounds": len(e["evidence"]),
            "last_led": _brief(e.get("last_led")), "fit": (e.get("fit") or {}).get("match"),
            # the asked stage in this lead's own record, as one line: "Led 4 Series A rounds in Cala, $8M to $30M"
            "fit_line": (e.get("fit") or {}).get("line"), "led_at_stage": (e.get("fit") or {}).get("led_at_stage"),
            # other spellings Cala holds this firm under, counted here as the one lead
            "also_named": [a["name"] for a in e.get("also_named") or []],
            "at_slush": bool(e.get("at_slush"))}


def _fixes(r: dict) -> list[dict]:
    """Lead claims the cited page does not bear out: Cala's name, and who the page says led."""
    out = []
    for f in (r.get("page_check") or {}).get("findings") or []:
        if f.get("kind") == "lead" and f.get("page"):
            out.append({"round": f.get("round"), "company": f.get("company"), "stage_name": f.get("stage_name"), "date": f.get("date"),
                        "cala": f.get("cala"), "page": f["page"][:3], "quote": _clip(f.get("quote"), f["page"][0]),
                        "url": f.get("url"), "publisher": f.get("publisher")})
    return out[:12]


def _walk_rounds(r: dict, fixes: list[dict]) -> list[dict]:
    """The rounds the soft-yes investors joined that someone else led, newest first, with what the page said of each lead."""
    softs = {s["key"] for s in r["soft_yeses"]}
    rounds: dict[str, dict] = {}
    if r.get("net"):
        for row in r["net"]:
            if row.get("soft_led") or not row.get("soft"):
                continue
            leads = [{"key": graph.norm(n), "name": n, "status": st} for n, led, st in row["investors"]
                     if led and graph.norm(n) not in softs]
            if leads:
                rounds[row["id"]] = {"id": row["id"], "company": row["company"], "stage_name": row["stage_name"], "date": row["date"],
                                     "soft": row["soft"], "leads": leads[:4], "investors": len(row["investors"]),
                                     "via": row.get("via")}
    else:   # a run stored before the walk kept its rounds: rebuild them from the leads' evidence
        for e in r["leads"]:
            for d in e["evidence"]:
                row = rounds.setdefault(d["id"], {"id": d["id"], **{k: v for k, v in _brief(d).items() if k != "amount"},
                                                  "soft": list(d.get("with_keys") or []), "leads": [],
                                                  "investors": d.get("investors"), "via": d.get("via")})
                row["leads"].append({"key": e["key"], "name": e["name"], "status": (d.get("check") or {}).get("status")})
    for f in fixes:   # a struck claim is part of the drawing, with the name the page gives in its place
        row = rounds.get(f["round"])
        if not row:   # the round is known only through its correction: drawn with no line from an investor
            row = rounds[f["round"]] = {"id": f["round"], "company": f["company"], "stage_name": f["stage_name"], "date": f["date"],
                                        "soft": [], "leads": [], "investors": None, "via": None}
        key = graph.norm(f["cala"] or "")
        hit = next((x for x in row["leads"] if x["key"] == key), None)
        if hit:
            hit.update({"status": "follower", "page": f["page"]})
        else:
            row["leads"].append({"key": key, "name": f["cala"], "status": "follower", "page": f["page"]})
    return sorted(rounds.values(), key=lambda x: x["date"] or "", reverse=True)[:ROUNDS]


def net_view(r: dict) -> dict | None:
    """Everyone the soft-yes investors have sat in a round with. Names are listed once; rounds point at them by number."""
    softs = {s["key"]: s["name"] for s in r["soft_yeses"]}
    rows = r.get("net")
    if not rows:   # an older run: only the rounds behind its leads are known
        rows = []
        seen: dict[str, dict] = {}
        for e in r["leads"] + r.get("second_ring", []):
            for d in e["evidence"]:
                row = seen.get(d["id"])
                if not row:
                    row = seen[d["id"]] = {"id": d["id"], "company": (d.get("issuer") or {}).get("name"),
                                           "stage_name": d.get("stage_name"), "date": d.get("date"), "soft": list(d.get("with_keys") or []),
                                           "investors": [[n, 0, None] for n in d.get("with") or []]}
                    rows.append(row)
                led = 1 if e.get("ring", 1) == 1 else 0
                row["investors"].append([e["name"], led, (d.get("check") or {}).get("status")])
        rows.sort(key=lambda x: x["date"] or "", reverse=True)
    names: list[str] = []
    index: dict[str, int] = {}

    def node(name: str) -> int:
        name = scout._name(name)   # 'UAB Contrarian Ventures' and 'Contrarian Ventures' are one investor
        key = graph.norm(name)
        if key not in index:
            index[key] = len(names)
            names.append(name)
        return index[key]

    for name in softs.values():
        node(name)
    out = []
    for row in rows[:NET_ROUNDS]:
        out.append({"c": row.get("company"), "s": row.get("stage_name"), "d": (row.get("date") or "")[:7],
                    "m": [index[k] for k in row.get("soft") or [] if k in index],
                    "i": [[node(n), led, {"lead": 1, "report": 1, "follower": 2}.get(st, 0)] for n, led, st in row["investors"][:16]]})
    return {"names": names, "keys": [graph.norm(n) for n in names], "softs": len(softs), "rounds": out,
            "more": max(0, len(rows) - NET_ROUNDS)}


def walk_view(r: dict, url: str, said: dict | None = None, holdout: dict | None = None, partial: bool = False) -> dict:
    """`said`: what the founder's own mail says of each soft yes, by investor key. Shown back, never stored."""
    said = said or {}
    labels = {t["id"]: t["label"] for t in r.get("tiers") or []}
    fixes = _fixes(r)
    pc, led = r.get("page_check") or {}, r["ledger"]
    comp = (r["input"].get("company") or {})
    softs = []
    for s in r["soft_yeses"]:
        mail = said.get(s["key"]) or {}
        softs.append({"key": s["key"], "name": s["name"], "verdict": s.get("verdict"), "rounds": s.get("rounds_in_cala"),
                      "led": s.get("led"), "followed": s.get("followed"), "insight": s.get("insight"),
                      "from": "inbox" if mail.get("said") else "cala" if comp.get("id") else "typed",
                      **{k: mail[k] for k in ("person", "said", "date", "email") if mail.get(k)}})
    own = None
    if holdout and holdout.get("round") and not holdout.get("skipped") and holdout.get("from"):
        found = (holdout.get("found") or [None])[0]
        own = {"stage_name": holdout["round"].get("stage_name"), "date": holdout["round"].get("date"),
               "from": holdout["from"], "of": holdout.get("of"), "real": [x["name"] for x in holdout["round"].get("leads") or []],
               "found": {"name": found["name"], "rank": found["rank"],
                         "through": [_brief_through(t) for t in (found.get("through") or [])[:1]]} if found else None}
    return {"view": "walk", "run_id": r["run_id"], "url": url, "partial": partial,
            "company": comp.get("name"), "stage_name": r["input"].get("stage_name"), "headline": r["headline"],
            "softs": softs, "rounds": _walk_rounds(r, fixes), "rounds_walked": r.get("rounds_walked"),
            "leads": [_lead(e, labels) for e in r["leads"][:LEADS]], "leads_total": len(r["leads"]),
            "leading_now": sum(1 for e in r["leads"] if e.get("tier") == "active"),
            "fixes": fixes,
            "check": {k: pc.get(k) or 0 for k in ("pages", "confirmed", "corrected", "unstated", "unread")},
            "ledger": {"calls": led.get("cala_calls"), "facts": led.get("facts"), "sources": led.get("sources"),
                       "seconds": led.get("seconds"), "llm": 0, "inbox": sum(1 for s in softs if s["from"] == "inbox")},
            "own": own, "net": net_view(r)}


def _brief_through(t: dict) -> dict:
    ck = t.get("check") or {}
    return {"company": t.get("company"), "stage_name": t.get("stage_name"), "date": t.get("date"), "with": t.get("with") or [],
            "quote": _clip(ck.get("quote")), "url": ck.get("url"), "publisher": ck.get("publisher"), "status": ck.get("status")}


def network_view(r: dict, url: str, focus: str | None = None, path: list[str] | None = None) -> dict:
    softs = [{"key": s["key"], "name": s["name"], "rounds": s.get("rounds_in_cala"), "led": s.get("led"),
              "followed": s.get("followed")} for s in r["soft_yeses"]]
    led = r["ledger"]
    return {"view": "network", "run_id": r["run_id"], "url": url, "company": (r["input"].get("company") or {}).get("name"),
            "softs": softs, "focus": graph.norm(focus) if focus else None, "path": path or [],
            "leads": [{"key": e["key"], "name": e["name"], "rank": e.get("rank"), "now": e.get("tier") == "active"}
                      for e in r["leads"][:40]],
            "ledger": {"calls": led.get("cala_calls"), "facts": led.get("facts"), "sources": led.get("sources"), "llm": 0},
            "net": net_view(r)}


def network_text(view: dict) -> str:
    """The same map in words, for the assistant: who the investors sat with most, and who led."""
    net = view["net"] or {"names": [], "rounds": [], "softs": 0}
    n_soft = net["softs"]
    shared: dict[int, set] = {}
    led_in: dict[int, set] = {}   # the rounds it led: a name listed twice in a round is one lead
    doors: dict[int, set] = {}
    for i, row in enumerate(net["rounds"]):
        for idx, is_lead, _ in row["i"]:
            if idx < n_soft:
                continue
            shared.setdefault(idx, set()).add(i)
            doors.setdefault(idx, set()).update(row["m"])
            if is_lead:
                led_in.setdefault(idx, set()).add(i)
    led = {k: len(v) for k, v in led_in.items()}
    names = net["names"]
    softs = " and ".join(s["name"] for s in view["softs"])
    out = [f"# Who {softs} {'has' if len(view['softs']) == 1 else 'have'} sat in a round with, in Cala", "",
           f"{len(net['rounds'])} rounds, {len(shared)} other investors one round away."]
    top = sorted(shared, key=lambda k: (-len(shared[k]), -led.get(k, 0), names[k]))[:15]
    for k in top:
        who = ", ".join(names[m] for m in sorted(doors[k]) if m < n_soft) or softs
        out.append(f"- {names[k]}: {len(shared[k])} shared round{'s' if len(shared[k]) != 1 else ''}"
                   + (f", led {led[k]} of them" if led.get(k) else "") + f". Door: {who}.")
    out += ["", f"Every round and source: {view['url']}", "No fact here was stated by a language model."]
    return "\n".join(out)


def draft_view(result: dict, lead: dict, d: dict, url: str, to: dict | None = None) -> dict:
    ask = lead.get("ask") or {}
    ev = [_evidence(x, lead["name"]) for x in lead["evidence"][:4] if (x.get("check") or {}).get("status") in ("lead", "report")]
    return {"view": "draft", "run_id": result["run_id"], "url": url, "kind": d["kind"],
            "lead": {"key": lead["key"], "name": lead["name"]},
            "to": {"fund": ask.get("name") if d["kind"] == "intro_ask" else lead["name"], **(to or {})},
            "subject": d.get("subject") or "", "body": d["body"], "facts": d["facts"], "yours": d.get("yours") or [],
            "placeholders": d.get("placeholders") or [], "note": d.get("note"), "written_by": d.get("model") or None,
            "dropped": d.get("rejected") or [], "proof": ev[:2]}


def _recent(iso: str | None, days: int = 45) -> bool:
    try:
        return (datetime.date.today() - datetime.date.fromisoformat((iso or "")[:10])).days <= days
    except ValueError:
        return False


def tracker_view(state: dict, result: dict, url: str) -> dict:
    """The round as it stands: who said yes, which leads were asked, and each lead's latest led round in Cala."""
    by_key = {e["key"]: e for e in result["leads"] + result.get("second_ring", [])}
    rows = []
    for key, row in state.get("leads", {}).items():
        e = by_key.get(key) or {}
        last = _brief(e.get("last_led"))
        rows.append({"key": key, "name": row.get("name") or e.get("name") or key, "status": row.get("status") or "to_ask",
                     "via": row.get("via") or (e.get("ask") or {}).get("name"), "date": row.get("date"), "note": row.get("note"),
                     "rank": e.get("rank"), "now": e.get("tier") == "active", "last_led": last,
                     "new": bool(last and _recent(last.get("date")))})
    order = {s: i for i, s in enumerate(("leading", "meeting", "replied", "asked", "to_ask", "passed"))}
    rows.sort(key=lambda x: (order.get(x["status"], 9), x.get("rank") or 99))
    softs = []
    for s in result["soft_yeses"]:
        mine = (state.get("softs") or {}).get(s["key"]) or {}
        softs.append({"key": s["key"], "name": s["name"], "amount": mine.get("amount"), "verdict": s.get("verdict")})
    target = state.get("target") or {}
    return {"view": "tracker", "tracker": state["id"], "run_id": result["run_id"], "url": url,
            "company": state.get("company") or (result["input"].get("company") or {}).get("name"),
            "stage_name": result["input"].get("stage_name"), "target": target, "softs": softs, "leads": rows,
            "labels": STATUS_LABEL, "updated": state.get("updated")}


def tracker_text(view: dict) -> str:
    out = [f"# {view.get('company') or 'The round'}: where it stands", ""]
    said = [s["name"] + (f" ({extras.fmt_money(s['amount'], (view.get('target') or {}).get('currency'))})" if s.get("amount") else "")
            for s in view["softs"]]
    out.append("Said yes once a lead is in: " + ", ".join(said) + ".")
    lead = next((x for x in view["leads"] if x["status"] == "leading"), None)
    out.append(f"Lead: {lead['name']}." if lead else "Lead: still open.")
    out.append("")
    for x in view["leads"]:
        line = f"- {x['name']}: {STATUS_LABEL.get(x['status'], x['status']).lower()}"
        if x.get("via"):
            line += f", through {x['via']}"
        if x.get("date"):
            line += f" ({x['date']})"
        if x.get("last_led"):
            ll = x["last_led"]
            line += f". Latest round it led in Cala: {', '.join(v for v in (ll.get('company'), ll.get('stage_name'), (ll.get('date') or '')[:7]) if v)}"
            if x.get("new"):
                line += " (new)"
        out.append(line)
    out += ["", f"Tracker id: {view['tracker']} (pass it as `tracker` to update this round).", f"Every round and source: {view['url']}"]
    return "\n".join(out)


def claim_view(d: dict, investor: str | None, url: str) -> dict:
    """A company's rounds with Cala's lead claim next to the sentence on the page Cala cites."""
    want = graph.norm(investor or "")
    rounds = []
    for r in d.get("rounds") or []:
        rows = []
        for i in r["investors"]:
            ck = i.get("check") or {}
            rows.append({"name": i["name"], "cala_lead": bool(i.get("cala_lead")), "status": ck.get("status"),
                         "led_by": (ck.get("led_by") or [])[:3], "quote": _clip(ck.get("quote"), (ck.get("led_by") or [i["name"]])[0]),
                         "url": ck.get("url"), "publisher": ck.get("publisher"),
                         "asked": bool(want and (want in graph.norm(i["name"]) or graph.norm(i["name"]) in want))})
        rounds.append({"id": r.get("id"), "stage_name": r.get("stage_name"), "date": r.get("date"),
                       "amount": extras.fmt_money(r.get("amount"), r.get("currency")) or None, "investors": rows,
                       "others": r.get("others") or 0})
    pc = d.get("page_check") or {}
    quotes = ((d.get("knowledge") or {}).get("quotes") or [])[:4]
    return {"view": "claim", "url": url, "company": (d.get("company") or {}).get("name"), "investor": investor or None,
            "rounds": rounds[:8], "pages": pc.get("pages") or 0, "confirmed": pc.get("confirmed") or 0,
            "corrected": pc.get("corrected") or 0, "investors_in_cala": d.get("investors_in_cala"),
            "said_on_pages": [{"quote": _clip(q.get("quote")), "url": q.get("url"), "publisher": q.get("publisher")} for q in quotes]}


def progress_key(args: dict) -> str:
    """One key for a walk as the assistant asked for it, so the card can ask how far the same walk has got."""
    names = [str(x.get("investor") or x.get("name") or "") if isinstance(x, dict) else str(x)
             for x in (args.get("soft_yeses") or []) + (args.get("investors") or [])]
    return re.sub(r"[^a-z0-9|]+", "", "|".join(sorted({graph.norm(n) for n in names if n}))
                  + "|" + graph.norm(str(args.get("company") or "")) + "|" + str(args.get("stage") or "").lower())
