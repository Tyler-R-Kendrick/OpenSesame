//! Snowflake handles, observed guild state, and the projection this adapter
//! consumes.
//!
//! ## What a projection is, and what it is not
//!
//! [`AuthorityProjection`] is not an authority record and this crate does not
//! introduce a second authority model. It is the *output* of a decision the
//! host plane already made — today `opensesame_domain::Grant` (subject, verbs,
//! `expires_at`, `revoked_at`), later the generalized authority record — stated
//! in the vocabulary a collaboration platform can act on. The mapping lives
//! with the caller that holds the authority; this crate deliberately does not
//! depend on the domain crate, so a guild projection can never become the
//! place where "does this widen its parent" gets answered a second time.
//!
//! Every field below is metadata. There is no field able to hold a token, a
//! password, or a bot secret — `tests/refusals.rs` asserts that over the
//! serialized form, the same way `crates/grants` does for `Grant`.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::permissions::Permissions;
use crate::refusal::Refusal;
use crate::verbs::Verb;

/// The prefix every role this adapter creates carries in its name.
///
/// This is half of the ownership proof (see [`crate::registry`]). It is visible
/// to a human scrolling the guild's role list, which matters: somebody looking
/// at a server should be able to tell which roles came from `OpenSesame`
/// without consulting `OpenSesame`.
pub const OWNED_ROLE_PREFIX: &str = "opensesame/";

macro_rules! snowflake {
    ($($name:ident, $what:literal;)+) => {
        $(
            #[doc = concat!("A Discord ", $what, " id (a snowflake, carried as a string because it exceeds 2^53).")]
            #[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
            #[serde(transparent)]
            pub struct $name(String);

            impl $name {
                #[must_use]
                pub fn new(id: impl Into<String>) -> Self {
                    Self(id.into())
                }

                #[must_use]
                pub fn as_str(&self) -> &str {
                    &self.0
                }
            }

            impl std::fmt::Display for $name {
                fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                    f.write_str(&self.0)
                }
            }
        )+
    };
}

snowflake! {
    GuildId, "guild";
    RoleId, "role";
    ChannelId, "channel";
    UserId, "user";
    ApplicationId, "application";
}

/// A role as the guild currently reports it.
///
/// `integration_managed` is Discord's own `managed` flag — true for a role a
/// bot or a Nitro boost owns. Such a role cannot be assigned through the
/// members API at all, so it is refused early with a reason rather than
/// surfacing as an opaque 403 mid-plan.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ObservedRole {
    pub id: RoleId,
    pub name: String,
    pub permissions: Permissions,
    /// Higher is more senior. A bot may only touch roles strictly below its
    /// own highest position.
    pub position: u32,
    #[serde(rename = "managed", default)]
    pub integration_managed: bool,
}

impl ObservedRole {
    /// Whether the role's *name* claims `OpenSesame` ownership.
    ///
    /// Necessary but not sufficient: [`crate::registry::Registration::owns`]
    /// also requires the id on record. A role a person named
    /// `opensesame/anything` by hand is not managed by us and is never removed.
    #[must_use]
    pub fn name_claims_ownership(&self) -> bool {
        self.name.starts_with(OWNED_ROLE_PREFIX)
    }
}

/// The guild member this projection is about, as the guild currently reports
/// them.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ObservedMember {
    pub user: UserId,
    pub roles: Vec<RoleId>,
}

/// One entry in a channel's permission overwrite list.
///
/// `kind` is Discord's discriminator: `0` for a role, `1` for a member. This
/// adapter only ever writes `0`, and only reads `0` when deciding whether an
/// overwrite already says what it wants — a member overwrite somebody else
/// configured is none of its business.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ObservedOverwrite {
    /// The role or member the overwrite targets.
    pub target: RoleId,
    pub kind: u8,
    pub allow: Permissions,
    pub deny: Permissions,
}

impl ObservedOverwrite {
    /// The overwrite `type` for a role.
    pub const KIND_ROLE: u8 = 0;

    #[must_use]
    pub const fn is_role(&self) -> bool {
        self.kind == Self::KIND_ROLE
    }
}

/// A channel in the registration's scope, and its overwrites.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ObservedChannel {
    pub id: ChannelId,
    pub overwrites: Vec<ObservedOverwrite>,
}

