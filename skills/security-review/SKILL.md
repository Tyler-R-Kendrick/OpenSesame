---
name: security-review
description: Run and interpret OpenSesame security reviews using the repository's deterministic gates and targeted Codex Security scans. Use for security audits, SAST, scanner findings, auth or crypto changes, and pre-merge security evidence.
---

# Security review

Use the repository's existing gates. Do not install a second scanner, add CI, or
weaken a rule to obtain a green result.

## Scope and evidence

1. Read the root and applicable nested `AGENTS.md` files. Preserve unrelated
   work; use a disposable clone when a tool requires a clean checkout.
2. Trace the changed trust boundary and select the narrowest commands that cover
   it. Run deterministic tools before model-backed review.
3. Distinguish focused results from aggregate and full-repository verification.
   A partial, timed-out, budget-limited, or path-scoped result is never evidence
   that unreviewed code is secure.

## Repository gates

Use the scripts already declared in `package.json`:

- TypeScript/JavaScript: `pnpm lint`, `pnpm lint:anti-slop`, and the affected
  package's typecheck/tests. Use `pnpm lint:all` for a repository-wide lint.
- Rust: `cargo fmt --all -- --check` and `pnpm audit:clippy`. Clippy is
  full-feature, all-target, pedantic/complexity enforcement.
- Security boundaries: `pnpm test:security`, `pnpm test:redteam`, and
  `pnpm test:task-access` when task or agent authority is involved.
- SAST/secrets/dependencies: the applicable `pnpm audit:cve-lite`,
  `audit:ast-grep`, `audit:osv`, `audit:cargo-audit`, `audit:gitleaks`,
  `audit:semgrep`, and `audit:daemon-deps` gates.
- Parser, crypto, concurrency, or policy changes: run the applicable fuzz,
  mutation, Kani, Miri, Shuttle, coverage, behavior, contract, chaos, snapshot,
  and atomic unit suites listed in the root `AGENTS.md`.
- Before landing security-sensitive work, run `pnpm verify`. Test-depth and
  several audit suites are intentionally outside `verify`; run them explicitly
  when their boundary changed.

Fix confirmed root causes at the shared enforcement boundary and add the
smallest regression test that fails without the fix. Do not patch speculative
scanner prose or suppress a diagnostic without validating its source-to-sink
path.

## Codex Security defaults

Codex Security is supplemental. Follow the complete ownership/container
procedure in the root `AGENTS.md`. These defaults are mandatory unless the
human explicitly overrides them:

```bash
codex-security scan <clean-checkout> \
  --path <security-boundary> \
  --auth chatgpt \
  --model gpt-5.6-luna --effort low \
  --mode standard --max-cost 15 \
  --fail-on-severity high \
  --headless --verbose \
  --output-dir <private-dir-outside-checkout> --archive-existing \
  --dry-run
```

- `--auth chatgpt` is fail-closed subscription use. Never use `--auth auto`:
  unattended scans give API keys precedence. Use `--auth api-key` only when the
  human explicitly requests API billing.
- GPT-5.6 Luna with low reasoning is the cost-preserving default. Record lower
  review depth as a coverage limitation; do not silently switch models or
  effort.
- `$15` is one shared scanner estimate cap, not a separate allowance per path
  and not necessarily an API charge when ChatGPT authentication is selected.
  Raising it or scanning the whole repository requires explicit approval.
- Run `--dry-run` first. Confirm paths or diff, auth, model, effort, mode,
  output directory, and cap before removing it.
- Obtain explicit approval before model/repository-content network egress. Keep
  scan artifacts private and outside the checkout.
- If the checkout is dirty, clone the same committed HEAD into a disposable
  directory. Never stash, delete, or overwrite user work for a scan.

Current authentication behavior is documented in the official
[Codex authentication documentation](https://learn.chatgpt.com/docs/auth), and
GPT-5.6 Luna supports low reasoning per the official
[model documentation](https://developers.openai.com/api/docs/models/gpt-5.6-luna).

## Findings and reporting

Only completed ledger entries were reviewed. `no_candidate` applies only to
that completed file. `cost_limit_exceeded`, interruption, or
`partial_output=true` means incomplete coverage, and `--fail-on-severity` is a
release gate only after a complete scan.

Report tool versions, exact scope, base/head when applicable, auth mode, model,
effort, cap and estimated cost, completed/total files, findings, fixes, tests,
and residual unreviewed scope. Never publish exploit details or secrets.
