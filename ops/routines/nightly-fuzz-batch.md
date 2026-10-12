# Routine: nightly-fuzz-batch

Paste this whole file as the `prompt` of a Claude Code cloud scheduled session
(a Routine, `create_new_session_on_fire=true`). Each firing is a **fresh
session with no memory of prior runs**.

## Who you are and where you are

You are Claude Code, in a copy-on-write worktree of
`https://github.com/Tyler-R-Kendrick/OpenSesame`, branch `main`. You run the
ClusterFuzzLite-style batch fuzz pass that this repo cannot host as GitHub
Actions.

Read `docs/validation/fuzzing.md` and `docs/adr/0036-coverage-guided-fuzz-and-bounded-proofs.md`
first.

## How this firing runs

Follow AGENTS.md §9. Do the work in a copy-on-write git worktree
`/home/codex/repos/opensesame-<routine>` branched from the latest `origin/main`
(`git worktree add` shares the object database; do not full-clone). Share the
pnpm store (`pnpm store path`) and set
`CARGO_TARGET_DIR=$HOME/.cache/packages/cargo-target`. Do not copy
`node_modules` or `target/` into the worktree.

Independent findings run together through `.grok/workflows/task-swarm.rhai`:
one agent per disjoint file set, parent integrates. Land each logical slice
as its own GitHub-verified commit (`createCommitOnBranch`) on a stacked pull
request. After each commit, run `df -h /` and delete only the scratch and
build output that commit created. Leave `/tmp/os-wallet-ship`, the Host on
`127.0.0.1:8787`, and unrelated worktrees in place.

When the stack is finished, self-review, resolve review threads, and
squash-merge into `origin/main` only after TypeScript, Rust, and Bundle
budgets are green. Then `git worktree remove` the worktree and delete the
merged branches. Copilot review requests on this repository return HTTP 422.
CodeRabbit does not auto-review while the repository has fewer than 10 stars.

## Hard rules

- **This routine never becomes a GitHub Actions job.** Long fuzz batches stay
  in local sessions; do not add them to `.github/workflows/`.
- **No OSS-Fuzz upstream PR** from this routine.
- **Never commit secrets.** A crash input is a test fixture, not a credential.
- Do not add hour-long fuzz to `pnpm verify`.
- Prefer fixing a real oracle violation over silencing a harness.

## Mission

1. Confirm `cargo +nightly fuzz --version`. If cargo-fuzz or nightly rustc is missing,
   write a one-paragraph note at the bottom of
   `docs/security/tooling-evaluation.md` and stop. Do not try to install a
   toolchain that needs elevated privileges.
2. Run a budgeted batch:

   ```bash
   FUZZ_SECONDS=300 FUZZ_BATCH_BUDGET=7200 pnpm audit:fuzz:batch
   ```

3. If a target crashes:
   - Find the crash input under `$OPENSESAME_AUDIT_DIR/artifacts/` (a fresh
     private directory outside the checkout; the batch prints its path) and
     minimize it (`cargo +nightly fuzz tmin --fuzz-dir tests/fuzz/cargo
     <target> <crash>`).
   - Copy it to `tests/fuzz/cargo/regressions/<target>/`.
   - Fix the product code if the oracle is right.
   - Write `docs/security/audits/YYYY-MM-DD-fuzz-<target>.md`.
   - Open a PR (`fix(fuzz): …`).
4. Optionally promote small, reviewable new seeds from the private corpus
   (`$OPENSESAME_AUDIT_DIR/corpus/<target>/`) into
   `tests/fuzz/cargo/corpus/<target>/` and include them in that PR. The gates
   never write to the tracked corpus. Do not commit megabytes of unreviewed
   corpus.
5. If everything is CLEAN, do not open an empty PR.

## TypeScript

If time remains inside the budget:

```bash
FUZZ_SECONDS=60 pnpm test:fuzz
```

Triage Jazzer crashes the same way; they land in
`$OPENSESAME_AUDIT_DIR/artifacts/` (prefixed with the target name), not under
`tests/fuzz/jazzer/`.
