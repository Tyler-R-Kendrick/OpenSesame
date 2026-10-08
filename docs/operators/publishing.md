# Publishing OpenSesame artifacts

## GitHub Container Registry (relay-only image)

Workflow: `.github/workflows/publish-containers.yml`

- Triggers on `workflow_dispatch` or version tags `v*`.
- Builds `ops/compose/Dockerfile` — the `opensesame` CLI with default
  `CMD ["relay", "run"]` (optional vault-relay peer, ADR 0181). There is no
  Host, Identity, or daemon API image.
- Pushes to `ghcr.io/<owner>/<repo>` using `GITHUB_TOKEN` (`packages: write`).

Optional repository variable: set `OPENSESAME_FEATURES` in the workflow dispatch
input when you need optional cargo features (for example `bitwarden-compat`).

## npm packages

Workflow: `.github/workflows/publish-npm.yml`

There is **no** npm package for the deleted Identity API, Identity worker, Host
TS client, or Identity database layer. Those workspace paths were removed on
2026-10-08 (`docs/audit/2026-10-static-pwa-inventory.md`); do not publish
`@opensesame/control-plane`, `@opensesame/identity-worker`, `@opensesame/api-client`,
`@opensesame/database`, `@opensesame/device-auth`, or `@opensesame/webhooks`.

1. Create an npm Automation token with publish rights to `@opensesame/*`.
2. Add it as repository secret `NPM_TOKEN`.
3. Run the workflow and pass a comma-separated `packages` input (client libraries
   only, for example `@opensesame/os-domain`).

Packages remain private in the monorepo until you remove `"private": true` from
their `package.json` and set `"publishConfig": { "access": "public" }` where
appropriate.

## Vercel (static Pages only)

Static Pages already deploy on every push to `main` via
`.github/workflows/deploy-pages.yml` (GitHub Pages).

`apps/pages` is a **purely static** export (ADR 0090). There is no default
Identity, Host, or daemon service for the PWA. Sessions are browser-hosted
WebRTC; a relay peer (ADR 0181) is optional and never required for deploy.

For Vercel:

1. Link the repository (root directory `apps/pages`, settings in
   `apps/pages/vercel.json`).
2. Set **no** required environment variables. Do **not** stamp retired
   backend API env vars (see ADR 0090 and the inventory audit).
3. Deploy must serve `dist/` only — **no** Vercel serverless functions under
   `api/`.
4. Optional: Git integration; the checked-in `vercel.json` runs the same turbo
   build as CI.

Operator notes: [`docs/audit/2026-10-p3-vercel-default-services.md`](../audit/2026-10-p3-vercel-default-services.md).
The GHCR image and `ops/compose/docker-compose.yml` relay service are optional
operator peers for vault relay sync; they are not Pages backends.