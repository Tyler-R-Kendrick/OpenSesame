# General authority — swarm ownership matrix

Bootstrap artifact. **Nothing in this directory records completed work.** It
records who owns what, which contracts must hold, and what has not been done.

Scope: generalizing the existing `Grant` / membership authority into a
hierarchical authority model that spans both planes, as drafted in
[ADR 0120](../../adr/0120-generalized-hierarchical-authority.md).

Baseline: [`repository-baseline.md`](repository-baseline.md).
Contracts: [`contract-registry.json`](contract-registry.json).
Status: [`completion-matrix.json`](completion-matrix.json).
Naming: [`compatibility-map.md`](compatibility-map.md).

## Swarms

Work IDs follow the repository's existing `<SWARM>-NN` convention (see
`docs/evidence/wallet/interaction-evidence.json`), prefixed `GA-` for this
programme.

| Swarm | Owns | Primary paths | Work IDs |
|---|---|---|---|
| **GA-A** — domain & model | The authority record, its narrowing algebra, and the executable invariants | `packages/os-domain/src/types.ts`, `packages/os-domain/src/invariants.ts`, `packages/contracts` | `GA-A-01` … `GA-A-04` |
| **GA-F** — policy & OpenFGA | The authorization-model delta and proof that it is additive | `spec/openfga/model.fga`, `packages/policy` | `GA-F-01` … `GA-F-04` |
| **GA-H** — host plane | Authority evaluation, host storage, lifecycle publication, receipts | `crates/host-core`, `crates/storage`, `crates/gateway`, `crates/lifecycle` | `GA-H-01` … `GA-H-04` |
| **GA-I** — identity plane | Identity API routes, membership reconciliation, audit events | `packages/control-plane`, `packages/database`, `packages/audit` | `GA-I-01` … `GA-I-03` |
| **GA-P** — client plane | Local share-grant alignment, Access surfaces, no-backend gating | `packages/app-core/src/lib/local-share-grants.ts`, `apps/pages/src/sections`, `apps/pwa` | `GA-P-01` … `GA-P-04` |
| **GA-C** — surface parity | Capability-registry entries and the per-surface parity sweeps | `packages/capability-registry`, `packages/mcp-host`, `packages/mcp-client`, `packages/cli`, `apps/cli` | `GA-C-01` … `GA-C-02` |
| **GA-O** — operations & docs | This directory, the ADR, the compatibility map, the completion matrix | `docs/implementation/general-authority`, `docs/architecture/general-authority.md`, `docs/adr` | `GA-O-01` … `GA-O-04` |
| **GA-Q** — quality & evidence | Structural gates, test plan, visual/behavioural evidence | `tools/quality/quality-baseline.json`, `docs/validation`, `docs/evidence` | `GA-Q-01` … `GA-Q-03` |

## Boundaries that are not negotiable between swarms

- **GA-F may not change the meaning of an existing relation.** The model delta
  is additive only; GA-F owns the proof of that, not a waiver for it
  (`INV-GA-03`).
- **GA-A owns the narrowing algebra; every other swarm calls it.** No plane
  reimplements "does this grant widen its parent" locally (`INV-GA-01`).
- **No swarm introduces a second authority model.** A handoff or an approval is
  an `Interaction` with a digest-bound proof (ADR 0086); authority records
  never carry secret values (ADR 0005).
- **GA-P may not gate guest access on any of this.** The guest/anonymous roads
  named in `AGENTS.md` § 5 stay exactly where they are (`INV-GA-11`).
- **GA-O does not mark anything complete.** Status changes require the owning
  swarm's evidence, recorded in `completion-matrix.json` with the command that
  produced it.


## Mandate swarm mapping (execution brief)

The execution brief names DOMAIN/COHORT/RESOURCE/… swarms. They map onto the
GA-* ownership above; they are not a second programme.

| Brief swarm | GA owner | Primary paths (current tree) |
|---|---|---|
| INTEGRATION | GA-O + coordinator | `docs/implementation/general-authority/*`, ADR 0120/0121 |
| DOMAIN | GA-A + GA-H | `crates/domain/src/access_domain/`, `packages/os-domain/src/access-domain/`, `crates/storage/src/authority/domains.rs` |
| COHORT | GA-A + GA-H | `crates/domain` cohort*, `crates/storage` offers, OpenFGA team/cohort |
| RESOURCE | GA-A | `permission_entry` / PermissionEntry, role manifests |
| POLICY | GA-F | `crates/authz`, `packages/policy` |
| GRANT | GA-A + GA-H | `crates/domain/src/grant*.rs`, `validated_grant_chain.rs`, storage grants |
| AUTHORIZATION | GA-H | `crates/authz`, gateway fence |
| IDENTITY | GA-I | control-plane principals/actors (enrollment gaps tracked in matrix) |
| STORAGE | GA-H | `migrations/0033_*`, `0034_general_authority.sql`, `crates/storage/src/authority/` |
| BUDGET | GA-H | `crates/storage/src/authority/budget.rs` |
| LIFECYCLE | GA-H | `crates/lifecycle`, `crates/gateway/src/lifecycle/` |
| SESSION | GA-H + GA-P | shared_session + `0035_session_coordination.sql` |
| ENFORCER / DNS / COLLAB / SANDBOX | GA-H adapters | `crates/{dns-enforcement,collab-adapter,sandbox}` |
| PORTAL | GA-P | `apps/pages` LocalAuthorityTemplates, Access sections |
| VERIFICATION | GA-Q | `scripts/authority-fabric*.mjs`, `pnpm test:authority-fabric` |
| ADVERSARIAL | GA-Q | domain/storage adversarial modules + AT matrix |
| OPERATIONS | GA-O | support matrix, runbooks, evidence packaging |

## Escalation

A contract in `contract-registry.json` that two swarms read differently is a
coordinator decision, not a local one: record the disagreement in the contract
entry's `notes` and stop, rather than picking an interpretation and building
on it.
