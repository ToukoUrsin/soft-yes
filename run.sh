#!/usr/bin/env bash
# Start Soft Yes on 127.0.0.1:8655. Secrets come from the vault and are never printed.
set -euo pipefail
cd "$(dirname "$0")"
exec hsec exec --only JUNCTION_CALA_API_KEY,JUNCTION_GEMINI_API_KEY,JUNCTION_OXYLABS_API_KEY,JUNCTION_SLUSH_MCP_TOKEN_JSON -- \
  uv run -q uvicorn softyes.api:app --host 127.0.0.1 --port "${PORT:-8655}" "$@"
