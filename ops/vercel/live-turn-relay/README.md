# Live session public TURN relay (Vercel)

Optional TURN REST fallback for Pages live sessions when direct WebRTC cannot
complete. ADR 0150 still applies: nothing is baked into the static origin until
an operator enables it in Settings or the build stamps
`VITE_LIVE_PUBLIC_RELAY_URL`.

## Provision (manual — no paid resources are created by the agent)

1. Create a Vercel project named `opensesame-live-turn-relay` pointing at
   `ops/vercel/live-turn-relay` in this repository (or deploy the folder alone).
2. Set environment secrets:
   - `LIVE_TURN_REST_SECRET` — shared secret for TURN REST credential minting
     (must match what operators type into `settings/live/transport.json`).
   - `TURN_REALM` — e.g. `opensesame.live`
   - `TURN_URLS` — comma-separated `turn:` / `turns:` URLs of your TURN server
     (Vercel hosts the REST API only; run coturn/pion elsewhere or use a managed
     TURN provider).
3. Deploy. Note the HTTPS origin (e.g. `https://opensesame-live-turn-relay.vercel.app`).
4. In Pages production builds, set `VITE_LIVE_PUBLIC_RELAY_URL` to that origin.
   The PWA suggests it in Settings › Live sessions › Routes and in setup custom
   config; operators still toggle relay and paste the REST secret locally.
5. Smoke-test with `pnpm --filter @opensesame/pages verify:live-join` relay walks
   after naming the deployed TURN in Routes.

`api/turn-credentials.js` is a stub that documents the REST contract; wire it to
your TURN server's REST API before production use.
