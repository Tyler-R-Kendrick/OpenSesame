# Security

How OpenSesame is meant to resist attack, and the record of where it did not.
Start with the boundaries and the main threat model; the addenda narrow the
same method onto one subsystem each. To report a vulnerability, see
[SECURITY.md](../../SECURITY.md).

## Models and boundaries

| Page | Covers |
|---|---|
| [Security boundaries](security-boundaries.md) | The separations everything else relies on: transport vs authorization, authentication vs vault unlock, Identity vs Host. |
| [Threat model](threat-model.md) | STRIDE over assets, actors and data flows for the whole system. |
| [Key hierarchy](key-hierarchy.md) | Every key from the vault root key down, what wraps what, and where each one lives. |
| [Identity-plane threat model](identity-threat-model.md) | Addendum for the TypeScript Identity API. |
| [mTLS threat model](mtls-threat-model.md) | Addendum for optional mTLS and workload identity ([ADR 0132](../adr/0132-optional-mtls-and-workload-identity.md)). |
| [Notification and approval threat model](notification-approval-threat-model.md) | Addendum for approvals delivered over external channels ([ADR 0084](../adr/0084-external-authorization-notifications.md)). |
| [Web-login rotation threat model](web-login-rotation-threat-model.md) | Addendum for rotating website passwords through remote agent browsers. |
| [Wallet threat model](wallet-threat-model.md) | Addendum for wallet spending authority (stub). |
| [SOPS wire compatibility](sops-wire-compatibility.md) | What the in-browser SOPS implementation reproduces from upstream, and what it refuses. |

## Assurance

| Page | Covers |
|---|---|
| [Audit log](audits/README.md) | Every dated audit: what was reviewed, what was found, how each finding was fixed and proved. |
| [Tooling evaluation](tooling-evaluation.md) | The scanners and harnesses behind `pnpm audit:*`, why each was chosen, and the running log of fixes they drove. |
| [Scanner rules and negative controls](../../tools/security) | The ast-grep rule set, proof that the ast-grep and gitleaks gates can still fail, and the PR security-review checklist. |
| [Security-review skill](../../skills/security-review/SKILL.md) | How to run the gates and a budgeted Codex Security scan. |

## Invariants no change may break

These are enforced by tests and gates; the rationale is in the linked ADRs and
in [`AGENTS.md` §5](../../AGENTS.md#5-design-rules-that-gate-merges).

- No agent-facing API returns a secret; there is no `getSecret()`
  ([ADR 0005](../adr/0005-authority-handle-connectionref.md)).
- Vault and master keys live only in memory; vault material never touches
  `localStorage` or `sessionStorage`.
- A sensitive approval is bound to its request digest, decision verb and
  policy digest, and spent once.
- A verified TLS peer authenticates; it never authorizes on its own.
- Breach checks disclose nothing about a tenant (k-anonymity, public catalogues
  matched locally).
- Payment credentials are never stored.
