# Evidence — duress profiles (2026-09-21)

Implementation workstream for optional browser-local duress profiles on
OpenSesame Pages (`feat/duress-profiles`).

| Artifact | Role | Owner |
|---|---|---|
| [baseline.md](./baseline.md) | Start HEAD / toolchain notes | COORD |
| [architecture.md](./architecture.md) | Trust boundaries, key graph, commit points | DOCS |
| [limitations.md](./limitations.md) | Normative non-claims | DOCS |
| [operators.md](./operators.md) | Index to operator guides | DOCS |
| [security-review.md](./security-review.md) | Threat notes + finding log | DOCS scaffold / REDTEAM findings |
| [traceability.json](./traceability.json) | INV / SC / AT / task map | DOCS scaffold; COORD fills results |
| `verification.json` | Command outcomes | COORD (not written by DOCS) |
| `capabilities.json` | Runtime assurance | COORD / BUILD |
| `key-paths.json` | Disposable key graph categories | KEYS / COORD |
| `examples/` | Policy fixtures | **CONTRACT only** |
| `browser/` | Redacted screenshots/traces | BROWSER-QA |

## Operator manuals

- [Duress profiles](../../operators/duress-profiles.md)
- [Inventory & recovery](../../operators/duress-inventory-recovery.md)
- [Troubleshooting](../../operators/duress-troubleshooting.md)
- ADR [0130](../../adr/0130-duress-profiles-trust-boundaries.md)

## How to read results

`traceability.json` entries use `result: "pending"` until COORD records a
real execution. `blocked` means environment/hardware unavailable — never
count as pass. Do not invent script names; use BUILD-published verify
entry points when present.
