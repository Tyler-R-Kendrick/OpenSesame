# deepsec + Grok Build scan (2026-10-07)

Point-in-time security scan using [deepsec](https://deepsec.sh) 2.3.6 pattern
matchers and a custom **Grok Build CLI** agent backend (`--agent grok`,
model `grok-4.7`). No application code was modified as part of this run.

**Status (2026-10-07T21:20Z):** Grok Build subscription auth is working.
`process` is **still running in the background** on this VM (main +
parallel workers). This report captures the first **40** AI findings,
**10** revalidated as **true-positive**, and an export under
`.deepsec/findings-grok/`. **CLI** investigation has not started yet;
**triage** was skipped (deepsec requires Claude / gateway, not used here).

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
| Grok auth | Device login `ZYN7-QTES` → `contact.tylerkendrick@gmail.com` |
| Grok probe | `grok -p … -m grok-4.7` → `AUTHOK` (subscription; `XAI_API_KEY` unset) |
| Process runs | `grok` / `grok-4.7`, concurrency 2 (`/tmp/deepsec-grok-pipeline.log`, `/tmp/deepsec-grok-parallel.log`) |
| Revalidate run | `20261007205432-927b9e45d4370c16` (`/tmp/deepsec-grok-revalidate.log`) |
| Export | `.deepsec/findings-grok/` (40 markdown files, unresolved verdicts only) |

## Commands executed

```bash
unset XAI_API_KEY GROK_DEPLOYMENT_KEY
grok -p "Reply with exactly the word AUTHOK and nothing else." \
  -m grok-4.7 --always-approve --output-format json

# Long-running (nohup, logs in /tmp):
/workspace/scripts/audit/deepsec-grok-pipeline.sh      # PID 4662 — full area sequence
/tmp/deepsec-grok-parallel.sh                          # PID 15373 — PWA + smaller core + CLI queue
/tmp/deepsec-grok-revalidate.sh                        # revalidate → triage (failed) → export

cd /workspace/.deepsec
./node_modules/.bin/deepsec revalidate --project-id opensesame --agent grok --model grok-4.7
./node_modules/.bin/deepsec export --project-id opensesame --format md-dir --out ./findings-grok
```

## Coverage (in-scope paths)

Prefixes: **core** (`crates/core`, `crates/client-core`, `crates/host-core`,
`packages/app-core`, `packages/vault-core`), **PWA** (`apps/pages`),
**CLI** (`apps/cli`, `packages/cli`).

| Area | Analyzed | Pending | Error | Matcher hits (scan) | AI findings |
| --- | ---: | ---: | ---: | ---: | ---: |
| Core | 210 | 24 | 66 | 869 | 31 |
| PWA | 173 | 0 | 62 | 529 | 9 |
| CLI | 0 | 13 | 0 | 51 | 0 |

`process` was ~batch 61/137 for `packages/app-core/` and ~56/96 for
`apps/pages/` when export ran; workers were left running.

## Findings after revalidation (snapshot)

**40** findings total. **10** `true-positive`, **0** `false-positive`,
**30** `unrevalidated` (Grok returned prose instead of JSON on several
revalidate batches; see `data/opensesame/revalidation/20261007205432-927b9e45d4370c16/`).

### Severity counts (all findings in snapshot)

| Area | CRITICAL | HIGH | MEDIUM | HIGH_BUG | BUG | LOW |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Core | 0 | 12 | 10 | 2 | 7 | 0 |
| PWA | 0 | 1 | 6 | 1 | 1 | 0 |
| CLI | 0 | 0 | 0 | 0 | 0 | 0 |

### Severity × verdict (revalidated true-positives only)

| Area | HIGH | MEDIUM | HIGH_BUG | BUG |
| --- | ---: | ---: | ---: | ---: |
| Core | 1 | 2 | 0 | 3 |
| PWA | 0 | 3 | 1 | 0 |

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

### Other findings (not yet revalidated)

Twenty-five core and five PWA findings remain `unrevalidated`, including
several **HIGH** items in `packages/app-core/src/lib/duress/recovery/approval.ts`
(multi-domain recovery quorum / target-device proof). Re-run:

```bash
unset XAI_API_KEY
cd /workspace/.deepsec
./node_modules/.bin/deepsec revalidate --project-id opensesame --agent grok --model grok-4.7
```

## Skipped / limitations

| Item | Reason |
| --- | --- |
| **triage** (P0/P1/P2) | deepsec `triage` requires `--agent claude` + gateway credentials; not run (no gateway / no API key). |
| **CLI `process`** | Queued behind parallel worker; 13 files still `pending`. |
| **Full core `process`** | ~45% of `packages/app-core/` batches done when export ran; workers intentionally left running. |
| **Batch errors** | Some `process`/`revalidate` batches failed when Grok returned non-JSON prose (`status=error` on affected files; deepsec retries on next run). |
| **`.deepsec/data/`** | Gitignored; export only in `.deepsec/findings-grok/`. |

## Follow-up

1. Let PIDs **4662** / **15373** finish (or re-run `deepsec-grok-pipeline.sh`).
2. `revalidate` again for remaining findings; optionally add a non-gateway triage path later.
3. Refresh this doc from `node scripts/audit/deepsec-grok-report-data.mjs /workspace`.
