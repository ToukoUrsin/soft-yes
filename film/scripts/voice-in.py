#!/usr/bin/env python3
"""A recorded voice, cut to the film's lines: scripts/voice-in.py RECORDING [--name touko] [--limit 118]

RECORDING is anything ffmpeg reads (a Loom .mp4, .m4a, .webm): someone reading the lines of the Soft Yes tab
(~/junction/.booth/lines-mac.html; the same text as `node scripts/make-vo.mjs --cut3 --json`), one after the other,
with pauses, in any number of takes. Local Whisper finds the words; for each line the last good take is kept.

What it does:
  1. cleans and levels the whole recording once (so every line has the same tone), 48 kHz mono
  2. finds every take of every line in the transcript and keeps the last one that has the whole line
  3. cuts each line on the silence around it, takes long breaths out of its middle, fades the ends
  4. writes $FILM_BULK/public/audio/<name>/line-NN.wav and <name>.json ([{text, file, dur, words}])
  5. if the film would run past --limit seconds, speeds the voice up a little (never more than 12 %)
Then: node scripts/make-vo.mjs --cut3 --recorded $FILM_BULK/public/audio/<name>/<name>.json [--music], and ./render.sh 3.
"""
import argparse
import difflib
import json
import math
import os
import re
import subprocess
import sys
import wave

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
FILM = os.path.dirname(HERE)
SR = 48000


def sh(*a, **k):
    return subprocess.run(list(a), check=True, capture_output=True, **k)


def norm(w):
    return re.sub(r"[^a-z0-9']", "", w.lower().replace("’", "'"))


def read_pcm(path, sr, af=None):
    cmd = ["ffmpeg", "-nostdin", "-loglevel", "error", "-i", path, "-vn"]
    if af:
        cmd += ["-af", af]
    cmd += ["-f", "s16le", "-ac", "1", "-ar", str(sr), "-"]
    return np.frombuffer(sh(*cmd).stdout, np.int16).astype(np.float32) / 32768.0


def write_wav(path, x):
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes((np.clip(x, -1, 1) * 32767).astype(np.int16).tobytes())


def levels(x, sr):
    """The loudness of the signal in 10 ms steps, and the level under which nobody is speaking."""
    hop = sr // 100
    env = np.sqrt(np.convolve(x**2, np.ones(hop * 2) / (hop * 2), mode="same"))[::hop]
    quiet = max(np.percentile(env, 10) * 3, np.percentile(env, 92) * 0.06, 10 ** (-56 / 20))
    return env, quiet


def phrases(env, quiet, gap=0.5):
    """The stretches of speech, split wherever nobody speaks for `gap` seconds: [(start, end)] in seconds."""
    on = env >= quiet
    out, start, last = [], None, None
    for k, v in enumerate(on):
        if not v:
            continue
        if start is None:
            start = k
        elif k - last > gap * 100:
            out.append((start / 100, (last + 1) / 100))
            start = k
        last = k
    if start is not None:
        out.append((start / 100, (last + 1) / 100))
    return [(a, b) for a, b in out if b - a >= 0.18]


def transcribe(pcm16, names):
    """Phrase by phrase, each on its own: read as one piece, Whisper leaves out words that are said twice,
    and a line that was started, dropped and said again is exactly that."""
    from faster_whisper import WhisperModel

    model = WhisperModel(os.environ.get("WHISPER_MODEL", "small"), download_root="/bulk2/runs/spankki/whisper", device="cpu", compute_type="int8", cpu_threads=12)
    env, quiet = levels(pcm16, 16000)
    words = []
    for a, b in phrases(env, quiet):
        a0, b0 = max(0, a - 0.2), min(len(pcm16) / 16000, b + 0.25)
        segs, _ = model.transcribe(pcm16[int(a0 * 16000) : int(b0 * 16000)], language="en", word_timestamps=True, vad_filter=False, beam_size=5, condition_on_previous_text=False, initial_prompt=names)
        for sg in segs:
            if sg.no_speech_prob > 0.8:
                continue
            words += [{"w": w.word.strip(), "s": float(w.start) + a0, "e": float(w.end) + a0} for w in sg.words if w.word.strip()]
    return words


