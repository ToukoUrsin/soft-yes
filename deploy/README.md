# Public address

https://soft-yes.fly.dev is a small Caddy machine on Fly (`deploy/fly/`) that forwards to the server on the
team's box (`./run.sh`, port 8655) through the box's Tailscale funnel path `/softyes`.

- Re-deploy the front door: `cd deploy/fly && hsec exec --only FLY_API_TOKEN -- flyctl deploy --ha=false --now`
- The funnel path: `sudo tailscale funnel --bg --https=8443 --set-path /softyes http://127.0.0.1:8655`
  (use `funnel`, not `serve`: `serve` turns the public funnel off for every other path on that port).
- Take it down: `flyctl apps destroy soft-yes`, and `sudo tailscale funnel --https=8443 --set-path /softyes off`.
