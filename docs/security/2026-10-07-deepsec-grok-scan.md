# deepsec + Grok Build scan (2026-10-07)

Point-in-time security scan using [deepsec](https://deepsec.sh) 2.3.6 pattern
matchers and a custom **Grok Build CLI** agent plugin (`--agent grok`,
model `grok-4.7`). This branch documents the scan; application fixes ship on
stacked `cursor/deepsec-fix-*` draft PRs (not merged here).

deepsec agents are **pluggable** (`process`, `revalidate`, and triage). This
branch registers a Grok Build backend in `.deepsec/grok-agent-plugin.ts` and
ran investigation, revalidation, and triage on the **subscription** CLI
(`grok login --device-auth`, `XAI_API_KEY` unset). The stock `deepsec triage`
subcommand in 2.3.6 still defaults to Claude Agent SDK; OpenSesame invokes
Grok triage via `scripts/audit/deepsec-grok-triage.mjs` with the same
`--agent grok --model grok-4.7` contract as the other stages.

**Status (2026-10-08T07:18:50Z):** Scan **complete**. Finish log reports
`revalidate` → Grok triage → export. Export: **150** findings in
`.deepsec/findings-grok/` (four malformed INFO/NONE rows dropped at export).

## Commit scanned

| Field | Value |
| --- | --- |
| SHA | `9c0eca7220665eea203f109b005072308d0eb5e6` |
| Branch | `cursor/deepsec-grok-scan-3405` (PR [#773](https://github.com/Tyler-R-Kendrick/OpenSesame/pull/773)) |
| Finish | `=== FINISH COMPLETE 2026-10-08T07:18:50Z ===` (`/tmp/deepsec-grok-finish.log`) |

## Tooling and model

| Item | Value |
| --- | --- |
| deepsec | 2.3.6 (`.deepsec/`) |
| Pattern scan | `20261007155615-14ffb61cd7c5a795` |
| Grok auth | Device login (subscription; `XAI_API_KEY` unset) |
| Process / revalidate / triage | `grok-4.7`, concurrency 2 |
| Logs | `/tmp/deepsec-grok-pipeline.log`, `/tmp/deepsec-grok-finish.log` |

## Commands executed

```bash
unset XAI_API_KEY GROK_DEPLOYMENT_KEY
/workspace/scripts/audit/deepsec-grok-pipeline.sh
/tmp/deepsec-grok-parallel.sh
# watch → /workspace/scripts/audit/deepsec-grok-finish.sh

node scripts/audit/deepsec-grok-report-data.mjs /workspace
```

## Coverage (in-scope paths)

Prefixes: **core** (`crates/core`, `crates/client-core`, `crates/host-core`,
`packages/app-core`, `packages/vault-core`), **PWA** (`apps/pages`),
**CLI** (`apps/cli`, `packages/cli`).

| Area | Analyzed | Pending | Error | Matcher hits (scan) |
| --- | ---: | ---: | ---: | ---: |
| Core | 637 | 0 | 0 | 869 |
| PWA | 403 | 0 | 0 | 529 |
| CLI | 13 | 0 | 0 | 51 |

## Findings (final)

| Verdict | Count |
| --- | ---: |
| **True-positive** | **150** |
| **False-positive** | **5** |

Per area (true-positive / false-positive):

| Area | True-positive | False-positive |
| --- | ---: | ---: |
| Core | 108 | 3 |
| PWA | 32 | 2 |
| CLI | 10 | 0 |

### Severity counts (true-positive findings)

| Area | HIGH | MEDIUM | HIGH_BUG | BUG | LOW | other |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Core | 29 | 59 | 2 | 3 | 16 | 2 (NONE) |
| PWA | 8 | 15 | 1 | 2 | 6 | 2 (INFO/NONE) |
| CLI | 3 | 7 | 0 | 0 | 0 | 0 |

### Triage priority (P0 / P1 / P2 / skip)

| Area | P0 | P1 | P2 | skip |
| --- | ---: | ---: | ---: | ---: |
| Core | 11 | 71 | 26 | 1 |
| PWA | 2 | 21 | 8 | 1 |
| CLI | 1 | 8 | 1 | 0 |
| **Total** | **14** | **100** | **35** | **2** |

Fix queue: **150** findings (all non–false-positive), ordered P0 → P1 → P2
then severity (`scripts/audit/deepsec-grok-fix-queue.mjs`).

### P0 findings (remediation first)

| ID | Area | Location | Title |
| --- | --- | --- | --- |
| finding_08f341a1caedad41 | cli | `packages/cli/src/parity-node.ts` | Credential helper PATH lookup |
| finding_41122b344b0a646d | core | `packages/app-core/src/lib/kv.ts` | Origin KV accepts unsealed files |
| finding_4e404a871c7792e9 | core | `packages/app-core/src/lib/at-rest/web-storage.ts` | Web Storage plaintext reseal |
| finding_68d1eb4363d74f8e | pwa | `apps/pages/.../ConnectIdentityNote.tsx` | Locked ceremony retargets Identity issuer |
| finding_9004ac142fcc4d31 | core | `packages/app-core/src/lib/federation-pending.ts` | PKCE pending swap / sign-in theft |
| finding_a1e774d3565c9af5 | core | `packages/app-core/src/lib/travel/return.ts` | Missing tomb header deletes live vault |
| finding_ac27e08f517344a1 | pwa | `apps/pages/.../support.remote-ai/runtime.ts` | Remote-support POSTs cloud API keys to origin |
| finding_af73edb2deb1c255 | core | `packages/app-core/src/lib/settings.ts` | Guest rewrites Identity/Host trust anchors |
| finding_afe9924a15cb3b16 | core | `packages/app-core/src/lib/vault/unlock-methods.ts` | 8-digit PIN offline-crackable wrap |
| finding_c1b0ae42617f6fd4 | core | `packages/app-core/src/lib/password-agent/startup-env.ts` | Env screener misses startup hooks |
| finding_c91553b6b7b0871d | core | `packages/app-core/src/lib/hosted-inference.ts` | Model secrets POSTed to app origin |
| finding_db53526e593772dd | core | `packages/app-core/src/lib/feature-request-send.ts` | Backup sync leaks SSH keys in headers |
| finding_dbbb0b56d33b0a76 | core | `packages/app-core/src/lib/recovery/ceremony.ts` | Quorum digest not recomputed |
| finding_e7d51ead834be5ff | core | `packages/app-core/src/lib/recovery/approval.ts` | One MAC key satisfies multi-domain quorum |

## Limitations

| Item | Notes |
| --- | --- |
| **Batch errors** | Some batches fail when Grok returns non-JSON prose; finish reruns error files once. |
| **Export drops** | Four findings with invalid severity (INFO/NONE) omitted from md-dir export. |
| **`.deepsec/data/`** | Gitignored; export under `.deepsec/findings-grok/`. |
| **Fix phase** | When Grok Build quota is exhausted, fixes may run on Cursor agent usage until `grok` probe succeeds again. |

## Follow-up

1. Stacked draft PRs per finding (`cursor/deepsec-fix-*`), base #773 scan context.
2. Rescan changed files after each fix round; skip only revalidated false positives.
3. Do not merge until human review.
