# Tyler verification checklist audit (2026-10)

Audited against `origin/main` at `8f70cf43` (2026-10-07), then follow-up fixes on branch `cursor/verification-audit-b359`.

**Legend:** DONE = verified with tests, CI, or workflow inspection; PARTIAL = mostly shipped with gaps; NOT DONE = missing; BLOCKED = needs Tyler-only credentials or product decision.

| # | Item (summary) | Initial | Evidence | Final | Follow-up |
|---|----------------|---------|----------|-------|-----------|
| P1 | GHCR container images | NOT DONE | No publish workflow on main | PARTIAL | PR #776 — **BLOCKED:** run workflow or push `v*` tag; confirm `packages: write` |
| P2 | npm publish | NOT DONE | No workflow on main | PARTIAL | PR #776 — **BLOCKED:** add `NPM_TOKEN`, remove `private` on packages to publish |
| P3 | Vercel + default services | PARTIAL | `apps/pages/vercel.json`; Pages on GH Actions (`deploy-pages.yml` success on main) | PARTIAL | PR #776 doc — **BLOCKED:** link Vercel project, set `PAGES_*` vars per `deploy-pages.yml` |
| A1 | Host as relay + default capability bindings | NOT DONE | Gateway remains full Host API | NOT DONE | ADR-level; no relay-only product slice |
| A2 | Vaults scoped to users/orgs like GitHub repos | PARTIAL | Project tombs + `listDeviceVaults()` | PARTIAL | Not GitHub-org parity; device + project vaults only |
| A3 | Environments + prod hash reuse warning | PARTIAL | `vault.environments` module, tests | DONE | PR #776 — `notifyEnvironmentValueReuse()` + test |
| R1 | Smart password reset email config | DONE | `ai.password-reset` capability, `PasswordResetMailPanel`, `password-reset-mail.ts` | DONE | — |
| R2 | Auto reset from mailbox / per-item email | DONE | `resetEmailId` on account items, `ResetEmailField.tsx`, scan job | DONE | Requires login item type + capability |
| R3 | Settings under Capabilities, depends on password type | DONE | `runtime.ts` registers panel under `feature-password-reset` | DONE | — |
| E1 | Environments capability off by default, not minimal | DONE | `environments.test.ts`, `catalog-optional-vault.ts` | DONE | — |
| E2 | `.env.schema`, toggle envs, required notifications | DONE | `renderEnvSchema`, `notifyMissingEnvironmentValues` tests | DONE | — |
| U1 | Setup keyboard nav | DONE | `SetupConfiguration.test.tsx` (40 tests in setup suite) | DONE | — |
| U2 | Remove setup reset | DONE | No reset on `SetupScreen` | DONE | — |
| U3 | Remove sign-in "Continue as guest" (keep one flow) | PARTIAL | `SignInPanel.tsx` — only "Use without account"; guest not duplicated | PARTIAL | Unlock footer + front door Skip remain (**product rule** AGENTS.md) |
| U4 | Vault tree borders overflow when expanded | NOT DONE | No Playwright/visual proof this audit | NOT DONE | Needs repro + CSS fix |
| U5 | Remove Security › Formats | DONE | `page-tree.test.ts` — absent without capability | DONE | — |
| U6 | Remove Security › Age Keys | DONE | Not in default `page-tree` | DONE | — |
| U7 | Remove Security › Transport | DONE | Not in settings tree | DONE | — |
| U8 | Travel under Security / duress | DONE | `page-tree.ts` Travel beside Duress when `duress` snapshot | DONE | — |
| U9 | Remove Vaults › Sealed store from default tree | DONE | `page-tree.test.ts` | DONE | — |
| U10 | Settings via root context menu + back | DONE | `rail-context-menu.test.tsx`, `SESSION_SECTIONS` | DONE | — |
| U11 | Activity via root context menu + back | DONE | Same rail context menu tests | DONE | — |
| U12 | Support explainer + WebMCP prose removed | DONE | PR #774; `no-model.test.tsx`; lint hint captions | DONE | — |
| U13 | Reset device modal (design system) | DONE | `ResetBrowser.tsx`, danger panel tests | DONE | — |
| U14 | Danger: trash list, empty/restore/delete | DONE | `SettingsDangerPanel.tsx` | DONE | — |
| U15 | Setup "full" profile | DONE | `SetupConfiguration.tsx` `full` choice + `apply-configuration.ts` | DONE | — |
| S1 | Join-session durable vault sync (Syncthing-like) | NOT DONE | Live join exists; no post-join vault replica | NOT DONE | Large feature; relay peer model |
| S2 | Minimal slash-command typeahead | DONE | `CommandBar.test.tsx` | DONE | — |
| S3 | Remove identity status icon | DONE | `Statusline.tsx` — no identity glyph | DONE | — |
| S4 | Remove WebCrypto status icon | DONE | `Statusline.tsx` | DONE | — |
| S5 | Vault Share submenu | DONE | `vault-menu.ts` | DONE | — |
| S6 | Secret Share submenu (not "share once") | DONE | `secretShare` in `vault-menu.ts` | DONE | — |
| S7 | Default name "Secret" not "Login" on minimal | DONE | `ItemEditor` / `new-draft` tests | DONE | — |
| S8 | Secret single input control | DONE | Item editor tests | DONE | — |
| S9 | Shared icon on list items | DONE | `VaultRowDecorations.tsx` | DONE | — |
| H1 | Help: remove top/bottom explainers | DONE | #774 + support tests | DONE | — |
| H2 | Walkthrough missing control → notification | DONE | `session.ts` `notifyFailure(GUIDE_ERROR_TEXT[...])` | DONE | — |
| H3 | Design system lint for explainers / in-panel errors | DONE | `pnpm lint:design`, `design-lint.mjs`, #774 | DONE | — |
| H4 | Programmatic walkthroughs per installed features | DONE | `verify:tutorials` gate in CI; tutorial registry | DONE | Full gate not re-run in this audit |
| H5 | Feature bundles ship walkthroughs | DONE | ADR 0163 + `feature-goals.ts` | DONE | — |
| H6 | Ask → Search when AI disabled | DONE | `SupportComposer.tsx`, `support.test.tsx` | DONE | — |
| X1 | Incremental commits + stacked PRs | N/A | Process | DONE | PR #776 (2 commits); most UI already on main |

## Commands run (audit evidence)

```bash
cd apps/pages && pnpm exec vitest run \
  src/screens/setup/SetupConfiguration.test.tsx \
  src/components/context-menu/rail-context-menu.test.tsx \
  src/tutorial/ui/support.test.tsx \
  src/components/CommandBar.test.tsx \
  src/sections/settings/page-tree.test.ts \
  src/modules/vault.environments/environments.test.ts
# 6 files, 69 tests passed (2026-10-07)
```

```bash
gh run list --workflow=deploy-pages.yml --limit 3
# success on main for #774 and prior commits
```

## Grok Build

`grok 1.0.46` is installed and `XAI_API_KEY` is set, but headless `grok -p` returns **Not signed in** (CLI requires `grok login --device-code` or browser login). Implementation on this branch was done directly after that failure.
