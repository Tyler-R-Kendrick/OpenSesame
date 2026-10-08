# OpenSesame security audit, run 4

## Run

- Profile: standard scope, **regression re-read only** (does not count toward two consecutive clean full runs; same class as run 2).
- Source: tip of the six-PR NV stack (`cursor/cf-audit-wallet-custom-scheme-d641` / #846), onto `origin/main`.
- Prior runs: run-1, run-2 (regression-only), run-3 artifacts (#829, frozen with six `needs_validation`).
- **No fresh hunt:** zero new hunter candidates written to the ledger. The 23 records are run 3's set re-read after the stacked fixes (#839–#846).
- Grok Build unavailable (402); Cursor parent closed the re-read.

## Posture

Zero confirmed. Zero needs_validation. All six run-3 NV leads are rejected at source with the new tests on this stack. The other seventeen run-3 rejections are carried unchanged.

## Confirmed findings

None.

## Verdict counts

| Verdict | Count |
| --- | ---: |
| confirmed | 0 |
| needs_validation | 0 |
| rejected | 23 |

## Toward two clean full runs

Run 4 does **not** satisfy the loop. **Run 5** and **run 6** must each be genuine full runs (recon, fresh coverage-led hunt with new hunter candidates, adversarial validation, independent verification) with 0 confirmed and 0 needs_validation.
