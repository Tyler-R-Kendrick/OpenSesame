# opensesame-rotation-web

Web-login rotation for the Host / authority plane: the step IR, the tool
boundary a browser sandbox exposes, and the ordering of a password change that
must not be rearranged. The boundary's shape is the security property: no
method on `BrowserTransport` returns a credential value, so an agent driving a
run can say which credential goes where but has no signature that carries one
back. The same boundary read backwards (`CeremonyTransport`) holds the capture
verbs a registration ceremony needs; they seal what a page produced and answer
with a digest.

## Where it fits

- **Used by:** no workspace crate or app depends on it today. It is exercised by
  its own integration tests in [`tests/`](tests) (`ordering`,
  `ceremony_capture`, `ceremony_envelope`, `extension_transport`). It is not a
  fuzz target and is not in the authority-fabric gate. The storage step queue
  ([`0025_runner_steps.sql`](../storage/migrations/0025_runner_steps.sql))
  stores its `StepRequest` as JSON, and the gateway's agent-run routes
  (`crates/gateway/src/routes/agent_runs.rs`) hand that JSON to a driver without
  linking this crate.
- **Builds on:** [`opensesame-ceremony`](../ceremony) (capture slots and
  refusals) and [`opensesame-session-observe`](../session-observe) (frame
  admission, mask manifests, `UntrustedText`).
- No browser driver and no model client is a dependency. A remote CDP sandbox
  and a local browser extension are alternative transports, not forks.

## Surface

`run_change_password` is the ordering, in one function:

```text
generate candidate -> seal to vault -> WAIT for backup acknowledgement -> fill
  -> [critical] assert candidate present [FAIL-CLOSED] -> submit
  -> verify by fresh login -> promote
```

| Module | Items |
|---|---|
| `tools` | `BrowserTransport`, `CredentialRef`, `CandidateHandle`, `Filled`, `Presence`, `Verified`, `RedactedDom`, `AdmittedFrame`, `StepError` |
| `executor` | `run_change_password`, `ChangePasswordRecipe`, `CandidateVault`, `ActionStep`, `RunReport`, `RunOutcome`, `BlockedReason`, `ExecutorError` |
| `ceremony` | `CeremonyTransport`, `run_capture_steps`, `CaptureStep`, `CaptureVault`, `SealedCapture`, `CaptureReport`, `CaptureError` |
| `capture` | `classify`, `solve_mask`, `strip_targets`, `FieldSnapshot`, `Classification`, `ActionRecord`, `FrameRecord`, `ThoughtRecord` |
| `extension` | `ExtensionTransport`, `StepChannel`, `StepRequest`, `StepOutcome` — a fill carries a reference and a selector, never a value |

## Develop

```bash
cargo +1.88.0 test -p opensesame-rotation-web
```

`tests/ordering.rs` pins the sequence; the wait for backup acknowledgement and
the presence assertion are what separate a rotation from a lockout. Keep new
tool methods value-free.

## Related

- [ADR 0076](../../docs/adr/0076-autonomous-web-login-rotation.md) — autonomous web-login rotation
- [ADR 0082](../../docs/adr/0082-agent-run-registration-ceremonies.md) — agent-run registration ceremonies
- [ADR 0081](../../docs/adr/0081-live-session-observation.md) — live session observation
- [`docs/architecture/web-login-rotation.md`](../../docs/architecture/web-login-rotation.md), [`docs/security/web-login-rotation-threat-model.md`](../../docs/security/web-login-rotation-threat-model.md)
