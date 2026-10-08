# OpenSesame security audit, run 5

## Run

- Profile: standard full run on stack tip (#846 + run-4 regression artifacts).
- Phases: recon, coverage-led hunt, adversarial validation, independent verification.
- **New hunter candidates this run: 6** (all rejected after source review; recorded in findings.json).
- Grok Build unavailable (402); Cursor parent closed the run.

## Posture

Zero confirmed. Zero needs_validation. Twenty-three carried rejections from run 4; six new hunter leads closed at source.

## Verdict counts

| Verdict | Count |
| --- | ---: |
| confirmed | 0 |
| needs_validation | 0 |
| rejected | 29 |

## Toward two clean full runs

Run 5 is the **first** counted clean full run. **Run 6** must repeat a genuine full run with new hunter candidates and the same 0/0 verdict.
