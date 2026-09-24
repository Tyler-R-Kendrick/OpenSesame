# Agent prompt — SPA multi-forge vault backup (production one-shot)

**Audience:** an LLM coding agent (and parallel subagent swarm) working in the
OpenSesame monorepo. This file is the only required product brief. Do not ask
the human to restate prior chat. Do not invent Host/gateway dependencies for
Pages backup.

**Outcome:** GitLab, Bitbucket, Codeberg, Cursor Origin, generic `git`, and
GitHub (App path) all work as **configurable encrypted vault backup backends**
in the Pages SPA/PWA, with configure → enable → manual sync → mutation/webhook
observer sync, tests, and merge-gate validation — **with zero Host involvement
in `apps/pages`**.

---

## 0. Adversarial critique of the prior conversation (treat as debt, not gospel)

A previous agent session claimed a production-ready SPA forge-backup path. Treat
those claims as **untrusted**. The tree likely contains a partial implementation;
your job is to **finish, correct, and prove** it — not to rubber-stamp it.

### Hard failures / design lies to assume until disproven

1. **Cursor Origin Contents URL is invented.** Catalog only documents
   `token_url` = `https://api.cursor.com/v1/origin/app/installations/access_tokens`
   and verify `GET /v1/origin/rate_limit`. A guessed
   `/v1/origin/repos/{owner}/{repo}/contents/{path}` must be validated against
   current Cursor Origin docs (`https://cursor.com/docs/api/origin`) or replaced
   with a documented Git-HTTPS push path. Shipping a fabricated REST shape is a
   production blocker.

2. **CORS was the real constraint; “local-first” was papered over.** Browser
   cannot call `api.github.com` / `gitlab.com` / `api.bitbucket.org` /
   `codeberg.org` / `api.cursor.com` directly. Any write path that does not go
   through `apps/connect-backend` (or the Vite `github-app-relay` plugin on
   loopback) is dead in production GitHub Pages.

3. **GitHub App vs forge token paths were conflated.** GitHub App backup uses
   PEM → attenuated installation token → Contents PUT. Forge remotes use vault-
   sealed HTTPS token/basic on a local git remote. Mixing credentials or
   requiring `installationId` for `git_remote` targets is a bug.

4. **`github-history.ts` still speaks Host.** Listing/creating GitHub repos via
   `hostFetch` violates ADR 0128 for Pages. Forge UX that still depends on Host
   repo create will falsely look “configured” then fail offline.

5. **SSH auth modes cannot backup from the SPA.** `ssh_key` / `ssh_agent` remotes
   must refuse sync with a clear StatusMark path, not silently no-op or throw
   unexplained errors. Prior code often ignored this.

6. **Single-target storage was upgraded mid-stream to multi-target.** Migrations
   from `opensesame.backup.target` → `opensesame.backup.targets` must be tested.
   Race: two providers syncing concurrently without serialization can interleave
   pending counters / lastError.

7. **Observer is easy to get wrong.** Vault `subscribe` firing on every snapshot
   (including lock/status) can storm sync. Webhook pending queues in serverless
   connect-backend are **best-effort memory** — do not claim durable webhook
   delivery on Vercel cold starts without durable storage; document residual risk
   and still implement poll + local event bus for configure/enable/vault.

8. **Design-system landmines.** Word-verb buttons, status text pills, explainer
   captions, and the word “Host” in Pages copy/comments/identifiers fail
   `pnpm lint:design` and ADR 0128. Icon keys + `StatusMark` only.

9. **“Tests pass” ≠ production.** Seam-stubbed sync tests that never hit
   `git-backup-put.mjs` request shaping leave Bitbucket form encoding, GitLab
   create-vs-update, and Origin auth headers unproven. Connect-backend node:test
   with mocked `fetchImpl` is mandatory per forge.

10. **Optional gateway mirror in `useGitConnectForm` reintroduces Host coupling.**
    Calling `createConnection` “best effort” after local save can surface
    Host/Identity errors to the user or leave dual connection IDs. Prefer
    **local remote as the sole authority** for SPA backup; delete or hard-gate
    gateway mirroring behind an explicit non-Pages surface.

### What must remain true (product contract)

- Pages is a static PWA (ADR 0090, ADR 0128): empty device opens without backend.
- Vault backup payload is **ciphertext only** (`opensesame-offline-backup` /
  sealed header+body). Never upload plaintext. Never wrap with deployment seal.
- Backup enable/disable is local state; sync is client-initiated via Connect
  relay.
- GitHub keeps App Manifest + local PEM + `/api/github-app/put-contents`.
- GitLab / Bitbucket / Codeberg / Origin / generic `git` use GitConnectForm +
  sealed HTTPS credentials + `/api/git-backup/put`.
- Module size ≤ 400 lines; `pnpm lint:anti-slop` clean; no unjustified `as`.

