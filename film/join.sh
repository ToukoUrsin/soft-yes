#!/bin/bash
# The film as it is shown: out/film.mp4, served by the site at /film.mp4 (deploy/publish.sh copies it).
#   ./join.sh  ->  out/film.mp4 (1920x1080, 30 fps)
#
# The cold open (10.0 s, made in ~/junction/opens) is the film's first scene now: Film3 plays its picture and its sound
# under the first line (src/Film.tsx, Open3Over), so there is nothing left to join. This only copies the render.
# Before this: ./render.sh 3 (reads $FILM_BULK/public/open/open_clean.mp4 and open.wav, copies of /bulk3/runs/opens/final/softyes/).
set -euo pipefail
cd "$(dirname "$0")"
cp out/demo-3.mp4 out/film.mp4
ffprobe -v error -show_entries format=duration,size -of default=nw=1 out/film.mp4
