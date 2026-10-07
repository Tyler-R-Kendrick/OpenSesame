# deepsec + Grok Build scan (2026-10-07)

Point-in-time security scan using [deepsec](https://deepsec.sh) 2.3.6 pattern
matchers and a custom **Grok Build CLI** agent backend (`--agent grok`,
model `grok-4.7`). No application code was modified as part of this run.

## Commit scanned

| Field | Value |
| --- | --- |
| SHA | `9c0eca7220665eea203f109b005072308d0eb5e6` |
| Branch | `cursor/deepsec-grok-scan-3405` |
| Subject | Fix mobile gate alignment and collapse release notes (#769) |

## Tooling and model

| Item | Value |
| --- | --- |
| deepsec | 2.3.6 (`.deepsec/`) |
| Pattern scan run | `20261007155615-14ffb61cd7c5a795` |
| Grok process attempt | `20261007155927-9ef37c7bdbc67fd2` (failed: not signed in) |
| AI agent | `grok` plugin → `grok` CLI 1.0.46 |
| Model flag | `-m grok-4.7` (`DEEPSEC_GROK_MODEL`) |
| Billing route | Grok Build **subscription** (`unset XAI_API_KEY`; no Vercel AI Gateway / no xAI API key for this run) |

### Wiring Grok into deepsec

deepsec only ships `codex`, `claude`, and `pi` agents. This branch adds:

- `.deepsec/grok-agent-plugin.ts` — registers `--agent grok`, spawns headless
  `grok -p … --always-approve --output-format json` with repo `cwd`, implements
  `investigate` and `revalidate` using the same JSON shapes as built-in agents.
- `.deepsec/deepsec.config.ts` — loads the plugin; **default** agent remains `pi`
  + gateway for existing `pnpm audit:deepsec` / `DEEPSEC_PROCESS=1`.
- `scripts/audit/deepsec-grok-scan.sh` — scan → per-area `process` →
  `revalidate` → `triage` → `export`.
- `scripts/audit/deepsec-grok-stats.mjs` — coverage rollup for reports.

## Commands executed

```bash
cd /workspace/.deepsec
pnpm install
unset XAI_API_KEY
./node_modules/.bin/deepsec scan --project-id opensesame

# Grok subscription login (blocked — see below)
grok login --device-auth

# AI investigation (failed before any file completed)
./node_modules/.bin/deepsec process --project-id opensesame \
  --agent grok --model grok-4.7 \
  --filter packages/app-core/ --limit 2 --concurrency 1
```

Planned full orchestration (not completed pending login):

```bash
unset XAI_API_KEY && grok login --device-auth
DEEPSEC_LIMIT=<n> /workspace/scripts/audit/deepsec-grok-scan.sh process
/workspace/scripts/audit/deepsec-grok-scan.sh revalidate
/workspace/scripts/audit/deepsec-grok-scan.sh export
```

## Grok authentication (blocked)

The VM is **not** signed in to Grok Build. `XAI_API_KEY` is present in the
environment but was **not** used (per-token billing not approved for this task).

Device login was started with:

```text
URL:   https://accounts.x.ai/oauth2/device?user_code=C5XS-3PND
Code:  C5XS-3PND
```

If that code expired, run on the cloud VM:

```bash
unset XAI_API_KEY && grok login --device-auth
```

Then re-run `scripts/audit/deepsec-grok-scan.sh` from the `process` phase.

## Coverage (pattern scan)

Repo-wide scan: **1888** files with candidates, **3125** matcher hits (81 active
matchers). Status after scan: all files `pending` for AI.

### By focus area (path prefixes)

Counts are files with ≥1 candidate hit in that prefix (a file is counted in
each matching prefix if shared; totals are indicative).

| Area | Prefixes | Files w/ candidates | Matcher hits |
| --- | --- | ---: | ---: |
| **Core** | `crates/core`, `crates/client-core`, `crates/host-core`, `packages/app-core`, `packages/vault-core` | 637 | 869 |
| **PWA** | `apps/pages` | 403 | 529 |
| **CLI** | `apps/cli`, `packages/cli` | 13 | 51 |

`crates/core`, `crates/client-core`, and `apps/cli` had **no** regex candidates
in this scan (still in scope for holistic AI review when `process` runs).

### Top in-scope files by candidate count

| Hits | File |
| ---: | --- |
| 13 | `packages/app-core/src/lib/item-type-marketplace/source.ts` |
| 8 | `packages/cli/src/run.ts` |
| 8 | `packages/app-core/src/lib/claims/ceremony.ts` |
| 7 | `packages/vault-core/src/totp.ts` |
| 7 | `packages/cli/src/parse.ts` |
| 7 | `packages/cli/src/parse.ts` |
| 5 | `packages/app-core/src/lib/live/transport.ts` |
| 5 | `apps/pages/vite.config.ts` |
| 5 | `apps/pages/src/lib/connect-conformance/connect-emulator.ts` |

### AI investigation / revalidation

| Stage | Core | PWA | CLI |
| --- | ---: | ---: | ---: |
| Files investigated (`agentType=grok`) | 0 | 0 | 0 |
| Findings produced | 0 | 0 | 0 |
| Revalidated verdicts | 0 | 0 | 0 |

## Findings

No AI findings were produced: Grok Build authentication did not complete, so
`process` and `revalidate` did not finish any batch.

| ID | Severity | Area | Location | Description | TP/FP/uncertain | Suggested fix |
| --- | --- | --- | --- | --- | --- | --- |
| — | — | — | — | *No findings (scan-only + blocked AI)* | — | — |

### Severity counts (post-revalidation)

| Area | CRITICAL | HIGH | MEDIUM | HIGH_BUG | BUG | LOW |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Core | 0 | 0 | 0 | 0 | 0 | 0 |
| PWA | 0 | 0 | 0 | 0 | 0 | 0 |
| CLI | 0 | 0 | 0 | 0 | 0 | 0 |

## Skipped / limitations

- **AI process, revalidate, triage, export** — skipped after auth failure.
- **Full-repo AI** — not run; use `DEEPSEC_LIMIT` and area filters in
  `deepsec-grok-scan.sh` to control cost/time after login.
- **xAI API key / Vercel AI Gateway** — intentionally not used for investigation.
- **`.deepsec/data/`** — remains gitignored except curated `INFO.md` / `SETUP.md`;
  export output would land in `.deepsec/findings-grok/` (gitignored).

## Follow-up

1. Complete Grok device login on the cloud VM.
2. `DEEPSEC_LIMIT=100 scripts/audit/deepsec-grok-scan.sh process` (tune limit).
3. `scripts/audit/deepsec-grok-scan.sh revalidate` and `export`.
4. Append a new dated audit row or update this file with finding IDs and
   revalidation verdicts (do not commit raw `.deepsec/data`).
