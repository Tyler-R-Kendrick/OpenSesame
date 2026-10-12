# Archive

Documents kept for provenance, not for guidance. Each one was accurate when
written and has since been overtaken by the code, an ADR, or a later plan.
Nothing here describes how OpenSesame works today — when a page below
disagrees with [architecture](../architecture/README.md) or an
[ADR](../adr/README.md), those win.

| Path | What it was | Superseded by |
|---|---|---|
| [`2026-08-07-baseline/`](2026-08-07-baseline) | The first assessment of the repository, the task-authority audit, the battle-test critique, and the first test runs of both planes. | [Test strategy](../validation/test-strategy.md), [test coverage](../validation/test-coverage.md), the current gates. |
| [`brief-implementation-status.md`](brief-implementation-status.md) | Status against the original one-shot implementation brief. | The ADRs and the code. |
| [`plans/`](plans) | Implementation plans and design specs for the git-sealed store, tombs and `pass otp`, file attachments, and certificate-manager parity. | Git-sealed store: [ADR 0037](../adr/0037-git-sealed-store.md). Tombs: [ADR 0038](../adr/0038-multi-tomb-sealed-store.md). `pass otp`: the verb itself (`apps/cli/src/pass_otp.rs`). File attachments: [ADR 0054](../adr/0054-file-attachment-storage.md). Certificate manager: ADRs [0066](../adr/0066-certificate-manager-domain-model.md)–0072, and only in part: the plan is not fully built, and each of those ADRs carries an `Implementation:` line saying what is. |
| [`prompts/`](prompts) | One-shot briefs written for agent swarms: automation, the connector broker, Doppler parity, NATS, passkey portability, the security programme, vault backup, key protection. | Landed work, recorded in the code and the ADRs that cover the same ground, for example [ADR 0032](../adr/0032-connection-broker-service-integrations.md) (connector broker), [ADR 0041](../adr/0041-projects-sync-targets-and-secret-changelog.md) and [ADR 0042](../adr/0042-nats-taskbus-auth-callout-and-xkeys.md) (Doppler parity, NATS), [ADR 0129](../adr/0129-vault-key-protection-manifest.md) (key protection); vault backup is the `backup.git-remote` capability. |
| [`wallet-swarm-coordination.md`](wallet-swarm-coordination.md) | Coordination notes for the wallet spending work. | [ADR 0123](../adr/0123-wallet-spending-authority.md), which records the binding decisions (its status line reads "implementation in progress"). |

Move a document here when the work it planned has landed; add a row saying
what replaced it.
