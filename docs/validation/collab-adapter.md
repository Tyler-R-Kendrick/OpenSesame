# Collaboration authority adapter — validation

`crates/collab-adapter` projects an authority onto a Discord guild's roles and
channel permission overwrites. This page records what the suite proves, how to
run it, and what it deliberately does not cover.

Swarm: **COLLAB-ADAPTER** (`COL-REGISTER`, `COL-APPLY`, `COL-RECONCILE`,
`COL-TEST`, `COL-PORTAL`), under the general-authority programme
([ADR 0120](../adr/0120-generalized-hierarchical-authority.md), Proposed).

## Commands

```bash
cargo +1.88.0 test -p opensesame-collab-adapter
cargo +1.88.0 clippy -p opensesame-collab-adapter --all-targets --all-features -- \
  -D warnings -D clippy::pedantic -D clippy::cognitive_complexity \
  -D clippy::excessive_nesting -D clippy::too_many_lines \
  -D clippy::too_many_arguments -D clippy::type_complexity
```

Result at the time of writing: **39 passed, 0 failed, 1 ignored** (the ignored
one is `tests/live.rs`), Clippy clean under the flags `pnpm audit:clippy` uses.
Every module is inside ADR 0093's 400-line budget, and
`node scripts/quality/quality-gate.mjs` reports no regression attributable to this
crate.

## The four constraints, and where each is actually enforced

| Constraint | Enforced by | Proved by |
|---|---|---|
| No user-token automation | `BotToken::from_credential` refuses every non-bot `CredentialKind`; the only way out is `authorization_header()`, which has already written `Bot `. No `Serialize`, no `as_str`, no `expose()`; `Debug` redacts. | `refusals.rs::no_user_credential_can_authenticate_this_adapter`, `registration_refuses_a_user_credential_and_a_plaintext_base_url`, `apply.rs::every_request_is_a_bot_and_every_mutation_is_explained` |
| Refuse admin roles | `Verb` is a closed catalogue with fixed masks and no raw-bitfield constructor, so `ADMINISTRATOR` is unrepresentable rather than rejected. `permissions::ELEVATED` also covers every bit that lets a holder rewrite the permission graph around it. | `refusals.rs::the_verb_catalogue_cannot_express_an_elevated_permission` (asserts `Verb::widest() & ELEVATED == 0`, so adding a dangerous verb fails), `the_elevated_mask_covers_escalation_by_the_long_route`, `portal.rs::the_bitfield_is_least_privilege` |
| Never remove a role OpenSesame did not create | `Registration::owns` requires the ledger entry **and** the `opensesame/` name prefix; `plan_reconcile` removes nothing else and records what it left in `Plan::untouched`. | `reconcile.rs::reconcile_removes_only_what_it_created`, `a_similarly_named_role_we_never_created_is_not_ours`, `a_role_a_human_renamed_away_from_us_is_left_alone`, `registry.rs::ownership_requires_the_ledger_and_the_prefix` |
| Live Discord opt-in only | `tests/live.rs` is `#[ignore]`d and additionally asserts `OPENSESAME_DISCORD_LIVE=1`. | `cargo test` reports it as `ignored`; nothing else in the crate opens a non-loopback socket |

The ownership rule is asymmetric on purpose, and the asymmetry always falls
toward leaving the guild alone. A role a person named `opensesame/…` by hand is
not ours (no ledger entry). A role we did create that a person has since
renamed is no longer ours either — they took it over. The cost of the second
case is a stale ledger row; the cost of getting it wrong the other way is
somebody's server.

## The fixture

`tests/support/` is a small **stateful** implementation of the subset of
Discord v10 the adapter uses, not a mock of the adapter's calls. It binds
`127.0.0.1:0`, is reached over real HTTP through `hyper`, and:

- serializes `permissions` / `allow` / `deny` as decimal **strings**, which is
  how Discord ships a bitfield that outgrew IEEE-754;
- returns `204 No Content` where Discord does;
- mints a fresh snowflake on role create, so a later read finds the role;
- treats a permission-overwrite `PUT` as an upsert a later channel read
  reflects, which is what makes convergence observable;
- takes a deleted role off every member, as Discord does;
- answers `404` in Discord's error shape for **any** path outside that subset,
  so calling the wrong endpoint fails a test rather than passing unnoticed.

Scripted answers cover a `429` (with the float `retry_after` in the body) and a
`403 code: 50013`.

## Protocol details the suite pins

- **Ordering.** Create/correct the role → write the channel overwrites → add
  the member, last. Reversing the last two leaves a window where the subject
  holds a role whose channel scope is not written yet; on a guild where
  `@everyone` can view channels that is a real over-grant with no trace.
  Removal is the mirror: unassign, then delete.
- **Retries.** Only `429` is retried, because Discord rejects a rate-limited
  request before handling it, so re-sending cannot double-apply — even a
  `POST`. A `5xx` may have been applied and the answer lost, so it is surfaced;
  retrying a role create is how a guild fills with duplicates against a 250-role
  cap.
- **Convergence.** `observe` reads each in-scope channel's overwrites so a
  re-apply plans nothing. Without that read the plan would be idempotent on the
  wire but not in its steps, re-sending every overwrite for every authority each
  cycle, on the routes Discord rate-limits hardest.
- **Hierarchy.** The bot's ceiling is derived from its own roles' positions, not
  configured — a configured position goes stale the first time somebody drags a
  role in the Discord UI, and the planner would then approve a mutation the API
  refuses with an unexplained `50013`.
- **Overwrite type.** Always `0` (role). Type `1` would attach an authority
  directly to a person, leaving nothing named in the role list to revoke.
- **Audit reason.** Every mutation carries `X-Audit-Log-Reason` naming the
  authority handle, so a guild operator can answer "why does this person have
  this role" from their own audit log.

## The portal

`portal::install_invitation` builds the bot-install URL and cannot complete the
flow — installing an application is a human act in a browser session OpenSesame
does not hold. It requests `scope=bot` (plus `applications.commands` only when a
verb needs it), `integration_type=0` to pin the guild install context, and no
`response_type` or `redirect_uri`: a code exchange would be asking for a grant
on the installer's behalf, which is the user-token road under another name.

## Not covered

- **No gateway route, CLI verb, or PWA action.** This is a library. Nothing here
  needs a `packages/capability-registry` entry yet ([ADR 0065](../adr/0065-agent-surface-parity.md));
  the surface that exposes it will.
- **No egress wiring.** `CollabTransport` is a trait so a host can route through
  `crates/invoke-through`'s allowlist. The crate ships no default client.
- **No timer.** `expires_at` is checked at plan time, which catches an expired
  authority but does not notice one expiring. Publishing on the `lifecycle.*`
  feed and calling `plan_reconcile` is the host's job
  ([ADR 0074](../adr/0074-expiry-lifecycle-hooks.md)) — a subsystem with a
  private due-check is what that ADR forbids.
- **No dependency on the authority record.** The crate depends on no other
  OpenSesame crate. The caller maps its authority (`opensesame_domain::Grant`
  today: `actions` → `AuthorityProjection::verbs_from_actions`, beneficiary →
  subject, `constraints.expires_at` → `expires_at`) and this crate projects it.
  That mapping is unwritten, and it is the integration point a reviewer should
  look at next.
- **Discord's own drift.** A fixture proves the adapter is self-consistent, not
  that Discord agrees with it. Only `tests/live.rs` can catch a renamed field or
  a re-versioned route, and it is opt-in.
