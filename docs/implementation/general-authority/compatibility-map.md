# General authority — compatibility map

Two questions get conflated whenever a hierarchical authority model is
proposed. This document separates them and records where each one stands.

1. **Product view** — do users see a *Grant* or an *AccessLease*?
2. **Authorization model** — what happens to `policy/openfga/model.fga`?

Neither is decided. This map states the constraints both answers must satisfy.

## 1. Grant vs AccessLease is a product view over one record

### What exists today

| Concern | Baseline reality (`4358f7fe`) |
|---|---|
| Identity-plane authority | `ProjectMembership` in `packages/os-domain/src/types.ts` — `projectId`, `principalId`, `role` of `owner \| admin \| member` |
| The word "Grant" | A doc comment ("Grants a principal access to a shared project") and a `requestedGrant?: JsonObject` field. There is no `Grant` type |
| Client-plane authority | `LocalShare` / `ShareKind` / `ShareTarget` in `apps/pages/src/lib/local-share-grants.ts` — the one ledger, with `connection` bindings added by ADR 0115 |
| "AccessLease" | Does not appear anywhere in the repository |

So "extending Grant" means extending the membership/share-grant authority
records that already exist, under whichever name survives review.

### The two names, as product views

| | **Grant** | **AccessLease** |
|---|---|---|
| Reads as | A permission that was given | A permission that was borrowed and will lapse |
| Implies about expiry | Nothing; a grant can be permanent | Expiry is the default, renewal is explicit |
| Implies about delegation | Granting onward is natural language | A sublease is natural language |
| Fits existing vocabulary | Yes — the doc comments, `requestedGrant`, and the share-grant ledger all already say grant | No — introduces a second word for the same record |
| Fits the expiry ladder | Neutral | Better: ADR 0074's lifecycle feed already treats every deadline uniformly |
| Migration cost | None | Renames across both planes, the share ledger, audit event names, and the capability registry |

### The constraint, whichever name wins (`INV-GA-08`)

**One stored record, one ledger, one evaluation path.** A name is a label on a
screen and in a type. It may never become:

- a second table or KV namespace beside the share-grant ledger
  (`INV-GA-10` — ADR 0115 put `connection` bindings *into* that ledger for
  exactly this reason);
- a second authority model beside `Interaction` + digest-bound `ApprovalProof`
  (ADR 0086 is explicit: do not add one);
- a value-bearing object. An authority is a handle; ConnectionRef + Intent is
  the agent-facing shape (ADR 0005, `INV-GA-02`).

If both words end up in the product, they must be documented as synonyms for
one record, with one of them marked as the display term and the other as
legacy — not as two kinds of thing a user has to tell apart.

### Status

Open. `GA-O-03` is `unresolved`. The recommendation to be argued, not assumed:
keep **Grant** as the stored and typed name because the repository already
speaks it, and consider *lease* language only in copy where a deadline is the
point.

## 2. The OpenFGA model delta is additive

### Why additive and not a rewrite

`policy/openfga/model.fga` (schema 1.1) already hangs `environment`,
`connection`, `vault_collection` and `certificate_role` off `project`, and
`vault_item` inherits its reader/writer from `vault_collection`. The file's own
comments describe that row-level grain as "purely additive": a direct reader on
an item is somebody granted one row, while `reader from collection` keeps
everyone who could already read the whole collection reading it — "there is no
shape in which an item tuple grants more than the collection does".

That is the precedent. A generalized hierarchy follows it.

### The additivity contract (`INV-GA-03`)

For every check *C* and tuple set *T* valid against the baseline model:

> `check(baseline, T, C) == true` ⟹ `check(delta, T ∪ T', C) == true`

and no new relation may be the *only* thing standing between a subject and a
resource it could already reach. Concretely:

- **New types, not redefined ones.** A hierarchical authority type may be
  added; `project`, `organization`, `team`, `connection`, `vault_collection`
  and `vault_item` keep their current relation definitions.
- **New relations inherit.** A derived relation reads `or <rel> from <parent>`
  so existing reachability is preserved by construction, the way `vault_item`
  does it.
- **No relation is narrowed.** Removing a subject type from an existing
  `define` is a breaking change, not a delta, and is out of scope.
- **Direction of derivation is down.** Parent authority implies child
  authority; child authority never implies parent authority.
- **Refusal lives above the model.** A narrowing that must *deny* something is
  enforced in the domain model and host-core evaluation
  (`INV-GA-01`, `INV-GA-07`), because subtraction is not what an additive
  relation graph is for. Transitive revocation is therefore a record-state
  question resolved before or alongside the tuple check, not a tuple deletion
  we hope propagated.

### What this leaves unresolved

- Whether transitive revocation (`INV-GA-07`) can be satisfied without tuple
  deletion, and how it interacts with any tuple caching, is **unanalysed**
  (`GA-F-04`).
- The additivity property above is currently an assertion in prose. It becomes
  a claim only when `GA-F-03` builds a harness that replays baseline checks
  against the delta. Until then, no one should say the model delta is additive
  — only that it is *required* to be.

### Status

Open. `GA-F-01` … `GA-F-04` are all `unresolved`; `model.fga` is unchanged at
baseline.

## Related

- [ADR 0120](../../adr/0120-generalized-hierarchical-authority.md) — the draft decision
- [ADR 0038](../../adr/0038-project-hierarchy-sharing.md) — projects as the top-level container, and the membership model being generalized
- [ADR 0005](../../adr/0005-authority-handle-connectionref.md) — authority is a handle
- [ADR 0086](../../adr/0086-wallet-native-interaction-layer.md) — one interaction primitive; do not add a second authority model
- [ADR 0115](../../adr/0115-front-door-and-connector-directory.md) — connector binding is a local share grant, not a parallel model
- [`repository-baseline.md`](repository-baseline.md) — what was actually read, and when
