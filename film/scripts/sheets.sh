#!/bin/bash
# Quick look without a full render: one frame per second of the film on 3x3 contact sheets (about a minute).
#   scripts/sheets.sh [every-nth-frame, default 30]  ->  $FILM_BULK/review/seq-<time>/sheet-NN.jpg   (COMP=Film3Silent: the cut made inside Claude)
set -euo pipefail
cd "$(dirname "$0")/.."
n=${1:-30}
bulk=${FILM_BULK:-/bulk2/runs/cala/film}
out="$bulk/review/seq-$(date +%m%d-%H%M%S)"
mkdir -p "$out"
for try in 1 2 3; do
	npx remotion render src/index.ts "${COMP:-FilmSilent}" "$out/frames" --sequence --every-nth-frame "$n" --image-format jpeg --jpeg-quality 85 \
		--public-dir "$bulk/public" --concurrency "${CONCURRENCY:-24}" --log=error && break
done
ffmpeg -nostdin -loglevel error -pattern_type glob -i "$out/frames/*.jpeg" -vf "scale=960:-1,tile=3x3:padding=6:color=black" -q:v 3 "$out/sheet-%02d.jpg"
echo "sheets: $out"
