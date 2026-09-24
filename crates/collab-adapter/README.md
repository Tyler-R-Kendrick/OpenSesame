# opensesame-collab-adapter

Projects an authority onto a Discord guild's roles and channel permission
overwrites. An `OpenSesame` authority is a subject, some verbs, a scope and a
deadline; a guild has roles, overwrites and member assignments. This crate is
the translation and only the translation: it decides nothing about authority.
`plan_apply` is handed a projection somebody else already authorized and works
out the smallest set of guild changes that reflects it. Host plane; it holds a
bot credential and talks to a third party, so it is never agent-facing.

## Where it fits

- **Used by:** no workspace crate or app yet. It is exercised by its own test
  suite and by the general-authority gate (`pnpm test:authority-fabric`,
  [`scripts/test/authority-fabric-gate.mjs`](../../scripts/test/authority-fabric-gate.mjs)),
  whose scenario registry in `scripts/lib/authority-fabric-scenarios-*.mjs`
  runs `tests/apply.rs`, `tests/reconcile.rs` and `tests/rate_limit.rs`.
- **Builds on:** no other `OpenSesame` crate, deliberately — the caller maps its
  authority record (today `opensesame_domain::Grant`) into an
  `AuthorityProjection`, so the guild never becomes a second place where "does
  this narrow its parent" is answered.
- What it will not do, each held by a type rather than a check:
  1. **No user-token automation.** `BotToken` is the only credential, and its
     one accessor, `authorization_header`, prefixes `Bot `.
  2. **No admin roles.** Verbs come from the closed `Verb` catalogue with fixed
     masks; `tests/refusals.rs` asserts no verb intersects `ELEVATED`.
  3. **No removing roles it did not create.** A role is ours only when the
     registration's ledger holds its id *and* its name carries
     `OWNED_ROLE_PREFIX`; everything else goes to `Plan::untouched`.
  4. **No live traffic in the default run.** `tests/live.rs` is `#[ignore]`d.
- No timer of its own: an expiring authority is the host's to notice on the
  `lifecycle.*` feed, then call `plan_reconcile` (ADR 0074).

## Surface

| Stage | Items |
|---|---|
| Register | `registry::{AdapterRegistry, Registration, Platform, TargetSpec, DISCORD_API_BASE}` |
| Install | `portal::install_invitation` → `PortalInvitation` (the one human step) |
| Observe | `model::{ObservedGuild, ObservedMember, ObservedRole, AuthorityProjection}`; the `observe` module reads that state in one pass, including the bot's own highest role |
| Plan | `apply::plan_apply` → `Plan` of `Step`s or a `Refusal`; `reconcile::{plan_reconcile, orphaned_owned_roles, Sweep}` |
| Execute | `executor::{CollabClient, Backoff, NoBackoff, Outcome, ExecutionError}` over `transport::CollabTransport` |
| Vocabulary | `verbs::{Verb, permissions_for}`, `permissions::{Permissions, ELEVATED}`, `credential::{BotToken, CredentialKind}` |

`CollabTransport` is a trait so a host can route requests through
[`invoke-through`](../invoke-through)'s allowlist instead of its own socket.

## Develop

```bash
cargo +1.88.0 test -p opensesame-collab-adapter
pnpm test:authority-fabric
```

The default suite drives the real protocol against a loopback fixture in
`tests/support`. The live test mutates a real guild and runs only with
`OPENSESAME_DISCORD_LIVE=1` plus `OPENSESAME_DISCORD_BOT_TOKEN`,
`OPENSESAME_DISCORD_GUILD_ID`, `OPENSESAME_DISCORD_CHANNEL_ID` and
`OPENSESAME_DISCORD_SUBJECT_ID`:

```bash
cargo +1.88.0 test -p opensesame-collab-adapter --test live -- --ignored
```

## Related

- [`docs/validation/collab-adapter.md`](../../docs/validation/collab-adapter.md) — what the suite proves
- [ADR 0120](../../docs/adr/0120-generalized-hierarchical-authority.md) — generalized hierarchical authority
- [ADR 0074](../../docs/adr/0074-expiry-lifecycle-hooks.md) — deadlines belong to the lifecycle feed
