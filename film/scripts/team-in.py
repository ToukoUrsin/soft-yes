#!/usr/bin/env python3
"""The team's own clips, made ready for the film: scripts/team-in.py

The team talks to the camera right after the cold open, and the film ends on them saying thanks (phone clips, AirDropped; the
originals are in /bulk2/runs/junction/airdrop-1115/). For each clip this writes
  $FILM_BULK/public/team/<name>.mp4   the picture: 1920x1080, 30 fps, the phone's HDR brought down to normal video,
                                      cut to the speech
  $FILM_BULK/public/team/<name>.wav   the sound, cleaned and set to the level of the narration
and src/data/team3.json ({name: {scene, text, file, video, dur, words}}), which scripts/make-vo.mjs --cut3 puts into
the film's lines, so the clips get the same captions as the narration and the music ducks under them.
The length of each clip goes into src/data/timing3.json ("fixed").
"""
import importlib.util
import json
import os
import subprocess

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
FILM = os.path.dirname(HERE)
SRC = "/bulk2/runs/junction/airdrop-1115"
CLIPS = [
    # name, scene, file, what is said (Whisper hears "Racing" and "cloud"), seconds kept before and after the speech,
    # the level of the speech in dBFS (the thanks is four people shouting: 4 dB under the rest)
    # the opening clip starts at its second sentence ("Even though we're founders, VCs and operators, we all agree on one
    # thing." is cut: 5.33 s of speech before the product is on screen)
    ("open", "team", "IMG_0747.MOV", "Raising a massive round, even in the age of AI, is difficult. We just wish there was something we could plug into our Claude that would help us.", 0.2, 0.3, -21, 5.33),
    ("thanks", "thanks", "IMG_0739.MOV", "Thank you for watching!", 0.1, 0.5, -25, 0),
]

spec = importlib.util.spec_from_file_location("voice_in", os.path.join(HERE, "voice-in.py"))
V = importlib.util.module_from_spec(spec)
spec.loader.exec_module(V)


def main():
    bulk = os.environ.get("FILM_BULK", "/bulk3/runs/cala/film-claude")
    out = os.path.join(bulk, "public/team")
    os.makedirs(out, exist_ok=True)
    clean = "highpass=f=85,afftdn=nr=12:nf=-48,acompressor=threshold=-24dB:ratio=3:attack=8:release=180"
    data, fixed = {}, {}
    for name, scene, fn, text, pre, post, level, skip in CLIPS:
        path = os.path.join(SRC, fn)
        x = V.read_pcm(path, V.SR, clean)
        env, quiet = V.levels(x, V.SR)
        on = np.nonzero(env >= quiet)[0]
        full = len(x) / V.SR
        a, b = max(0.0, on[0] / 100 - pre) + skip, min(full, on[-1] / 100 + post)
        # whole frames
        a, b = round(a * 30) / 30, round(b * 30) / 30
        seg = x[int(a * V.SR) : int(b * V.SR)].copy()
        e2, q2 = V.levels(seg, V.SR)
        speech = float(np.sqrt(np.mean(e2[e2 >= q2] ** 2)))
        seg = np.tanh(seg * (10 ** (level / 20) / max(speech, 1e-4)) / 0.9) * 0.9
        f = int(0.03 * V.SR)
        seg[:f] *= np.linspace(0, 1, f, dtype=np.float32)
        seg[-f:] *= np.linspace(1, 0, f, dtype=np.float32)
        V.write_wav(os.path.join(out, f"{name}.wav"), seg)
        # the picture: HLG from the phone, tone-mapped to normal video
        vf = "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p,fps=30,scale=1920:1080:flags=lanczos"
        V.sh("ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-ss", f"{a:.3f}", "-to", f"{b:.3f}", "-i", path, "-an", "-vf", vf, "-c:v", "libx264", "-crf", "15", "-preset", "slow", "-g", "15", "-movflags", "+faststart", os.path.join(out, f"{name}.mp4"))
        # the words, for the captions
        pcm16 = V.read_pcm(os.path.join(out, f"{name}.wav"), 16000)
        tw = V.transcribe(pcm16, "Soft Yes, Claude, VCs, founders, operators, raising a round.")
        raw = text.split()
        times, missing = V.word_times(raw, tw)
        dur = len(seg) / V.SR
        words = [{"w": raw[k], "s": round(max(0, times[k][0]), 3), "e": round(min(dur, times[k][1]), 3)} for k in range(len(raw))]
        data[name] = {"scene": scene, "text": text, "file": f"team/{name}.wav", "video": f"team/{name}.mp4", "dur": round(dur, 3), "words": words}
        fixed[scene] = round(dur, 3)
        print(f"{name}: {fn} {a:.2f}-{b:.2f} of {full:.2f} s -> {dur:.2f} s; heard: {' '.join(w['w'] for w in tw)}" + (f"  ({missing} words placed by guess)" if missing else ""))
    json.dump(data, open(os.path.join(FILM, "src/data/team3.json"), "w"), indent=1)
    tp = os.path.join(FILM, "src/data/timing3.json")
    T = json.load(open(tp))
    T.setdefault("fixed", {}).update(fixed)
    json.dump(T, open(tp, "w"), indent="\t")
    open(tp, "a").write("\n")
    print("fixed:", T["fixed"])


if __name__ == "__main__":
    main()
