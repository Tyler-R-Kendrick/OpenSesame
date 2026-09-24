# opensesame-session-observe

The value-blind vocabulary for watching a sandboxed agent run live and taking
control of it on the Host / authority plane. When an agent drives a browser
through somebody's account, that person can watch it, see what the model
believed it was doing, and take the page back. This crate holds the handoff
machine, the gate every screencast frame passes, and the rule for who may
attach. It does no I/O: the gateway supplies transport and persistence, the
runner supplies capture and sealing.

## Where it fits

- **Used by:** [`apps/gateway`](../../apps/gateway)
  (`src/routes/agent_runs.rs`), [`opensesame-a2h`](../a2h) and
  [`opensesame-rotation-web`](../rotation-web).
- **Builds on:** no workspace crates (`serde`, `thiserror`).
- Exactly one actor drives. The agent is provably parked before a human touches
  the page, and the span between a candidate's presence assertion and its
  submit cannot be interrupted. Autonomy is never resumed by a timeout: an
  expired lease parks the run.
- A frame whose mask cannot be proven current is dropped, not sent.
- Only the owner may watch or drive: not a delegate, not an operator, not an
  agent surface.
- No type here can carry a credential value. `SealedPayload` takes and returns
  ciphertext; `UntrustedText` wraps model-authored prose and refuses to render
  itself.

## Surface

| Piece | Items |
|---|---|
| Control lease | `ControlLease`, `ControlState`, `ControlError`, `CriticalExit`, `HandoffOutcome`, `Quiescence`, `Reassertion` |
| Frame stream | `admit_frame`, `FrameDrop`, `Lane`, `LayoutEpoch`, `MaskManifest`, `ObservationEvent`, `SealedPayload`, `Seq`, `UntrustedText`, `MAX_THOUGHT_CHARS` |
| Viewers | `authorize_attach`, `Attachment`, `AttachRefusal`, `StepUp`, `ViewerRelation` |

## Develop

```bash
cargo +1.88.0 test -p opensesame-session-observe
```

`tests/withdraw_handoff.rs` checks that withdrawing a handoff cannot become a
route back to autonomy: a released run waits in `ResumeRequested` until a
re-assertion passes. The viewer types derive `kani::Arbitrary` under
`cfg(kani)`.

## Related

- [ADR 0081](../../docs/adr/0081-live-session-observation.md) — live session observation
- [ADR 0076](../../docs/adr/0076-autonomous-web-login-rotation.md) — autonomous web-login rotation (the T4 tier observed here)
- [`docs/architecture/live-session-observation.md`](../../docs/architecture/live-session-observation.md)
