# eve Deepsec agent (Blackbox GLM 5.2)

Filesystem-first [eve](https://eve.dev/) agent that runs OpenSesame's Deepsec
**pattern scan** and triages hits. The model is `zai/glm-5.2` pinned to
**Blackbox** so it can use the [eve GLM 5.2 promo](https://vercel.com/changelog/glm-5-2-free-for-eve-agents-through-august-27-via-blackbox-on-ai-gateway)
(through 2026-08-27).

This app is **not** in the pnpm workspace. eve wants Node 24 and Zod 4; the rest
of OpenSesame stays on Node ≥22 / Zod 3.

## Why this exists

`deepsec process` (Pi) is **not** an eve agent. Gateway routed those calls to
paid hosts even though the catalog showed `$0/M` for GLM. This agent is eve +
`providerOptions.gateway.only: ["blackbox"]`. It never invokes `deepsec process`.

## Run

Needs Node 24+ and a Vercel AI Gateway credential (`AI_GATEWAY_API_KEY` or a
linked project / `VERCEL_OIDC_TOKEN`).

```bash
pnpm --dir .deepsec install
cd apps/eve-deepsec && pnpm install --ignore-workspace
pnpm eve:deepsec
```

Then ask it to scan and triage, e.g. `Scan gateway auth-bypass candidates`.

## Layout

- `agent/agent.ts` — GLM 5.2 + Blackbox pin
- `agent/tools/deepsec_*.ts` — scan / status / export / candidates
- `agent/tools/repo_*.ts` — read/grep the OpenSesame tree
- `agent/skills/triage.md` — investigation procedure
