# tools/security

Configuration for the security scanners and the evidence that they still work:
the ast-grep rule set, a negative control for each of the ast-grep and gitleaks
gates, and the checklist Claude security reviews apply to a pull request.
Nothing here ships; it decides what a security gate or a reviewer treats as a
finding.

## Where it fits

- **Read by:** [`scripts/audit/ast-grep-security-gate.sh`](../../scripts/audit/ast-grep-security-gate.sh)
  (`pnpm audit:ast-grep`) reads `ast-grep-rules.yml`. The routines
  [`ops/routines/pr-security-review.md`](../../ops/routines/pr-security-review.md)
  and [`ops/routines/weekly-security-audit.md`](../../ops/routines/weekly-security-audit.md)
  read `claude-review-checklist.md`.
- The gitleaks configuration itself is [`.gitleaks.toml`](../../.gitleaks.toml)
  at the root, read by `scripts/audit/gitleaks-gate.sh` (`pnpm audit:gitleaks`);
  only its negative control lives here.
- A gate that is permanently red reports nothing, so each suppression is made
  at its call site with a reason, not by widening a rule's scope.

## Files

| File | What it is |
|---|---|
| `ast-grep-rules.yml` | Eleven error-level rules: SQL string formatting and shell command construction in Rust; `eval`, `innerHTML` (TS and TSX), `dangerouslySetInnerHTML`, `document.write`, web-storage writes (TS and TSX), `Math.random` and `child_process` exec in TypeScript. The browser-risk rules (innerHTML, web storage, `Math.random`) carry a test-file ignore list; the injection rules do not. |
| `ast-grep-negative-control.md` | Four cases that show the rules can still fail and that the test-file scoping narrows the browser-risk rules without switching the injection rules off. Also lists the three production findings suppressed in place, and why. |
| `gitleaks-negative-control.md` | How to plant generated, correctly shaped credentials and watch `pnpm audit:gitleaks` fail, and what each exemption in `.gitleaks.toml` costs: `// gitleaks:allow` must be trailing on the same line, and path entries are whole-file. |
| `claude-review-checklist.md` | Nine sections of diff-checkable items (bind fences and CORS, fail-closed production paths, token and DPoP custody, CSRF, sealed-store integrity, log redaction, SSRF, quotas, audit chain and grant scope) plus the non-negotiables, each citing the security doc or audit it came from. |

## Develop

```bash
pnpm audit:ast-grep       # needs ast-grep on PATH; fails on any error-level finding
pnpm audit:gitleaks       # needs gitleaks on PATH
```

The ast-grep gate scans `apps`, `crates` and `packages`, and the script also
passes `--globs` that skip `*.test.*`, `*.spec.*` and snapshots. Output goes to a
fresh mode-0700 directory outside the checkout, under `OPENSESAME_AUDIT_DIR` or
`$TMPDIR`.

After any change to `ast-grep-rules.yml`, run the four cases in
`ast-grep-negative-control.md`; after any change to `.gitleaks.toml`, run the
probe in `gitleaks-negative-control.md`. A new rule is a new document block in
the YAML with `severity: error`. When a checklist item changes, cite the doc
or audit it was distilled from, as every existing item does.

## Related

- [`docs/security/tooling-evaluation.md`](../../docs/security/tooling-evaluation.md) — why each scanner was chosen
- [`docs/security/audits/2026-08-07-ast-grep.md`](../../docs/security/audits/2026-08-07-ast-grep.md) — the audit that introduced the rule set
- [`skills/security-review/SKILL.md`](../../skills/security-review/SKILL.md) — running the gates and targeted reviews
- [`docs/security/README.md`](../../docs/security/README.md) — the security documentation index
