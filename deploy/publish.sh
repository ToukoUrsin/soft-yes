#!/usr/bin/env bash
# Publish Soft Yes to https://soft-yes.fly.dev: the code, the built page (web/dist) and a snapshot of the
# Cala cache. The app on Fly merges the snapshot into its own cache on start, so nothing it learned is lost.
# Run after any backend change or `npm run build` that should be public.
set -euo pipefail
cd "$(dirname "$0")/.."
rm -f deploy/fly/seed.db
python3 - <<'PY'
import sqlite3
src, dst = sqlite3.connect("data/cache.db"), sqlite3.connect("deploy/fly/seed.db")
src.backup(dst)
dst.close(); src.close()
PY
uv export -q --no-hashes --no-dev > deploy/fly/requirements.txt
exec hsec exec --only FLY_API_TOKEN -- flyctl deploy . --config deploy/fly/fly.toml --dockerfile deploy/fly/Dockerfile --ha=false --now
