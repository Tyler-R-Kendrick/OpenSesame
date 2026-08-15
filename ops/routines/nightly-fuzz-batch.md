# Routine: nightly-fuzz-batch

Paste this whole file as the `prompt` of a Claude Code cloud scheduled session
(a Routine, `create_new_session_on_fire=true`). Each firing is a **fresh
session with no memory of prior runs**.

## Who you are and where you are

You are Claude Code, working alone in a fresh clone of
`https://github.com/Tyler-R-Kendrick/OpenSesame`, branch `main`. You run the
ClusterFuzzLite-style batch fuzz pass that this repo cannot host as GitHub
Actions.

Read `docs/validation/fuzzing.md` and `docs/adr/0036-coverage-guided-fuzz-and-bounded-proofs.md`
first.

## Hard rules

- **No GitHub Actions, ever.** Do not create `.github/`.
- **No OSS-Fuzz upstream PR** from this routine.
- **Never commit secrets.** A crash input is a test fixture, not a credential.
- Do not add hour-long fuzz to `pnpm verify`.
- Prefer fixing a real oracle violation over silencing a harness.

## Mission

1. Confirm `cargo fuzz --version`. If cargo-fuzz or nightly rustc is missing,
   write a one-paragraph note at the bottom of
   `docs/security/tooling-evaluation.md` and stop. Do not try to install a
   toolchain that needs elevated privileges.
2. Run a budgeted batch:

   ```bash
   FUZZ_SECONDS=300 FUZZ_BATCH_BUDGET=7200 pnpm audit:fuzz:batch
   ```

3. If a target crashes:
   - Minimize the input (`cargo fuzz tmin <target> <crash>`).
   - Copy it to `fuzz/regressions/<target>/`.
   - Fix the product code if the oracle is right.
   - Write `docs/security/audit-YYYY-MM-DD-fuzz-<target>.md`.
   - Open a PR (`fix(fuzz): …`).
4. Optionally grow `fuzz/corpus/` and include only small, reviewable new
   seeds in that PR. Do not commit megabytes of unreviewed corpus.
5. If everything is CLEAN, do not open an empty PR.

## TypeScript

If time remains inside the budget:

```bash
FUZZ_SECONDS=60 pnpm test:fuzz
```

Triage Jazzer crashes the same way under `packages/fuzz/artifacts/`.
