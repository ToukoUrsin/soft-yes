# The demo film

Films of Soft Yes, made from recordings of the live product.

- `out/film.mp4` (1:56) is the film to show. The site serves it at `/film.mp4`. In order: the 10 s cold open, a clip of
  the team, Soft Yes inside Claude read by the founder, the closing card and the team's sign-off.
- `out/demo-3.mp4` is that cut as it is rendered; `join.sh` copies it to `out/film.mp4`. How it is made: "The cut made inside Claude" below.
- `out/demo-2.mp4` (87 s) shows the website; `out/screenshot.png` is its reveal frame (the walk folded into the ranked list).
- `out/demo-v1.mp4` is the first, two minute cut (a copy is at `../judging/demo.mp4`).

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

## The cut made inside Claude

`out/demo-3.mp4`: the cold open, the team on camera, then Soft Yes in claude.ai: the question typed, companies like
yours and their investors drawing in the chat, the eight signals on each investor, the first investor's latest
rounds, the way in link by link, the soft yes, the closing card and the team saying thanks. The founder reads the
lines himself. Its run output is under `/bulk3/runs/cala/film-claude/`.

```sh
export FILM_BULK=/bulk3/runs/cala/film-claude
# 1. record the shots in a signed-in Claude (cfind sends one message; cinv and csoft reopen finished chats)
python3 film/capture/claude_session.py
film/capture/quiet-net.sh run uv run -q --offline --with playwright python film/capture/claude_shots.py cfind cinv csoft
# 2. the voice: a recording of someone reading the lines (`node scripts/make-vo.mjs --cut3 --json` prints them).
#    Re-read a line as often as you like: the last whole take of each line is kept.
cd film && python3 scripts/voice-in.py RECORDING.mp4 --name touko
# 3. the team's two clips: cut to the speech, the sound levelled, captions from their own words
python3 scripts/team-in.py
# 4. the lines with their timing, render, review (CONCURRENCY keeps the render small on a shared machine)
node scripts/make-vo.mjs --cut3 --recorded $FILM_BULK/public/audio/touko/touko.json \
  && CONCURRENCY=12 ./render.sh 3 && scripts/review.sh out/demo-3.mp4
# 5. out/film.mp4
./join.sh
```

- The open is `/bulk3/runs/opens/final/softyes/open.mp4` (made in `~/junction/opens/softyes/`). It is the film's first
  scene: `src/Film.tsx` plays its picture and its sound under the first line.
- In the shots the pointer rests next to what it shows, never on a name or a number.

- The shots need a Claude session with the Soft Yes connector on and its tools on "Always allow".
  `capture/claude_session.py` keeps the session in `/dev/shm`, never in the repo.
- The shots hide the account's usage notice and keep Claude's own words under the card out of frame.
- `src/scenes3.tsx` is the edit, `src/data/cap3.json` what the shots saw, `src/data/vo3.json` the spoken lines,
  `src/data/timing3.json` the scene order.
- A quick look without a full render: `COMP=Film3Silent scripts/sheets.sh`.
- The music is one bed under everything after the open (`public/audio/music-c4-115.mp3`); it ducks under the voice
  and under the team's clips. `src/data/timing3.json` says where it starts (`musicFrom`).
- No voice is generated for this cut: every spoken line is the founder's recording or the team's own clip.

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