---

## 1. Repository facts the swarm must load (read before editing)

| Path | Role |
|------|------|
| `AGENTS.md`, `DESIGN.md`, `docs/design/controls.md` | Merge gates + UI law |
| `docs/adr/0090-static-frontend-complete-without-backend.md` | No backend gate |
| `docs/adr/0128-pages-without-host.md` | Zero Host in `apps/pages` |
| `docs/adr/0127-*` (Connect relay) | Callback / proxy companion |
| `packages/app-core/src/lib/vault/offline-backup.ts` | Ciphertext envelope |
| `packages/app-core/src/lib/git-remote-local.ts` | Local remotes + sealed secrets |
| `packages/app-core/src/lib/git-auth-modes.ts` | Auth modes / URL sanitize |
| `apps/pages/src/sections/connections/GitConnectForm.tsx` + `useGitConnectForm.ts` | Configure UX |
| `packages/app-core/src/lib/backup.ts`, `backup-target-local.ts` | Target CRUD API |
| `packages/app-core/src/lib/vault-backup-sync.ts`, `vault-backup-observer.ts` | Sync + events |
| `packages/app-core/src/lib/git-backup-forges.ts` | Forge id / URL parse |
| `apps/connect-backend/src/github-app.mjs`, `github-app-contents.mjs` | App JWT + Contents |
| `apps/connect-backend/src/git-backup-put.mjs` | Forge put proxy |
| `apps/pages/scripts/github-app-relay-plugin.mjs` | Loopback relay |
| `crates/connection-broker/src/catalog.json` | Provider authorities/scopes |
| `packages/app-core/src/lib/embedded-catalog.ts`, `vercel-connect-catalog.ts` | Pages catalog |

**Toolchain:** Node ≥ 22, pnpm 9.15 via Corepack, Vitest for Pages, `node --test`
for connect-backend. No `sudo`.

**Validation commands (must all pass on touched surfaces):**

```bash
pnpm --filter @opensesame/connect-backend test
pnpm --filter @opensesame/pages exec vitest run \
  src/lib/backup.test.ts \
  src/lib/backup-target-local.ts \
  src/lib/git-backup-forges.test.ts \
  src/lib/vault-backup-sync.test.ts \
  src/lib/vault-backup-observer.ts \
  src/sections/connections/GitConnectForm.test.tsx \
  src/sections/connections/BackupSyncControls.test.tsx \
  src/sections/connections/BackupEnableSwitch.tsx \
  src/sections/connections/SettingsPage.backup-switch.test.tsx \
  src/sections/settings/FeatureBindingsPanel.test.tsx
pnpm lint:anti-slop:files <every touched .ts/.tsx>
pnpm lint:design
# After Pages UI touch affecting boot/settings/connections:
VITE_BASE=/OpenSesame/ pnpm exec turbo run build --filter=@opensesame/pages
PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium pnpm --filter @opensesame/pages verify:static
```

Add focused tests you introduce to the vitest list. Do not lower quality baselines.

---

## 2. Non-negotiable architecture (implement this shape)

```
┌──────────────── apps/pages (SPA) ─────────────────┐
│  GitConnectForm / Github App UI                   │
│       ↓                                           │
│  LocalBackupTarget[]  (per providerId)            │
│       ↓  configure | enable | manual | vault | webhook poll
│  vault-backup-observer → syncVaultBackup          │
│       ↓                                           │
│  offline-backup envelope (ciphertext)             │
│       ↓                                           │
│  github App? → POST /api/github-app/put-contents  │
│  forge?     → POST /api/git-backup/put            │
└───────────────────────┬───────────────────────────┘
                        │ same-origin Vite plugin OR
                        │ VITE_CONNECT_CALLBACK_BASE
                        ▼
┌──────────── apps/connect-backend ─────────────────┐
│  Mint/attenuate tokens server-side; proxy forge   │
│  APIs; never persist PEM/token after response     │
└───────────────────────────────────────────────────┘
```

**LocalBackupTarget kinds**

- `github_app`: requires `installationId`, `owner`, `repo`; credentials = local
  App id + PEM from vault.
- `git_remote`: requires `connectionId` (local git remote id), `owner`, `repo`,
  `providerId` ∈ {`gitlab`,`bitbucket`,`codeberg`,`origin`,`git`}; credentials =
  vault secret on that remote (`https_token` or `https_basic` only).

**Sync refusal cases (must set `status: "error"` + `lastError`, StatusMark):**

- Backup disabled → no network.
- Vault locked when forge token required.
- SSH-only remote.
- Missing App PEM (GitHub).
- Relay unconfigured (`githubAppRelayBase() === ""` on non-loopback without
  Connect base).
- Forge API non-2xx (surface forge message, never stack).

---

