#!/bin/bash
# The film as it is shown: the cold open, then the cut made inside Claude.
#   ./join.sh  ->  out/film.mp4 (1920x1080, 30 fps), served by the site at /film.mp4 (deploy/publish.sh copies it)
#
# The open (OPEN, 10.0 s at 24 fps, made in ~/junction/opens) ends on the film's own window with nothing in it,
# so the film's first screen comes up inside that window over the open's last quarter second. The open keeps its
# own sound; the film's voice and music start at the join. OPEN_MUTE=1 leaves the open silent.
# Before this: ./render.sh 3, and `cd ~/junction/opens && python3 softyes/refresh.py --check` (the number on the open is live).
set -euo pipefail
cd "$(dirname "$0")"
open=${OPEN:-/bulk3/runs/opens/final/softyes/open.mp4}
film=out/demo-3.mp4
fade=0.25
len=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$open")
at=$(python3 -c "print(round($len - $fade, 3))")
ms=$(python3 -c "print(int(round(($len - $fade) * 1000)))")
vol=1
[ "${OPEN_MUTE:-}" = 1 ] && vol=0
ffmpeg -nostdin -loglevel error -y -i "$open" -i "$film" -filter_complex "
	[0:v]fps=30,format=yuv420p,setsar=1,settb=AVTB[o];
	[1:v]fps=30,format=yuv420p,setsar=1,settb=AVTB[f];
	[o][f]xfade=transition=fade:duration=$fade:offset=$at[v];
	[0:a]aresample=48000,volume=$vol[oa];
	[1:a]aresample=48000,adelay=$ms:all=1[fa];
	[oa][fa]amix=inputs=2:normalize=0:duration=longest[a]" \
	-map "[v]" -map "[a]" -c:v libx264 -crf 17 -preset slow -pix_fmt yuv420p -color_primaries bt709 -color_trc bt709 -colorspace bt709 \
	-c:a aac -b:a 192k -ar 48000 -movflags +faststart out/film.mp4
ffprobe -v error -show_entries format=duration,size -of default=nw=1 out/film.mp4
