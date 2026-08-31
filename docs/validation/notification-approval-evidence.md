# Validation evidence — external authorization notifications and approval ceremonies

Local validation for [ADR 0081](../adr/0084-external-authorization-notifications.md).
Every command below was run in this repository. No GitHub Actions runner was
used, and no workflow was triggered.

- Base commit: `2b7727b691b650aad46db60f05480dde3640e4e6` (`main` at the time)
- Branch: `claude/external-auth-notifications-ceremonies-20qj4n`

## Gates run, and what they said

| Command | Result |
|---|---|
| `pnpm typecheck` | 51/51 tasks successful |
| `pnpm test` | 55/55 tasks successful |
| `pnpm lint` | 95 files checked, no findings |
| `pnpm lint:design` | `design-lint: 165 file(s) OK` |
| `pnpm lint:anti-slop` | clean (0 findings) |
| `pnpm test:anti-slop` | 16 files, 363 tests passed |
| `pnpm test:rust-lint` | `rust lint contract: OK` |
| `pnpm test:security` | 1 file, 3 tests passed |
| `cargo +1.88.0 fmt --all -- --check` | clean |
| `cargo +1.88.0 test --workspace --all-targets` | 69 suites ok, 0 failed |
| `pnpm audit:clippy` | `clippy gate: CLEAN` |
| `pnpm audit:daemon-deps` | `daemon-deps gate: CLEAN` |
| `pnpm audit:cargo-audit` | `CLEAN (0 vulnerabilities)` |
| `pnpm audit:osv` | `CLEAN (0 vulnerabilities after ignores)` |
| `pnpm audit:semgrep` | `semgrep gate: CLEAN` (after the fix below) |

### Per-package suites for the packages this work touches

| Package | Tests |
|---|---|
| `@opensesame/os-domain` | 20 files, 196 passed |
| `@opensesame/trust-broker` | 2 files, 21 passed |
| `@opensesame/notification-adapters` | 10 files, 136 passed |
| `@opensesame/database` | 18 files, 273 passed |
| `@opensesame/control-plane` | 62 files, 825 passed |
| `@opensesame/worker` | 12 files, 101 passed |
| `@opensesame/auth-upstream` | 13 files, 82 passed |
| `@opensesame/ceremonies` | 8 files, 49 passed |
| `@opensesame/pages` | 170 files, 2353 passed |
| `@opensesame/audit` | 6 files, 59 passed |
| `@opensesame/capability-registry` | 1 file, 10 passed |
| `@opensesame/redteam` (structural) | 2 files, 27 passed |

## Findings this validation produced, and their fixes

1. **`pnpm audit:semgrep` — `gcm-no-tag-length`** at
   `packages/notification-adapters/src/adapters/web-push.ts`. The aes128gcm
   cipher and decipher took Node's default tag length rather than stating it.
   Fixed by passing `{ authTagLength: 16 }` on both, so the two sides cannot
   disagree and a truncated tag cannot be accepted. Gate now CLEAN.

2. **`pnpm audit:gitleaks` — four new `generic-api-key` findings**, all fake
   signing secrets in the adapter test fixtures. Replaced with low-entropy
   strings that say what they are. The scan then reported exactly the 12
   findings the base commit reports (see below).

## Independently proven pre-existing failures

Each was reproduced at the untouched base commit `2b7727b` in a separate
`git worktree` with its own `pnpm install --frozen-lockfile`.

1. **`pnpm test:integration` — `@opensesame/visual-contract`, 6 failures.**
   All six are `locator.waitFor: Test timeout of 60000ms exceeded`, not pixel
   mismatches: `apps/pages` now renders the first-run setup ceremony
   ([ADR 0077](../adr/0077-first-run-setup-ceremony.md)) before the vault
   screens the checked-in baselines were captured against, so the selectors
   never appear. **Identical 6 failures at base.** The other 6 integration
   tasks pass.

2. **`pnpm audit:gitleaks` — 12 findings.** Test fixtures and PKI sample
   material under `crates/pki-core`, `apps/gateway`, `apps/pages`,
   `packages/contracts`, `packages/webmcp`, `apps/ceremonies` and
   `docs/design`. **Identical 12 findings at base**; this work contributes
   none.

3. **`pnpm audit:ast-grep` — 3 `sql-format-injection` findings**, all in
   `crates/storage` (`lib.rs:8853`, `security.rs:965`,
   `tests/certmgr_snapshot.rs:41`). This work changed no Rust file.
   **Identical 3 findings at base.**

## Gates that could not run here, and why

These fail on tooling absence rather than on any finding, in this container
and at the base commit alike:

- `pnpm audit:cve-lite` — `cve-lite: command not found`.
- `pnpm test:redteam` — needs `ANTHROPIC_API_KEY`; it drives a live model.
  Running it would mean a paid API call, which this work is not permitted to
  introduce. The package's structural pact suite (`vitest`, 27 tests) is the
  part that runs offline and it passes.

`gitleaks`, `semgrep` and `ast-grep` were not present either; all three were
installed locally (free, open-source, outside the repository — no manifest
changed) so their gates could actually be run rather than skipped.

## Not run

`pnpm verify` was not run end-to-end because it includes `test:integration`,
whose visual-contract failure is the pre-existing one above; its constituent
parts were each run individually and are listed in the table. `pnpm
test:coverage`, `test:mutation`, `test:fuzz` and the Kani/Miri/Shuttle gates
are outside `pnpm verify` by the repository's own contract and were not run.

No paid, model-backed security scanner was run.
