# deepsec + Grok Build scan (2026-10-07)

Point-in-time security scan using [deepsec](https://deepsec.sh) 2.3.6 pattern
matchers and a custom **Grok Build CLI** agent plugin (`--agent grok`,
model `grok-4.7`). No application code was modified as part of this run.

deepsec agents are **pluggable** (`process`, `revalidate`, and triage). This
branch registers a Grok Build backend in `.deepsec/grok-agent-plugin.ts` and
runs investigation, revalidation, and triage on the **subscription** CLI
(`grok login --device-auth`, `XAI_API_KEY` unset). The stock `deepsec triage`
subcommand in 2.3.6 still defaults to Claude Agent SDK; OpenSesame invokes
Grok triage via `scripts/audit/deepsec-grok-triage.mjs` with the same
`--agent grok --model grok-4.7` contract as the other stages.

**Status (2026-10-08T00:30Z):** Grok Build subscription auth is working.
`process` is **still running** on this VM (`deepsec-grok-pipeline.sh`, PID
4662). Parallel worker finished PWA + **CLI** (`packages/cli/` 13 files
analyzed). Snapshot below; finish pipeline (`revalidate` → `triage` → `export`)
runs via `/tmp/deepsec-grok-watch-and-finish.sh` when `process` completes.

## Commit scanned

| Field | Value |
| --- | --- |
| SHA | `9c0eca7220665eea203f109b005072308d0eb5e6` |
| Branch | `cursor/deepsec-grok-scan-3405` (PR [#773](https://github.com/Tyler-R-Kendrick/OpenSesame/pull/773)) |

## Tooling and model

| Item | Value |
| --- | --- |
| deepsec | 2.3.6 (`.deepsec/`) |
| Pattern scan | `20261007155615-14ffb61cd7c5a795` |
| Grok auth | Device login → `contact.tylerkendrick@gmail.com` |
| Grok probe | `grok -p … -m grok-4.7` → `AUTHOK` (subscription; `XAI_API_KEY` unset) |
| Process runs | `grok` / `grok-4.7`, concurrency 2 (`/tmp/deepsec-grok-pipeline.log`, `/tmp/deepsec-grok-parallel.log`) |
| Revalidate / triage / export | `scripts/audit/deepsec-grok-finish.sh` after workers complete |

## Commands executed

```bash
unset XAI_API_KEY GROK_DEPLOYMENT_KEY
grok -p "Reply with exactly the word AUTHOK and nothing else." \
  -m grok-4.7 --always-approve --output-format json

# Long-running (nohup, logs in /tmp):
/workspace/scripts/audit/deepsec-grok-pipeline.sh
/tmp/deepsec-grok-parallel.sh

# After process completes (watch script):
/workspace/scripts/audit/deepsec-grok-finish.sh
# → error rerun, revalidate --agent grok, triage (grok plugin), export

node scripts/audit/deepsec-grok-report-data.mjs /workspace
```

## Coverage (in-scope paths)

Prefixes: **core** (`crates/core`, `crates/client-core`, `crates/host-core`,
`packages/app-core`, `packages/vault-core`), **PWA** (`apps/pages`),
**CLI** (`apps/cli`, `packages/cli`).

| Area | Analyzed | Pending | Error | Matcher hits (scan) | AI findings |
| --- | ---: | ---: | ---: | ---: | ---: |
| Core | 375 | 1 | 75 | 869 | 66 |
| PWA | 331 | 0 | 72 | 529 | 28 |
| CLI | 13 | 0 | 0 | 51 | 10 |

Pipeline was ~batch 98/137 for `packages/app-core/` when this doc was refreshed.

## Findings (snapshot)

**104** findings in scope. **10** revalidated **true-positive**, **0**
**false-positive**, remainder mostly **unrevalidated** until the finish
`revalidate` pass completes.

### Severity counts (all findings)

| Area | CRITICAL | HIGH | MEDIUM | HIGH_BUG | BUG | LOW |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Core | 0 | 16 | 30 | 6 | 14 | 0 |
| PWA | 0 | 9 | 13 | 1 | 5 | 0 |
| CLI | 0 | 4 | 6 | 0 | 0 | 0 |

### Triage priority (P0 / P1 / P2 / skip)

Triage runs on the finish pipeline with `--agent grok` (see
`deepsec-grok-triage.mjs`). Counts below update after that step completes.

| Area | P0 | P1 | P2 | skip |
| --- | ---: | ---: | ---: | ---: |
| Core | 0 | 0 | 0 | 0 |
| PWA | 0 | 0 | 0 | 0 |
| CLI | 0 | 0 | 0 | 0 |
| **Total** | **0** | **0** | **0** | **0** |

### Top confirmed issues (true-positive)

| ID | Sev | Area | Location | Title |
| --- | --- | --- | --- | --- |
| finding_41122b344b0a646d | HIGH | core | `packages/app-core/src/lib/kv.ts:129,294` | Origin KV accepts unsealed files as authentic authority |
| finding_5bbac90277a8abca | MEDIUM | core | `packages/app-core/src/lib/local-share-grants.ts:225,231,280,288,290,317,344,356` | Share revocation can be overwritten by a stale read-modify-write |
| finding_29c7bdced2093f5c | MEDIUM | core | `packages/app-core/src/lib/local-vault-sessions.ts:186,211,238,254,275,295,330,344,357,382` | Session stop can lose the race and leave system shares active |
| finding_2066d65aa8b4ac37 | BUG | core | `packages/app-core/src/lib/claims/ceremony.ts:133,134,135,182,184` | Pausing a presented claim erases the stash fields resume needs |
| finding_263e33d09724deb4 | BUG | core | `packages/app-core/src/lib/local-vault-sessions.ts:228,232,357,376` | Mid-run join issues a TTL the share writer rejects |
| finding_8838568f1ba5cab3 | BUG | core | `packages/app-core/src/lib/saved-model-agent.ts:17,21,30,52` | Support agent posts vault API keys to the app origin |
| finding_6e4af83473314203 | MEDIUM | pwa | `apps/pages/src/sections/connections/connect/ConnectTransportForm.tsx:81,94,110` | Connect seal uses decoy cover tomb / lock error / still arms bearer |
| finding_19eb4190ca18f1c1 | MEDIUM | pwa | `apps/pages/src/sections/vault/DropCeremony.tsx:200,206,267,271` | Kept-copy reveal state survives navigation to another drop |
| finding_c7a4b5c8299f09f1 | MEDIUM | pwa | `apps/pages/src/sections/vault/TypedFields.tsx:79,86` | Repeating concealed vault fields render in clear text |
| finding_b070d5576b12a75b | HIGH_BUG | pwa | `apps/pages/src/components/IdentityCeremony.tsx:92,93,94,141,142,183` | Refresh session drops live credential and reports success |

High-priority unrevalidated items include several findings in
`packages/app-core/src/lib/duress/recovery/approval.ts` (recovery quorum /
target-device proof).

## Limitations

| Item | Notes |
| --- | --- |
| **Batch errors** | Some `process`/`revalidate`/`triage` batches fail when Grok returns non-JSON prose; files get `status=error` or skip triage for that batch. Plugin retries JSON up to 3×; finish script reruns error files once. |
| **Core `process`** | `packages/app-core/` batches still in flight when snapshot taken. |
| **`.deepsec/data/`** | Gitignored; export under `.deepsec/findings-grok/`. |

## Follow-up

1. Let pipeline PID **4662** finish (watch: `/tmp/deepsec-grok-watch.log`).
2. Confirm finish log: revalidate → triage → export.
3. Refresh: `node scripts/audit/deepsec-grok-report-data.mjs /workspace`.
