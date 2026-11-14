#!/bin/bash
# Render the film: ./render.sh [2]  ->  out/demo-2.mp4 (1920x1080, 30 fps, about -16 LUFS) and out/screenshot.png (the reveal frame)
# Captures, voice and music are read from $FILM_BULK/public (default /bulk2/runs/cala/film/public).
set -euo pipefail
cd "$(dirname "$0")"
v=${1:-2}
bulk=${FILM_BULK:-/bulk2/runs/cala/film}
raw="$bulk/render/raw-$v.mp4"
mkdir -p out "$bulk/render"
# Chrome drops requests whenever a network interface changes (containers starting on this machine);
# frames are retried inside the film, a failed start is retried here
ok=0
[ "${SKIP_RENDER:-}" = 1 ] && [ -s "$raw" ] && ok=1   # SKIP_RENDER=1: only loudness and screenshot, from the raw render already there
for try in 1 2 3; do
	[ "$ok" = 1 ] && break
	if npx remotion render src/index.ts Film "$raw" --public-dir "$bulk/public" --codec h264 --crf 17 --audio-bitrate 192k \
		--concurrency "${CONCURRENCY:-20}" --offthreadvideo-cache-size-in-bytes 2000000000 --log=error; then ok=1; break; fi
	echo "render attempt $try failed, trying again" >&2
done
[ "$ok" = 1 ] || { echo "render failed" >&2; exit 1; }
# loudness to -16 LUFS in two passes (measure, then apply), picture copied untouched
m=$(ffmpeg -nostdin -hide_banner -i "$raw" -vn -af loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json -f null - 2>&1 | sed -n '/^{/,/^}/p')
g() { echo "$m" | sed -n "s/.*\"$1\" : \"\(.*\)\".*/\1/p"; }
ffmpeg -nostdin -loglevel error -y -i "$raw" -c:v copy \
	-af "loudnorm=I=-16:TP=-1.5:LRA=11:measured_I=$(g input_i):measured_TP=$(g input_tp):measured_LRA=$(g input_lra):measured_thresh=$(g input_thresh):offset=$(g target_offset):linear=true" \
	-ar 48000 -c:a aac -b:a 192k -movflags +faststart "out/demo-$v.mp4"
# the reveal (the walk folded into the ranked list) as the project's screenshot
at=$(node scripts/reveal.mjs)
ffmpeg -nostdin -loglevel error -y -ss "$at" -i "out/demo-$v.mp4" -frames:v 1 out/screenshot.png
echo "screenshot.png: the frame at $at s"
ls -la "out/demo-$v.mp4" out/screenshot.png
