//! Every "no" this adapter can say, as a type.
//!
//! Following `crates/ceremony`'s pattern: a refusal is a value with a reason an
//! operator can read, not a bare `false` and not a generic error. The four that
//! carry the task's constraints are [`Refusal::UserCredential`],
//! [`Refusal::ElevatedPermissions`], [`Refusal::RoleNotOwned`], and
//! [`Refusal::RoleAboveBot`]; the rest exist so those four are never reached by
//! accident through a vaguer failure.

use chrono::{DateTime, Utc};
use thiserror::Error;

use crate::model::{ChannelId, GuildId, RoleId, UserId};

/// A refused collaboration-authority operation.
#[derive(Clone, Debug, PartialEq, Eq, Error)]
pub enum Refusal {
    /// A user token — an `OAuth2` access token minted for a person, or a
    /// `Bearer` credential of any kind — was offered where a bot token belongs.
    ///
    /// Driving Discord as a human account is against Discord's terms
    /// ("self-botting") and it also erases the distinction the whole product
    /// depends on: an action taken by `OpenSesame` must be attributable to
    /// `OpenSesame`, not indistinguishable from something the person did. There
    /// is no flag that turns this off.
    #[error(
        "collaboration adapters authenticate as a bot application; a user credential ({kind}) is refused"
    )]
    UserCredential { kind: &'static str },

    /// The permission set contains a bit that subsumes or rewrites the
    /// permission graph. See [`crate::permissions::ELEVATED`].
    #[error("refusing an elevated permission set: {bits}")]
    ElevatedPermissions { bits: String },

    /// Asked to modify or remove a role this adapter did not create.
    ///
    /// The single most damaging thing a reconciler can do to a real server is
    /// delete somebody's roles because they were not in its desired state. A
    /// role is only ever removed when the registration holds its id **and** its
    /// name still carries the ownership prefix.
    #[error("role {role} was not created by OpenSesame; refusing to modify or remove it")]
    RoleNotOwned { role: RoleId },

    /// Discord's role hierarchy: a bot may only act on roles strictly below its
    /// own highest position.
    #[error(
        "role {role} at position {position} is not below the bot's highest role at {bot_position}"
    )]
    RoleAboveBot {
        role: RoleId,
        position: u32,
        bot_position: u32,
    },

    /// A role Discord itself manages (a bot's own role, a booster role). Not
    /// assignable through the members API.
    #[error("role {role} is managed by an integration and cannot be assigned")]
    RoleIntegrationManaged { role: RoleId },

    /// The projection names a guild that was never registered.
    #[error("guild {guild} is not a registered target")]
    GuildNotRegistered { guild: GuildId },

    /// The projection names a channel outside the registered scope. A
    /// registration lists the channels it may write overwrites on, so a
    /// projection cannot reach a channel an operator never offered.
    #[error("channel {channel} is outside the registered scope for guild {guild}")]
    ChannelOutOfScope { channel: ChannelId, guild: GuildId },

    /// The observed member is not the projection's subject.
    #[error("observed member {observed} is not the projection's subject {expected}")]
    SubjectMismatch { expected: UserId, observed: UserId },

    /// An action string outside [`crate::verbs::Verb`]'s catalogue.
    #[error("{action} is not a collaboration verb this adapter can project")]
    UnknownVerb { action: String },

    /// A projection with no verbs. Not the same as a revocation.
    #[error("a projection with no verbs is not an empty grant; reconcile it instead")]
    NoVerbs,

    #[error("the authority is revoked")]
    AuthorityRevoked,

    #[error("the authority expired at {expired_at}")]
    AuthorityExpired { expired_at: DateTime<Utc> },

    /// A base URL that is neither `https` nor an explicit loopback address.
    ///
    /// The override exists so `tests/` can point the client at a local fixture
    /// server. It must not be able to point it at plaintext on somebody else's
    /// network.
    #[error("base url {url} is neither https nor loopback")]
    BaseUrlInsecure { url: String },

    /// A registration that names the same guild twice, or a role id recorded
    /// under two authorities.
    #[error("{what} is already registered")]
    AlreadyRegistered { what: String },
}

impl Refusal {
    /// Whether retrying could ever help.
    ///
    /// Every refusal in this enum is a statement about what was asked for, so
    /// the answer is always no. The method exists so a caller's retry loop
    /// reads as a decision rather than an omission; transport-level retries are
    /// [`crate::transport::TransportError`]'s business.
    #[must_use]
    pub const fn is_retryable(&self) -> bool {
        false
    }

    /// Build [`Refusal::ElevatedPermissions`] from the named bits.
    #[must_use]
    pub fn elevated(bits: &[&'static str]) -> Self {
        Self::ElevatedPermissions {
            bits: if bits.is_empty() {
                // The mask matched a bit this crate's vocabulary cannot name —
                // still a refusal, and saying so beats an empty list.
                "an unnamed elevated permission".to_owned()
            } else {
                bits.join(", ")
            },
        }
    }
}