def takes_of(line_words, tw):
    """Every place in the transcript where this line is said: [(score, first word, one past the last word)], best per place."""
    target = " ".join(line_words)
    n = len(line_words)
    tn = [norm(w["w"]) for w in tw]
    out = []
    for i in range(len(tn)):
        # a take starts on something like the line's first words
        head = " ".join(tn[i : i + 3])
        if difflib.SequenceMatcher(None, " ".join(line_words[:3]), head).ratio() < 0.6:
            continue
        best = (0.0, i, i)
        for m in range(max(2, n - 5), n + 6):
            if i + m > len(tn):
                break
            r = difflib.SequenceMatcher(None, target, " ".join(tn[i : i + m]), autojunk=False).ratio()
            if r > best[0]:
                best = (r, i, i + m)
        out.append(best)
    # two candidates one or two words apart are the same take: keep the better
    out.sort(key=lambda t: t[1])
    kept = []
    for t in out:
        if kept and t[1] < kept[-1][2] - 1:
            if t[0] > kept[-1][0]:
                kept[-1] = t
        else:
            kept.append(t)
    return kept


def word_times(line_raw, tw_slice):
    """The line's own words (its spelling) on the take's times; a word Whisper heard differently gets its place between its neighbours."""
    a = [norm(w) for w in line_raw]
    b = [norm(w["w"]) for w in tw_slice]
    t = [None] * len(a)
    sm = difflib.SequenceMatcher(None, a, b, autojunk=False)
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal":
            for k in range(i2 - i1):
                t[i1 + k] = (tw_slice[j1 + k]["s"], tw_slice[j1 + k]["e"])
        elif tag == "replace":
            # the same stretch of sound, heard as other words: share it out by the length of the words
            s, e = tw_slice[j1]["s"], tw_slice[j2 - 1]["e"]
            total = sum(len(x) + 1 for x in a[i1:i2])
            at = s
            for k in range(i1, i2):
                d = (e - s) * (len(a[k]) + 1) / total
                t[k] = (at, at + d)
                at += d
    # words Whisper did not hear at all: put them in the gap they fall in
    missing = sum(1 for x in t if x is None)
    for k in range(len(t)):
        if t[k] is not None:
            continue
        j = k
        while j < len(t) and t[j] is None:
            j += 1
        left = t[k - 1][1] if k else tw_slice[0]["s"]
        right = t[j][0] if j < len(t) else tw_slice[-1]["e"]
        step = (right - left) / (j - k)
        for q in range(k, j):
            t[q] = (left + step * (q - k), left + step * (q - k + 1))
    return t, missing


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("recording")
    ap.add_argument("--name", default="touko")
    ap.add_argument("--limit", type=float, default=118.0, help="the film may not run longer than this many seconds")
    ap.add_argument("--tempo", type=float, default=0, help="speed the voice up by this factor (0: only as much as --limit asks)")
    ap.add_argument("--words", help="a transcript already made ([{w,s,e}]), instead of running Whisper")
    A = ap.parse_args()
    bulk = os.environ.get("FILM_BULK", "/bulk3/runs/cala/film-claude")
    out = os.path.join(bulk, "public/audio", A.name)
    os.makedirs(out, exist_ok=True)
    lines = json.loads(sh("node", os.path.join(HERE, "make-vo.mjs"), "--cut3", "--json", cwd=FILM).stdout)

    # 1. the whole recording, cleaned once: rumble out, a little noise out, evened, to one loudness
    # (one gain for the whole recording, set on the speech alone: a loudness filter that follows the signal would lift the room in every pause)
    clean = "highpass=f=75,afftdn=nr=10:nf=-52,acompressor=threshold=-24dB:ratio=2.5:attack=8:release=180"
    x = read_pcm(A.recording, SR, clean)
    env0, q0 = levels(x, SR)
    speech = float(np.sqrt(np.mean(np.repeat(env0[env0 >= q0], 1) ** 2))) if np.any(env0 >= q0) else 0.05
    x = np.tanh(x * (10 ** (-21 / 20) / max(speech, 1e-4)) / 0.9) * 0.9
    print(f"recording: {len(x) / SR:.1f} s")

    # 2. the words
    wpath = os.path.join(out, "transcript.json")
    if A.words:
        tw = json.load(open(A.words))
    else:
        names = "Soft Yes, Cala, Claude, Tesi, Innovestor, Verda, Emergence Capital, Lifeline, Measur, VentureFriends, Kfund, FJ Labs, Contrarian, Ovni."
        tw = transcribe(read_pcm(A.recording, 16000), names)
        json.dump(tw, open(wpath, "w"))
    print(f"{len(tw)} words heard: {' '.join(w['w'] for w in tw)[:600]}...")

    env, quiet = levels(x, SR)
    is_quiet = lambda a, b: bool(np.all(env[max(0, int(a * 100)) : max(1, int(b * 100))] < quiet))

    def edge(t, way, reach, still=6):
        """From a word's edge, walk outwards (way -1 back, +1 on) to where the voice has stopped for `still` hundredths of a second; at most `reach` seconds."""
        k = int(t * 100)
        for step in range(int(reach * 100)):
            q = k + way * step
            if q < still or q >= len(env) - still:
                return q / 100
            if is_quiet(min(q, q + way * still) / 100, max(q, q + way * still) / 100 + 0.01):
                return q / 100
        return (k + way * int(reach * 100)) / 100

    result, report, bad = [], [], []
    for n, L in enumerate(lines):
        raw = L["text"].split()
        lw = [norm(w) for w in raw]
        takes = takes_of(lw, tw)
        if not takes:
            bad.append(f"line {n + 1} was not found in the recording: {L['text']}")
            continue
        top = max(t[0] for t in takes)
        good = [t for t in takes if t[0] >= max(0.72, top - 0.08)]
        if not good:
            bad.append(f"line {n + 1} is only half there (best match {top:.2f}): {L['text']}")
            continue
        score, i, j = good[-1]  # the last good take
        sl = tw[i:j]
        times, missing = word_times(raw, sl)
        # 3. cut on the silence around the take (the reader pauses between lines): Whisper's own word edges are a tenth of a
        # second off either way, and its first word may be one word late
        s = max(edge(sl[0]["s"] + 0.03, -1, 0.9, 14) - 0.07, 0)
        e = min(edge(sl[-1]["e"] - 0.03, +1, 1.2, 16) + 0.14, len(x) / SR)
        seg = x[int(s * SR) : int(e * SR)].copy()
        words = [{"w": raw[k], "s": times[k][0] - s, "e": times[k][1] - s} for k in range(len(raw))]
        # long pauses inside the line come down to a breath: 0.38 s after a full stop, 0.26 s elsewhere
        cut_total = 0.0
        for k in range(len(words) - 1, 0, -1):
            a, b = words[k - 1]["e"], words[k]["s"]
            keep = 0.38 if re.search(r"[.?!:]$", words[k - 1]["w"]) else 0.26
            if b - a <= keep + 0.12:
                continue
            # only real silence is taken out, from its middle
            qa, qb = edge(a + s, +1, b - a) - s + 0.06, edge(b + s, -1, b - a) - s - 0.06
            if qb - qa <= keep:
                continue
            drop = (qb - qa) - keep
            m0 = int((qa + keep / 2) * SR)
            m1 = int((qa + keep / 2 + drop) * SR)
            f = int(0.012 * SR)
            ramp = np.linspace(0, 1, f, dtype=np.float32)
            joined = seg[m0 - f : m0] * (1 - ramp) + seg[m1 - f : m1] * ramp
            seg = np.concatenate([seg[: m0 - f], joined, seg[m1:]])
            for w in words[k:]:
                w["s"] -= drop
                w["e"] -= drop
            cut_total += drop
        f_in, f_out = int(0.012 * SR), int(0.07 * SR)
        seg[:f_in] *= np.linspace(0, 1, f_in, dtype=np.float32)
        seg[-f_out:] *= np.linspace(1, 0, f_out, dtype=np.float32)
        result.append({"n": n, "text": L["text"], "pcm": seg, "words": words})
        report.append(f"  {n + 1:2d}. take at {s:6.1f} s  match {score:.2f}  {len(seg) / SR:5.2f} s" + (f"  ({len(takes)} takes, last good kept)" if len(takes) > 1 else "") + (f"  {missing} words placed by guess" if missing else "") + (f"  {cut_total:.1f} s of pauses out" if cut_total > 0.05 else "") + ("   <- LISTEN: weak match" if score < 0.85 else "") + ("   <- LISTEN: a word over 1.6 s, maybe a restart inside" if max(w["e"] - w["s"] for w in sl) > 1.6 else ""))
    print("\n".join(report))
    if bad:
        print("\n".join(bad), file=sys.stderr)
        sys.exit(2)

    def write(tempo):
        rows = []
        for r in result:
            base = os.path.join(out, f"line-{r['n'] + 1:02d}.wav")
            write_wav(base, r["pcm"])
            dur, words = len(r["pcm"]) / SR, r["words"]
            if abs(tempo - 1) > 0.004:
                tmp = base[:-4] + ".t.wav"
                sh("ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-i", base, "-af", f"atempo={tempo:.4f}", "-ar", str(SR), "-ac", "1", tmp)
                os.replace(tmp, base)
                dur = float(sh("ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", base).stdout)
                words = [{"w": w["w"], "s": w["s"] / tempo, "e": w["e"] / tempo} for w in words]
            rows.append({"text": r["text"], "file": f"audio/{A.name}/line-{r['n'] + 1:02d}.wav", "dur": round(dur, 3), "words": [{"w": w["w"], "s": round(max(0, w["s"]), 3), "e": round(min(dur, w["e"]), 3)} for w in words]})
        path = os.path.join(out, f"{A.name}.json")
        json.dump(rows, open(path, "w"), indent=1)
        return path, rows

    # 5. how long the film gets with this voice: the same sum the film makes (src/data.ts), "So you ask Claude" starting before its scene
    T = json.load(open(os.path.join(FILM, "src/data/timing3.json")))

    def film_len(rows):
        total = 0.0
        for sid in T["order"]:
            if sid in T.get("fixed", {}):
                total += T["fixed"][sid]
                continue
            t = 0.0
            for L, r in zip(lines, rows):
                if L["scene"] != sid:
                    continue
                gap = L["gap"]
                if sid == "ask":
                    soft = next((w["s"] for w in r["words"] if norm(w["w"]).startswith("soft")), 0)
                    gap = 0.3 - soft
                t += gap + r["dur"]
            total += math.ceil((t + T["tail"][sid]) * 30) / 30
        return total

    tempo = A.tempo or 1.0
    path, rows = write(tempo)
    total = film_len(rows)
    if not A.tempo and total > A.limit:
        voice = sum(r["dur"] for r in rows)
        tempo = min(1.12, voice / max(1, voice - (total - A.limit) - 0.4))
        path, rows = write(tempo)
        total = film_len(rows)
    first = rows[0]["dur"]
    print(f"voice {sum(r['dur'] for r in rows):.1f} s" + (f" at {tempo:.2f}x" if abs(tempo - 1) > 0.004 else "") + f", film {total:.1f} s (limit {A.limit:.0f}), first line {first:.1f} s (room over the open: about 8.0 s)")
    if total > A.limit:
        print(f"STILL TOO LONG by {total - A.limit:.1f} s: shorten tails in src/data/timing3.json or cut a line", file=sys.stderr)
    print(path)


if __name__ == "__main__":
    main()