## 3. Subagent swarm (parallel one-shot)

Launch **all swarms concurrently**. Each swarm owns a disjoint file set where
possible. Integration swarm lands last only for cross-file glue conflicts;
prefer landing independent PRs/worktrees if the harness supports it — otherwise
merge carefully without rewriting another swarm’s contracts.

Do **not** use phases, milestones, or “week 1/2”. Each swarm’s acceptance tests
are the definition of done.

### Swarm A — Forge API truth + Connect relay (`connect-backend`)

**Owner files:** `apps/connect-backend/src/git-backup-put.mjs`,
`apps/connect-backend/src/github-app-contents.mjs` (if touching shared helpers),
`apps/connect-backend/src/server.mjs`, `apps/pages/scripts/github-app-relay-plugin.mjs`,
`apps/connect-backend/api/git-backup/**`, `apps/connect-backend/test/*.mjs`.

**Atomic problems (solve all):**

1. Prove or replace Origin put endpoint against live docs; encode the chosen
   contract in tests with mocked `fetchImpl` (URL, method, auth header).
2. GitLab: GET file → POST create / PUT update; `PRIVATE-TOKEN`; commit id in
   response.
3. Bitbucket: POST `/2.0/repositories/{workspace}/{repo_slug}/src` with form
   fields; Basic `username:token` (default username `x-token-auth` when absent).
4. Codeberg: Gitea Contents PUT with `Authorization: token …`; sha on update.
5. Reject unknown forge, missing fields, disallowed CORS origin.
6. Wire `POST /api/git-backup/put` + OPTIONS on Node server, Vite plugin, and
   Vercel serverless handler.
7. Keep GitHub App put-contents attenuated (`repositories` + `contents:write`).
8. Webhook pending queue: enqueue + drain tests; document in-module that memory
   is non-durable on serverless.

**Acceptance:** `pnpm --filter @opensesame/connect-backend test` green; at least
one node:test case per forge dialect including Origin.

**Forbidden:** returning tokens to the browser; logging PEM/token; calling Host.

---

### Swarm B — Local target model + sync engine (`apps/pages/src/lib`)

**Owner files:** `backup-target-local.ts`, `backup.ts`, `vault-backup-sync.ts`,
`vault-backup-observer.ts`, `git-backup-forges.ts`, their `*.test.ts`.

**Atomic problems:**

1. Multi-target store keyed by `providerId`; legacy single-key migration;
   memory fallback when `localStorage` missing (Vitest/node).
2. `putBackupTarget` / `getBackupStatus(providerId?)` /
   `setBackupTargetEnabled(enabled, providerId?)` / `resyncBackup(providerId?)`
   with seams for tests — **no `hostFetch`**.
3. `ownerRepoFromGitRemote` covers gitlab/bitbucket/codeberg/origin/generic HTTPS
   and scp-ish SSH forms for parsing only.
4. `syncVaultBackup(providerId?)` pushes ciphertext for one or all enabled
   targets; GitHub App vs `git_remote` credential resolution separated.
5. Forge credentials read only from unlocked vault secret JSON
   (`token` / `password`); never from remote URL userinfo.
6. Observer: `configured` | `enabled` | `manual` | `vault` | `webhook`; debounce
   / single-flight; vault fingerprint ignores pure UI noise; start on first
   enabled target.
7. Anti-slop: no unjustified `as`; prefer `satisfies`; ≤400 lines/file (split if
   needed).

**Acceptance:** Vitest suites for forges, target CRUD, sync success/fail/disabled,
observer publish. `pnpm lint:anti-slop:files` on owned files.

**Forbidden:** importing `identity.js` `hostFetch`; ADR 0128 Host vocabulary in
identifiers/comments/copy.

---

### Swarm C — Configure UX (`GitConnectForm` + Settings routing)

**Owner files:** `ConnectForm.tsx`, `useGitConnectForm.ts`, `GitConnectForm*.tsx`,
`GitConnectFields.tsx`, `SettingsPage.tsx`, `SettingsPage*.test.tsx`,
`GitConnectForm.test.tsx`, connector catalog marks if needed.

**Atomic problems:**

1. `isGitBackupProvider(id)` routes `gitlab|bitbucket|codeberg|origin|git` to
   `GitConnectForm` — **not** OAuth PAT theater as the primary backup configure
   path.
2. Saving a remote: `rememberLocalGitRemote` → `bindHistoryConnection` →
   `putBackupTarget({ kind:"git_remote", … enabled:true })` → publish sync.
3. **Do not require Host** for success flash; optional gateway mirror must not
   fail the UX if unreachable (prefer remove Host create entirely for these
   providers).
4. Settings: “Add another” / Connect panels treat forge providers like `git`.
5. Per-provider `BackupEnableSwitch` + `BackupSyncControls` visible when a target
   exists (GitHub App summary retains its controls; forges get equivalent panel
   without verb buttons).
