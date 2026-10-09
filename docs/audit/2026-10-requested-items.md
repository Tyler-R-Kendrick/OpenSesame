# Tyler verification checklist audit (2026-10)

Audited against `origin/main` at `8f70cf43` (2026-10-07), then follow-up fixes on branch `cursor/verification-audit-b359`.

**Legend:** DONE = verified with tests, CI, or workflow inspection; PARTIAL = mostly shipped with gaps; NOT DONE = missing; BLOCKED = needs Tyler-only credentials or product decision.

| # | Item (summary) | Initial | Evidence | Final | Follow-up |
|---|----------------|---------|----------|-------|-----------|
| P1 | GHCR container images | NOT DONE | No publish workflow on main | PARTIAL | Publish workflow in #776 ([dry-run log](2026-10-publishing-dry-run.md)). Pull requests build `ops/compose/Dockerfile` in [`.github/workflows/container-build-pr.yml`](../../.github/workflows/container-build-pr.yml) with `push: false` and `contents: read` only. |
| P2 | npm publish | NOT DONE | No workflow on main | PARTIAL | Workflow in #776; `npm publish --dry-run` OK for `@opensesame/os-domain` — [dry-run log](2026-10-publishing-dry-run.md) |
| P3 | Vercel static Pages (no default services) | PARTIAL | Wrong doc asked for Host/Identity as default backends | DONE | Tyler 2026-10-08: no default services. Static-only — [P3](2026-10-p3-vercel-default-services.md), [inventory](2026-10-static-pwa-inventory.md). Host/Identity/daemon must not be required for `apps/pages`. |
| A1 | Host as relay + default capability bindings | NOT DONE | Gateway remains full Host API | DONE | `GET /health/relay` advertises `profile: relay`, `bindings: vault_relay`, `durable: true`. A non-`vault_relay` document still refuses startup. `OPENSESAME_RELAY_TRANSPORT=mtls_required` admits certificated peers through the relay binding set (`vault_relay::mtls_tests::uncertified_peer_is_refused_and_certificated_peer_syncs`, [local operator notes](../operators/local.md)). |
| A2 | Vaults scoped to users/orgs like GitHub repos | PARTIAL | Project tombs + `listDeviceVaults()` | DONE | Org-vault API and `OrgVaultDirectoryPanel` are shipped. With `OPENSESAME_VAULT_RELAY_ISSUER` + registration JWKS, roles come from `vault-relay-registration+jwt` only (`registration_tests::registration_jwt_governs_publish_and_refuses_forged_role_headers`). Without issuer, header + slot-key admission unchanged. Visual evidence: [org vault gallery](../evidence/2026-10-org-vault-address/README.md). |
| A3 | Environments + prod hash reuse warning | PARTIAL | `vault.environments` module, tests | DONE | PR #776 — `notifyEnvironmentValueReuse()` + test |
| R1 | Smart password reset email config | DONE | `ai.password-reset` capability, `PasswordResetMailPanel`, `password-reset-mail.ts` | DONE | — |
| R2 | Auto reset from mailbox / per-item email | DONE | `resetEmailId` on account items, `ResetEmailField.tsx`, scan job | DONE | Requires login item type + capability |
| R3 | Settings under Capabilities, depends on password type | DONE | `runtime.ts` registers panel under `feature-password-reset` | DONE | — |
| E1 | Environments capability off by default, not minimal | DONE | `environments.test.ts`, `catalog-optional-vault.ts` | DONE | — |
| E2 | `.env.schema`, toggle envs, required notifications | DONE | `renderEnvSchema`, `notifyMissingEnvironmentValues` tests | DONE | — |
| U1 | Setup keyboard nav | DONE | `SetupConfiguration.test.tsx` (40 tests in setup suite) | DONE | — |
| U2 | Remove setup reset | DONE | No reset on `SetupScreen` | DONE | — |
| U3 | Remove sign-in "Continue as guest" (keep one flow) | PARTIAL | `SignInPanel.tsx` — only "Use without account"; guest not duplicated | DONE | PR #782 — Skip / Skip to the guest vault; Identity **Use this device** |
| U4 | Vault tree borders overflow when expanded | NOT DONE | No Playwright/visual proof this audit | DONE | `VaultTree.guide.test.tsx` |
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
| S1 | Join-session durable vault sync (Syncthing-like) | NOT DONE | Live join exists; no post-join vault replica | DONE | `journeys-1` in [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) installs Rust 1.88.0 (same `dtolnay/rust-toolchain` pin as the Rust tests job), runs `cargo +1.88.0 build -p opensesame-cli --locked`, then `pnpm --filter @opensesame/pages verify:relay-join-live` with `target/debug` and `/usr/local/cargo/bin` on `PATH`. That spawns `opensesame host run --profile relay`. Local run 2026-10-07: A published generation 1; B read the ciphertext. `verify:live-join` stays the live-session walk. |
| S2 | Minimal slash-command typeahead | DONE | `CommandBar.test.tsx` | DONE | — |
| S3 | Remove identity status icon | DONE | `Statusline.tsx` — no identity glyph | DONE | — |
| S4 | Remove WebCrypto status icon | DONE | `Statusline.tsx` | DONE | — |
| S5 | Vault Share submenu | DONE | `vault-menu.ts` | DONE | Restored 2026-10-09 (`cursor/restore-share-pam-b359`): the vault header Share key opens the PAM grant sheet (`VaultShareKey.tsx` → `ShareGrantForm`, policy + duration, revocable in Access › Grants), not `/claim`; folders share as `folder:<id>` targets on the same ledger (`listShareTargets`). "Accept a claim" is out of vault chrome — `/claim` stays as drop-recipient plumbing only. Walk: `pnpm --filter @opensesame/pages verify:share-pam` |
| S6 | Secret Share submenu (not "share once") | DONE | `secretShare` in `vault-menu.ts` | DONE | Restored 2026-10-09: item menu keeps Temporary drop + Person or agent (the grant sheet prefilled for the item); drops work with no Identity API through the device-native claim plane (`drop-device-identity.test.ts`). The checklist walk asserts "Person or agent" and the header Share key on the full profile, and fails on any "Accept/Open a claim" menu entry |
| S7 | Default name "Secret" not "Login" on minimal | DONE | `ItemEditor` / `new-draft` tests | DONE | — |
| S8 | Secret single input control | DONE | Item editor tests | DONE | — |
| S9 | Shared icon on list items | DONE | `VaultRowDecorations.tsx` | DONE | — |
| H1 | Help: remove top/bottom explainers | DONE | #774 + support tests | DONE | — |
| H2 | Walkthrough missing control → notification | DONE | `session.ts` `notifyFailure(GUIDE_ERROR_TEXT[...])` | DONE | — |
| H3 | Design system lint for explainers / in-panel errors | DONE | `pnpm lint:design`, `design-lint.mjs`, #774 | DONE | — |
| H4 | Programmatic walkthroughs per installed features | DONE | `verify:tutorials` gate in CI; tutorial registry | DONE | `TUTORIALS_PROFILES_FULL=1 verify:tutorials-profiles`, AI off, 2026-10-07: minimal-local 9009 checks, full 14545 checks, 0 failed. `vault.item.find` no longer points at the accounts filter on a secret-only vault. |
| H5 | Feature bundles ship walkthroughs | DONE | ADR 0163 + `feature-goals.ts` | DONE | Same full-library walk; model tours withheld when support AI off |
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

