//! Collaboration-platform authority adapter — project an authority onto a
//! Discord guild's roles and channel overwrites.
//!
//! An authority in `OpenSesame` is a handle: a subject, some verbs, a scope, a
//! deadline (ADR 0005). A collaboration platform has its own vocabulary for the
//! same idea — a role, a channel permission overwrite, a member assignment. This
//! crate is the translation, and only the translation. It decides nothing about
//! authority: `plan_apply` is handed a projection somebody else already
//! authorized, and its whole job is to work out the smallest set of guild
//! changes that reflects it.
//!
//! # The four things it will not do
//!
//! These are the constraints the crate exists to hold, and each is structural
//! rather than a check that could be skipped:
//!
//! 1. **No user-token automation.** [`credential::BotToken`] is the only
//!    credential type, it is constructible only from
//!    [`credential::CredentialKind::BotToken`], and the single way to get its
//!    bytes out is [`credential::BotToken::authorization_header`] — which has
//!    already written `Bot ` in front of them. There is no `Bearer` path, so
//!    there is no self-botting path. Driving a person's account would also
//!    breach Discord's terms and make `OpenSesame`'s actions indistinguishable
//!    from theirs.
//! 2. **No admin roles.** A projection names verbs from [`verbs::Verb`], a
//!    closed catalogue with fixed permission masks, and no constructor accepts a
//!    raw bitfield. [`permissions::ELEVATED`] covers `ADMINISTRATOR` and every
//!    bit that lets a holder rewrite the permission graph around it;
//!    `tests/refusals.rs` asserts that the union of every verb never intersects
//!    it, so adding a dangerous verb fails a test rather than shipping.
//! 3. **No removing roles `OpenSesame` did not create.** A role is ours only when
//!    the registration's ledger holds its id **and** its name still carries
//!    [`model::OWNED_ROLE_PREFIX`]. Everything else on the member goes into
//!    [`plan::Plan::untouched`] and stays exactly where it was. See
//!    [`registry`] for why both halves, and why the asymmetry always falls
//!    toward leaving the guild alone.
//! 4. **No live traffic in the default test run.** The suite drives the real
//!    protocol against a loopback fixture (`tests/support`). `tests/live.rs`
//!    talks to Discord and is `#[ignore]`d behind explicit environment
//!    variables.
//!
//! # Shape
//!
//! Planning is pure and separate from sending, which is what makes the
//! interesting claims testable without a server:
//!
//! ```text
//!   registry::Registration        what an operator offered      (COL-REGISTER)
//!   portal::install_invitation    the one human step            (COL-PORTAL)
//!   observe / ObservedGuild       what the guild says it is
//!   apply::plan_apply             ordered steps, or a refusal    (COL-APPLY)
//!   reconcile::plan_reconcile     removals, ours only        (COL-RECONCILE)
//!   executor::CollabClient        the steps, over a transport
//! ```
//!
//! # Where this sits
//!
//! Host plane, alongside `crates/rotation-web` and `crates/ceremony`: it holds a
//! bot credential and talks to a third party, so it is never agent-facing. It
//! depends on no other `OpenSesame` crate. That is deliberate — the authority
//! decision is upstream, and a guild projection must never become the second
//! place where "does this narrow its parent" gets answered. The caller maps its
//! authority record (`opensesame_domain::Grant` today: `actions` →
//! [`model::AuthorityProjection::verbs_from_actions`], `beneficiary` → subject,
//! `constraints.expires_at` → `expires_at`) and this crate takes it from there.
//!
//! Two integration seams are left open on purpose, for whoever wires this into a
//! running host:
//!
//! - **Egress.** [`transport::CollabTransport`] is a trait so the gateway can
//!   route requests through `crates/invoke-through`'s allowlist instead of
//!   opening its own socket.
//! - **Deadlines.** [`model::AuthorityProjection::expires_at`] is checked at
//!   plan time, which catches an expired authority but does not *notice* one
//!   expiring. Publishing on the `lifecycle.*` feed and calling
//!   [`reconcile::plan_reconcile`] is the host's job, per ADR 0074: this crate
//!   deliberately has no timer of its own, because a subsystem with a private
//!   due-check is the thing that ADR forbids.

pub mod apply;
pub mod credential;
pub mod executor;
pub mod model;
pub mod observe;
pub mod permissions;
pub mod plan;
pub mod portal;
pub mod reconcile;
pub mod refusal;
pub mod registry;
pub mod transport;
pub mod verbs;
pub mod wire;

pub use apply::plan_apply;
pub use credential::{BotToken, CredentialKind};
pub use executor::{Backoff, CollabClient, ExecutionError, NoBackoff, Outcome};
pub use model::{
    ApplicationId, AuthorityProjection, ChannelId, GuildId, ObservedGuild, ObservedMember,
    ObservedRole, RoleId, UserId, OWNED_ROLE_PREFIX,
};
pub use permissions::{Permissions, ELEVATED};
pub use plan::{audit_reason, Plan, RoleTarget, Step};
pub use portal::{install_invitation, PortalInvitation};
pub use reconcile::{orphaned_owned_roles, plan_reconcile, Sweep};
pub use refusal::Refusal;
pub use registry::{AdapterRegistry, Platform, Registration, TargetSpec, DISCORD_API_BASE};
pub use transport::{CollabTransport, Method, TransportError, WireRequest, WireResponse};
pub use verbs::{permissions_for, Verb};