6. Design lint clean: icon keys, StatusMark, no Host word, no explainer captions.

**Acceptance:** GitConnectForm test binds gitlab remote → `putBackupTarget`
called with owner/repo; Settings backup-switch tests; `pnpm lint:design` on
touched UI.

---

### Swarm D — GitHub App path integrity (Pages + relay)

**Owner files:** `github-app-local.ts`, `github-app-claim.ts`,
`github-app-presence.ts`, `GithubBackupRepo.tsx`, `GithubAppConfigSummary.tsx`,
`backup.ts` GitHub-only helpers, related tests. May read but not regress Swarm A
relay contracts.

**Atomic problems:**

1. Binding a backup repo still writes `kind:"github_app"` local target and
   triggers configure sync when enabled.
2. Eliminate Host from Pages GitHub repo list/create used by backup bind
   **or** make bind work with typed `owner/repo` + local installs only (no
   `github-history.ts` Host calls on the backup happy path).
3. Presence/status uses `getBackupStatus("github")`.
4. Enable/disable/manual sync still work for GitHub App targets.

**Acceptance:** GithubBackupRepo / presence / backup tests green without
`hostFetch` on the backup configure/sync path.

---

### Swarm E — Adversarial test + validation gate

**Owner files:** new/extended tests only; may patch obvious bugs found in A–D
with minimal diffs. Runs the validation command block in §1.

**Atomic problems:**

1. Table-driven forge put tests: one case each for gitlab, bitbucket, codeberg,
   origin (assert URL + auth header + body shape).
2. Sync refuses SSH remotes; refuses locked vault for forge; disabled no-ops.
3. Multi-provider: enable gitlab + codeberg; `syncVaultBackup()` invokes both
   put seams.
4. Observer: publish `enabled` → sync; webhook pending drain → `webhook` reason.
5. Regression: empty `selections: []` history toggle still sticks
   (`history-backups` / capabilities).
6. Run lint:design, lint:anti-slop on union of touched files, connect-backend
   test, pages vitest set, and `verify:static` after UI changes.
7. File a short residual-risk note in the PR body (not a new ADR unless Origin
   API choice is consequential): serverless webhook memory, SSH unsupported,
   Origin API doc citation.

**Acceptance:** All commands in §1 green; PR-ready summary of risks.

---

## 4. Swarm coordination rules

- **Contracts are stable APIs**, not chat. If Swarm B changes
  `PutBackupTargetInput`, update the type in `backup.ts` and fix call sites; do
  not leave dual shapes.
- **Disjoint writes preferred.** If two swarms must touch `SettingsPage.tsx`,
  Swarm C owns structure; Swarm D only GitHub-specific blocks.
- **No “follow-up phase”.** Anything listed under atomic problems is in scope
  now. Out of scope: Host gateway ADR 0039 actor changes, Actions secret sync,
  isomorphic-git WASM push, payment/OIDC work.
- **Subagent model:** use explore/investigator agents for API doc verification
  (Origin); implementation agents for A–D; a reviewer agent for E’s adversarial
  pass (`cavecrew-reviewer` / security-review only if secrets handling changes
  warrant it).
- **Stop condition:** Swarm E’s validation block is green and the four forges +
  GitHub App each have a configure→enable→sync proof in automated tests.

---

## 5. Copy-paste orchestrator brief (root agent)

```text
You are implementing SPA multi-forge encrypted vault backup for OpenSesame
Pages per docs/<this-file>. ADR 0128: no Host in apps/pages. Use Connect relay
for all forge/GitHub writes. Launch swarms A–E in parallel with the ownership
and acceptance criteria in §3. Critically distrust any existing
git-backup-put Origin URL and any hostFetch on the backup path. Deliver green
connect-backend tests, Pages vitest set, lint:anti-slop, lint:design, and
verify:static. Do not phase the work. Do not ask the human for prior chat
context — this document is sufficient.
```

---

## 6. Definition of done (checklist for the root agent)

- [ ] GitLab, Bitbucket, Codeberg, Origin, and `git` configure via GitConnectForm
      and create `git_remote` backup targets without Host.
- [ ] GitHub App backup configure/sync remains local + relay Contents put.
- [ ] Enable, disable, manual sync, configure sync, vault-mutation sync, and
      webhook-nudge sync are covered by tests.
- [ ] Ciphertext-only offline-backup envelope; no plaintext; no deployment seal.
- [ ] SSH remotes cannot sync; HTTPS token/basic can.
- [ ] Origin API path cited from docs or explicitly replaced with a documented
      alternative.
- [ ] Zero `Host` / `hostFetch` on Pages backup happy path.
- [ ] Design + anti-slop + connect-backend + vitest + verify:static green.
