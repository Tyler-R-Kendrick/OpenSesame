# Publishing OpenSesame artifacts

## GitHub Container Registry (host image)

Workflow: `.github/workflows/publish-containers.yml`

- Manual publication accepts only `refs/heads/main`. Other dispatch refs are skipped.
- Version tags `v*` must match the workspace version and name a commit already
  on main, using the same tag check as the release kit.
- Source verification runs with read-only permissions; publication checks out
  its verified immutable SHA before logging into GHCR.
- Builds `ops/compose/Dockerfile` (the `opensesame` CLI / host roles).
- Pushes to `ghcr.io/<owner>/<repo>` using `GITHUB_TOKEN` (`packages: write`).

Set the `features` workflow dispatch input when you need optional cargo features (for example `bitwarden-compat`).

### External publication boundary

These checks stop accidental publication of an unapproved selected ref through
this workflow. They do **not** stop a collaborator from pushing an edited
workflow that grants itself `packages: write`. The release-tag ruleset alone
also cannot constrain GHCR writes from branch workflows.

For that stronger boundary, official package writes must use credentials that
branch workflows cannot obtain: remove this repository's Actions write access
to the official package and use a separate publisher, or an environment-scoped
publishing credential with enforced branch/tag policies and no repository-token
write route. Configure and verify those GitHub controls before treating the
collaborator threat as resolved. An environment declaration in this YAML alone
is insufficient. No such live configuration is established by this patch.

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
