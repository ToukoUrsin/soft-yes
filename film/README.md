# The demo film

A 90 second film of Soft Yes, made from recordings of the live product. The current cut is
`out/demo-2.mp4`; `out/screenshot.png` is its reveal frame (the walk folded into the ranked list).
`out/demo-v1.mp4` is the first, two minute cut (a copy is at `../judging/demo.mp4`).

Everything on screen is the real product. Every number the voice says or a headline shows is read
from the product when the shots are recorded, and the narration is rebuilt from those numbers.

## Make it again

The product must be running on `http://127.0.0.1:8655`. From the product folder:

```sh
# 1. record every shot from the live product (about 3 minutes; a restyled UI is fine, selectors are text and roles)
uv run -q --with playwright python film/capture/capture.py

# 2. voice (and music cut to the new length), render, screenshot, review (about 6 minutes)
cd film && hsec exec --only ELEVENLABS_API_KEY -- node scripts/make-vo.mjs --music && ./render.sh 2 && scripts/review.sh out/demo-2.mp4
```

Step 2 costs little when no sentence changed: each spoken line is kept by its text, so only a line
whose number changed is made again. Leave `--music` out to keep the music already made for that
length. `node scripts/make-vo.mjs --print` prints the narration. First time only: `cd film && npm install`.

One shot only: `uv run -q --with playwright python film/capture/capture.py lead` (shots: `walk check
page lead ask audit next`, in any order). Each shot writes the time it was recorded to
`src/data/cap.json` (`at`, UTC).

No shot starts a new walk, so recording costs no Cala credits. Every run-page shot opens the stored
Tesi + Innovestor result, `/r/5c6518e3ff` (set `FILM_RUN=<id>` to film another finished run). The
`walk` shot opens that page on its answer and clicks "Replay the walk", which draws the same walk
again from the stored result.

A quick look before a full render: `cd film && scripts/sheets.sh` writes one frame a second as 3x3
sheets (about 15 seconds). `node scripts/reveal.mjs` prints the second of the reveal frame.

## What is where

| Path | What |
| --- | --- |
| `capture/rec.py` | The recorder: headless Chrome at 1280x720 and 1.5x (1920x1080 pixels), frames from the DevTools screencast written as a 30 fps mp4, a drawn pointer, eased moves and scrolls. |
| `capture/capture.py` | The seven shots. Each saves its clip plus marks (seconds), boxes (pixels) and the numbers it read from the page and from `/api/run/<id>`, `/api/audit`, `/api/says/top`, `/api/slush`. |
| `src/data/cap.json` | What the shots saw. The narration and the edit read it. |
| `scripts/make-vo.mjs` | The narration (numbers from `cap.json`), ElevenLabs voice with word timing, the music bed cut to the film's length. |
| `src/data/vo.json` | The spoken lines with word timing; the captions are cut from it. |
| `src/data/timing.json` | Scene order and the pause after each scene. |
| `src/data.ts` | The timeline: each scene is as long as its narration. |
| `src/scenes.tsx` | The seven scenes: which clip seconds play when, where the camera looks, what is outlined. |
| `src/ui.tsx`, `src/Film.tsx` | The stage the footage plays in, headlines, captions, music ducking. |
| `render.sh` | Remotion render, loudness to -16 LUFS, and the reveal frame saved as `out/screenshot.png`. |
| `scripts/review.sh` | Contact sheets (a frame every 2 s), loudness, black-stretch check. |
| `scripts/sheets.sh` | One frame a second straight from the timeline, without a full render. |
| `scripts/reveal.mjs` | The second at which the walk has folded into the ranked list (the screenshot frame). |

Many-file output is kept out of git, under `/bulk2/runs/cala/film/` (no backups; set `FILM_BULK` to
move it): `public/cap/` the recorded clips, `public/audio/` voice and music, `render/` the raw
render, `review/` contact sheets, `explore/`, `chk/` and `ref/` scratch from making the film.

## Rules the film keeps

- No mock-ups and no invented numbers. If a shot cannot find what it needs, it fails instead of guessing.
- Footage that is sped up carries a speed mark in the corner of the window.
- A draft whose first version was dropped by the check is shown only if a real one comes back at
  capture time (`ask.facts.dropped`); it is never staged.
- The company typed into the request ("Tundra Power") is made up, as a founder's own three lines would be.
  Investors and companies shown are the ones Cala returns with sources. The film does not scroll the
  list of corrections on `/audit`, whose quoted sentences name people.
- Keys come from `hsec` at run time and are never written to a file.
