# Public address

https://soft-yes.fly.dev runs the app itself on Fly (`deploy/fly/`): the Python server, the built page and a snapshot of the Cala cache. Its own cache lives on a volume, and the snapshot is merged into it on start, so nothing it has read is lost on a deploy.

- Keys are Fly secrets: `JUNCTION_CALA_API_KEY`, `JUNCTION_GEMINI_API_KEY`, `JUNCTION_OXYLABS_API_KEY`, `JUNCTION_SLUSH_MCP_TOKEN_JSON`.
- Publish: `cd web && npm run build && cd .. && ./deploy/publish.sh` (needs `FLY_API_TOKEN`).
- `deploy/refresh_runs.py` walks the stored runs again after a change to the walk, so old links show the new result.
- Take it down: `flyctl apps destroy soft-yes`.
