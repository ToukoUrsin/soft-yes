#!/usr/bin/env bash
# Start Soft Yes on 127.0.0.1:8655. Keys come from .env, the environment, or the team's vault. They are never printed.
set -euo pipefail
cd "$(dirname "$0")"
serve=(uv run -q uvicorn softyes.api:app --host 127.0.0.1 --port "${PORT:-8655}" "$@")
if [ -f .env ]; then
  set -a; . ./.env; set +a
fi
if [ -n "${JUNCTION_CALA_API_KEY:-}" ]; then
  exec "${serve[@]}"
fi
if command -v hsec >/dev/null; then
  exec hsec exec --only JUNCTION_CALA_API_KEY,JUNCTION_GEMINI_API_KEY,JUNCTION_OXYLABS_API_KEY,JUNCTION_SLUSH_MCP_TOKEN_JSON -- "${serve[@]}"
fi
echo "Set JUNCTION_CALA_API_KEY in .env (see .env.example)." >&2
exit 1