Headless `grok -p` returns **Not signed in** when `XAI_API_KEY` or `GROK_CODE_XAI_API_KEY` is set. A runtime key is preferred over device OIDC in `~/.grok/auth.json`, so a depleted key looks like a missing login.

Unset both names so device login is the one that is used:

```bash
env -u XAI_API_KEY -u GROK_CODE_XAI_API_KEY grok -p "..."
# or
scripts/dev/grok-headless.sh -p "..."
```

`scripts/dev/grok-preflight.sh` prints key length and the models HTTP status only. On HTTP 403 it names that wrapper. It does not print the key or `auth.json`.

## Playwright walk

See [2026-10-playwright.md](2026-10-playwright.md). Screenshots are `/opt/cursor/artifacts/verification-2026-10/<profile>/<step>.png`. A row that depends on an optional capability is shot on `minimal-local` when that capability is off and on `full` when it is on. Removed settings rows are shot on every profile the walk builds.

| Check | Profile | Screenshot |
| --- | --- | --- |
| U5 Formats absent | every profile | `u5-formats-absent.png` |
| U6 Age Keys absent | every profile | `u6-age-keys-absent.png` |
| U7 Transport absent | every profile | `u7-transport-absent.png` |
| U8 Travel beside Duress | owner of an open vault | `u8-duress.png`, `u8-travel.png` |
| U9 Sealed store absent | every profile | `u9-sealed-store-absent.png` |
| U14 Restore | every profile | `u14-trash-restore.png` |
| U14 Delete permanently | every profile | `u14-trash-delete.png` |
| U14 Empty the trash | every profile | `u14-trash-empty-armed.png`, `u14-trash-empty.png` |
| R1 No reset mailboxes | `minimal-local` | `r1-reset-absent.png` |
| R1 Zero, one, many mailboxes | `full` | `r1-reset-zero.png`, `r1-reset-one.png`, `r1-reset-many.png` |
| R2 Per-item reset email | `minimal-local` absent, `full` selector | `r2-reset-email-absent.png`, `r2-reset-email.png` |
| R3 Password reset under Capabilities | `minimal-local` absent, `full` section | `r3-settings-absent.png`, `r3-password-reset.png` |
| E1 Environments off / on | `minimal-local`, `full` | `e1-environments-absent.png`, `e1-environments.png` |
| E2 Environment toggle | `full` | `e2-environment-toggle.png` |
| E2 Required flag | `full` | `e2-required.png` |
| E2 Missing-required notice | `full` | `e2-missing-required.png` |
