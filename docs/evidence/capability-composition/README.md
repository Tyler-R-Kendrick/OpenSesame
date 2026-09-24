# Capability composition — verification evidence

The evidence behind [ADR 0130](../../adr/0130-operator-controlled-capability-composition.md):
optional code never loads before consent. The before/after screens are in
[`2026-09-22-capability-composition/`](../2026-09-22-capability-composition/README.md);
the method is in [validation](../../validation/capability-composition.md).

| File | What it records |
|---|---|
| [`baseline.md`](baseline.md) | The tree before any capability-composition change. |
| `assignment-ledger.json` | Which source files each capability owns. |
| `contract-test-matrix.json` | Each contract and the test that proves it, or `pending` where none has landed. |
| [`red-team.md`](red-team.md) | What was attacked, what held, and what was not attempted. |
| [`limitations.md`](limitations.md) | What the feature does not claim. |