impl ObservedChannel {
    /// The role overwrite for `role`, if there is one.
    #[must_use]
    pub fn role_overwrite(&self, role: &RoleId) -> Option<&ObservedOverwrite> {
        self.overwrites
            .iter()
            .find(|overwrite| overwrite.is_role() && &overwrite.target == role)
    }
}

/// Everything a plan needs to read before it decides anything.
///
/// Read in one pass and passed in whole, so planning is a pure function of
/// observed state — which is what makes `tests/reconcile.rs` able to assert
/// "an unmanaged role survives" without a server at all.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ObservedGuild {
    pub guild: GuildId,
    pub roles: Vec<ObservedRole>,
    /// The registered in-scope channels. Read so a re-apply can tell that an
    /// overwrite already says what it wants: without this, every reconciliation
    /// cycle re-`PUT`s every overwrite for every authority, which is exactly the
    /// rate-limit pressure the rest of the crate works to avoid.
    pub channels: Vec<ObservedChannel>,
    pub member: ObservedMember,
    /// The highest `position` the bot's own roles hold. Discord refuses any
    /// mutation of a role at or above it, so planning refuses first and names
    /// the reason.
    pub bot_highest_position: u32,
}

impl ObservedGuild {
    #[must_use]
    pub fn role(&self, id: &RoleId) -> Option<&ObservedRole> {
        self.roles.iter().find(|role| &role.id == id)
    }

    #[must_use]
    pub fn role_named(&self, name: &str) -> Option<&ObservedRole> {
        self.roles.iter().find(|role| role.name == name)
    }

    #[must_use]
    pub fn channel(&self, id: &ChannelId) -> Option<&ObservedChannel> {
        self.channels.iter().find(|channel| &channel.id == id)
    }
}

/// An authority, restated as something a guild can be asked to reflect.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuthorityProjection {
    /// The authority's handle. An identifier, never a value (ADR 0005).
    pub authority_id: String,
    pub subject: UserId,
    pub guild: GuildId,
    /// The channels the verbs apply to. Empty means guild-wide, which this
    /// adapter allows only because a role must exist somewhere; the role it
    /// creates still carries nothing but the verb bits.
    pub channels: Vec<ChannelId>,
    pub verbs: Vec<Verb>,
    pub expires_at: DateTime<Utc>,
    pub revoked: bool,
}

impl AuthorityProjection {
    /// Resolve an authority's dotted action strings into verbs.
    ///
    /// # Errors
    ///
    /// [`Refusal::UnknownVerb`] for an action outside the catalogue, and
    /// [`Refusal::NoVerbs`] for an empty list. Both are refusals rather than
    /// filters: dropping an action the caller asked for and reporting success
    /// is how a projection ends up narrower than the audit trail claims — or,
    /// worse, how `guild.administrate` gets quietly ignored instead of
    /// answered.
    pub fn verbs_from_actions(actions: &[String]) -> Result<Vec<Verb>, Refusal> {
        if actions.is_empty() {
            return Err(Refusal::NoVerbs);
        }
        let mut verbs = actions
            .iter()
            .map(|action| {
                Verb::parse(action).ok_or_else(|| Refusal::UnknownVerb {
                    action: action.clone(),
                })
            })
            .collect::<Result<Vec<_>, _>>()?;
        verbs.sort_unstable();
        verbs.dedup();
        Ok(verbs)
    }

    /// The role name this projection's authority owns.
    ///
    /// Derived from the authority handle so the mapping is one-to-one and
    /// re-running a projection finds its own role instead of creating a second
    /// one.
    #[must_use]
    pub fn owned_role_name(&self) -> String {
        format!("{OWNED_ROLE_PREFIX}{}", self.authority_id)
    }

    /// Whether the projection is still live at `now`.
    ///
    /// # Errors
    ///
    /// [`Refusal::AuthorityRevoked`] or [`Refusal::AuthorityExpired`]. A dead
    /// authority is not an empty apply — it is a reconcile, which the caller
    /// must ask for by name.
    pub fn assert_live(&self, now: DateTime<Utc>) -> Result<(), Refusal> {
        if self.revoked {
            return Err(Refusal::AuthorityRevoked);
        }
        if now >= self.expires_at {
            return Err(Refusal::AuthorityExpired {
                expired_at: self.expires_at,
            });
        }
        Ok(())
    }
}
