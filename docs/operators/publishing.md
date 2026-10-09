# Publishing OpenSesame artifacts

## GitHub Container Registry (host image)

Workflow: `.github/workflows/publish-containers.yml`

- Triggers on `workflow_dispatch` or version tags `v*`.
- Builds `ops/compose/Dockerfile` (the `opensesame` CLI / host roles).
- Pushes to `ghcr.io/<owner>/<repo>` using `GITHUB_TOKEN` (`packages: write`).

Optional repository variable: set `OPENSESAME_FEATURES` in the workflow dispatch
input when you need optional cargo features (for example `bitwarden-compat`).

## npm packages

Workflow: `.github/workflows/publish-npm.yml`

1. Create an npm Automation token with publish rights to `@opensesame/*`.
2. Add it as repository secret `NPM_TOKEN`.
3. Run the workflow and pass a comma-separated `packages` input.

Packages remain private in the monorepo until you remove `"private": true` from
their `package.json` and set `"publishConfig": { "access": "public" }` where
appropriate.

## Vercel (Pages + default service URLs)

Static Pages already deploy on every push to `main` via
`.github/workflows/deploy-pages.yml` (GitHub Pages).

For Vercel:

1. Link the repository in the Vercel dashboard (root directory `apps/pages`,
   build settings in `apps/pages/vercel.json`).
2. Set **Actions variables** on GitHub (see `deploy-pages.yml` header):
   `PAGES_IDENTITY_API`, `PAGES_HOST_API`, `PAGES_DAEMON_API` — these stamp
   `os-runtime-config.json` so the PWA boots against your hosted Identity and
   Host APIs.
3. Optional: add a Vercel Git integration deploy; the checked-in `vercel.json`
   runs the same turbo build as CI.

Hosted Identity and Host themselves are the GHCR image (`opensesame host run`,
control-plane via `pnpm --filter @opensesame/control-plane start`) plus
operator compose under `ops/compose/`.
