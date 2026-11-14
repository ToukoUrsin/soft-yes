#!/bin/bash
# Review pack for a render: a frame every 2 s (the exact frame, stamped with its time) on 3x3 contact sheets, loudness, black stretches.
#   scripts/review.sh out/demo-v1.mp4            -> $FILM_BULK/review/demo-v1-<time>/
set -euo pipefail
in=$1
bulk=${FILM_BULK:-/bulk2/runs/cala/film}
out="$bulk/review/$(basename "${in%.*}")-$(date +%m%d-%H%M%S)"   # a new folder per review, nothing is deleted
mkdir -p "$out/frames"
ffprobe -v error -show_entries format=duration,size,bit_rate:stream=codec_name,width,height,r_frame_rate,nb_frames -of default=nw=1 "$in" > "$out/probe.txt"
ffmpeg -nostdin -loglevel error -i "$in" -vf "select='not(mod(n\,60))',scale=960:-1,drawtext=text='%{pts\:hms}':x=10:y=10:fontsize=26:fontcolor=yellow:box=1:boxcolor=black@0.7" -vsync vfr -q:v 3 "$out/frames/f%03d.jpg"
ffmpeg -nostdin -loglevel error -pattern_type glob -i "$out/frames/f*.jpg" -vf "tile=3x3:padding=6:color=black" -q:v 3 "$out/sheet-%02d.jpg"
ffmpeg -nostdin -hide_banner -i "$in" -af ebur128=peak=true -f null - > "$out/ebur.txt" 2>&1 || true
grep -A14 "Summary" "$out/ebur.txt" > "$out/loudness.txt" || true
ffmpeg -nostdin -hide_banner -i "$in" -vf "blackdetect=d=0.4:pix_th=0.06" -an -f null - 2>&1 | grep blackdetect > "$out/black.txt" || true
cat "$out/probe.txt" "$out/loudness.txt" "$out/black.txt"
echo "sheets: $out"
