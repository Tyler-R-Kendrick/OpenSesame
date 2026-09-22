# Baseline (recorded before any capability-composition change)

- Date: 2026-09-22
- Checkout: `424bc48cfb74e3c69f4f1f6b44cbe5b2fb979716` (`main` + PR #452), branch
  `claude/new-session-9wpwbh`. Working tree clean apart from two untracked
  drizzle artefacts written by the session-start hook
  (`packages/database/drizzle/0029_*`), which are not part of this change.
- Toolchain observed: Node v22.22.2, pnpm 9.15.0, Vite 6.4.3,
  vite-plugin-pwa 1.0.3, React 19.2.8, React Router 8.3.0, TypeScript 5.8.3,
  Vitest 4.1.10, Playwright 1.55.1, Chromium `/opt/pw-browsers/chromium`.
- Environment quirk: the inherited `NODE_OPTIONS` contains `--import tsx`,
  which this Node refuses. Every recorded command ran with
  `NODE_OPTIONS=--max-old-space-size=8192`.

## Baseline production build

Command (cwd repo root):

```
VITE_BASE=/OpenSesame/ pnpm exec turbo run build --filter=@opensesame/pages
```

Exit 0 in 34.5 s wall clock. `pnpm --filter @opensesame/pages build` alone
exits 2 on a fresh checkout because `@opensesame/auth-upstream/browser`
resolves to `dist/`, which the Turbo graph builds first.

| Measurement | Value |
|---|---|
| `dist/` size | 3.6 MB |
| assets in `dist/assets/` | 78 |
| entry chunk `assets/main-CzUHDisx.js` | 1,189,653 bytes |
| `sw.js` | 8,901 bytes |
| scripts referenced by `index.html` | `main-*.js`, `modulepreload-polyfill-*.js` |
| client-core Wasm | not emitted in this environment |

The snapshot of that `dist/` is kept outside the repository for the
before/after comparison in `implementation-summary.md`.

## Observed source facts (not inferred)

- `apps/pages/src/main.tsx` statically imports `./App.js`; `App.tsx`
  statically imports `lib/ambient-auth/boot`, `lib/connector-directory`,
  `lib/vercel-connect-session`, `lib/federation`, `screens/BrokerAuthorize`,
  `screens/DropClaimScreen`, `tutorial/session`, `tutorial/ui/SupportLauncher`
  and `webmcp/lifecycle`. The 1.19 MB entry chunk is the consequence.
- `main.tsx` hydrates `DIRECTORY_KEY` (connector directory) and
  `MODEL_PROVIDER_KEY` (AI model provider) before first paint and calls
  `registerSW({ immediate: true })` unconditionally.
- `screens/SetupScreen.tsx` declares four statically imported tabs
  (connectors, ai, identity, mfa). ADR 0114 describes six.
- `src/sw.ts` adds only `index.html` from `__WB_MANIFEST` at install; the
  claim in `App.tsx` that the shell chunk is precached is stale. Its
  `activate` handler deletes every cache whose name differs from
  `opensesame-pages-v3`, origin-wide. It registers `push` and
  `notificationclick` handlers unconditionally.
- `lib/setup.ts` `setup.v1` records `ways`, `service`, `joined`, `skipped`:
  completion metadata, not per-capability consent.
- `packages/capability-registry` has no product-capability dimension; its ids
  are operations with surface mappings.
- No `@openfeature/*` dependency existed in the lockfile.
