//! COL-REGISTER — what an operator has offered, and the ownership ledger the
//! reconciler is allowed to act on.
//!
//! A [`Registration`] is the answer to "which guild, which channels, which bot,
//! and which roles are ours". Nothing outside it is reachable: a projection
//! naming an unregistered guild or an out-of-scope channel is refused before a
//! request is formed, so the blast radius of this adapter is exactly what
//! somebody typed in.
//!
//! ## The ownership rule
//!
//! [`Registration::owns`] requires **both** halves:
//!
//! 1. the role id appears in this registration's ledger, and
//! 2. the role's current name still starts with
//!    [`crate::model::OWNED_ROLE_PREFIX`].
//!
//! Requiring both is asymmetric on purpose, and the asymmetry always falls
//! toward leaving the guild alone. A role a person happened to name
//! `opensesame/moderators` is not ours, because it is not in the ledger. And a
//! role we *did* create that a person has since renamed is no longer ours
//! either — they took it over, and a reconciler that deleted it would be
//! overruling them. The cost of the second case is a stale ledger entry; the
//! cost of getting it wrong the other way is somebody's server.
//!
//! A [`Registration`] holds no credential. The bot token lives with the
//! transport ([`crate::credential::BotToken`]), so a registration can be
//! persisted, logged, or diffed without carrying a secret.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use url::Url;

use crate::credential::CredentialKind;
use crate::model::{ApplicationId, ChannelId, GuildId, ObservedRole, RoleId};
use crate::refusal::Refusal;

/// Discord's REST base. Versioned explicitly: an unversioned Discord path is a
/// moving target.
pub const DISCORD_API_BASE: &str = "https://discord.com/api/v10";

/// The collaboration platforms this crate can register.
///
/// One variant today. It exists so a second platform is a variant and a wire
/// module, rather than a second copy of the registry, the ownership rule, and
/// the reconciler.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Platform {
    Discord,
}

/// What an operator supplies to register a guild.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TargetSpec {
    pub platform: Platform,
    pub guild: GuildId,
    pub application: ApplicationId,
    /// The channels this registration may write permission overwrites on.
    pub channels: Vec<ChannelId>,
    /// The kind of credential the operator holds. Checked here so the refusal
    /// lands at registration — when a person is present to read it — rather
    /// than at the first apply.
    pub credential_kind: CredentialKind,
    /// Overridden only to point tests at a loopback fixture. `None` means
    /// [`DISCORD_API_BASE`].
    pub base_url: Option<String>,
}

/// A registered guild: its scope, and the roles this adapter created in it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Registration {
    platform: Platform,
    guild: GuildId,
    application: ApplicationId,
    channels: BTreeSet<ChannelId>,
    base_url: String,
    /// Role id → the authority handle that role exists for.
    owned_roles: BTreeMap<RoleId, String>,
}

impl Registration {
    /// # Errors
    ///
    /// [`Refusal::UserCredential`] for a non-bot credential, and
    /// [`Refusal::BaseUrlInsecure`] for a base URL that is neither `https` nor
    /// loopback.
    pub fn register(spec: TargetSpec) -> Result<Self, Refusal> {
        spec.credential_kind.assert_bot()?;
        let base_url = spec.base_url.unwrap_or_else(|| DISCORD_API_BASE.to_owned());
        assert_transport_secure(&base_url)?;
        Ok(Self {
            platform: spec.platform,
            guild: spec.guild,
            application: spec.application,
            channels: spec.channels.into_iter().collect(),
            base_url,
            owned_roles: BTreeMap::new(),
        })
    }

    #[must_use]
    pub const fn platform(&self) -> Platform {
        self.platform
    }

    #[must_use]
    pub const fn guild(&self) -> &GuildId {
        &self.guild
    }

    #[must_use]
    pub const fn application(&self) -> &ApplicationId {
        &self.application
    }

    #[must_use]
    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    /// The role ids this registration created, and the authority each belongs
    /// to.
    #[must_use]
    pub const fn owned_roles(&self) -> &BTreeMap<RoleId, String> {
        &self.owned_roles
    }

    /// Record a role this adapter created. Called after a create succeeds, so
    /// the ledger never claims a role that does not exist.
    ///
    /// # Errors
    ///
    /// [`Refusal::AlreadyRegistered`] when the id is already recorded under a
    /// different authority — a collision that would let one authority's
    /// reconcile delete another's role.
    pub fn record_owned_role(
        &mut self,
        role: RoleId,
        authority_id: impl Into<String>,
    ) -> Result<(), Refusal> {
        let authority_id = authority_id.into();
        if let Some(existing) = self.owned_roles.get(&role) {
            if existing != &authority_id {
                return Err(Refusal::AlreadyRegistered {
                    what: format!("role {role} (held by authority {existing})"),
                });
            }
            return Ok(());
        }
        self.owned_roles.insert(role, authority_id);
        Ok(())
    }

    /// Forget a role after it has been deleted upstream.
    pub fn forget_owned_role(&mut self, role: &RoleId) {
        self.owned_roles.remove(role);
    }

    /// Whether this adapter owns `role` — the two-part rule in the module docs.
    #[must_use]
    pub fn owns(&self, role: &ObservedRole) -> bool {
        self.owned_roles.contains_key(&role.id) && role.name_claims_ownership()
    }

    /// # Errors
    ///
    /// [`Refusal::RoleNotOwned`] when [`Registration::owns`] is false.
    pub fn assert_owns(&self, role: &ObservedRole) -> Result<(), Refusal> {
        if self.owns(role) {
            return Ok(());
        }
        Err(Refusal::RoleNotOwned {
            role: role.id.clone(),
        })
    }

    /// # Errors
    ///
    /// [`Refusal::ChannelOutOfScope`] for a channel the operator did not offer.
    pub fn assert_channel_in_scope(&self, channel: &ChannelId) -> Result<(), Refusal> {
        if self.channels.contains(channel) {
            return Ok(());
        }
        Err(Refusal::ChannelOutOfScope {
            channel: channel.clone(),
            guild: self.guild.clone(),
        })
    }

    #[must_use]
    pub const fn channels(&self) -> &BTreeSet<ChannelId> {
        &self.channels
    }
}

/// The registered targets, keyed by guild.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AdapterRegistry {
    targets: BTreeMap<GuildId, Registration>,
}

impl AdapterRegistry {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// # Errors
    ///
    /// [`Refusal::AlreadyRegistered`] when the guild is already registered.
    /// Re-registering would silently discard the ownership ledger, and a
    /// reconciler with an empty ledger owns nothing — which reads as "delete
    /// nothing" here, but would read as "recreate everything" to the apply
    /// path.
    pub fn register(&mut self, registration: Registration) -> Result<(), Refusal> {
        let guild = registration.guild().clone();
        if self.targets.contains_key(&guild) {
            return Err(Refusal::AlreadyRegistered {
                what: format!("guild {guild}"),
            });
        }
        self.targets.insert(guild, registration);
        Ok(())
    }

    /// # Errors
    ///
    /// [`Refusal::GuildNotRegistered`] when the guild was never registered.
    pub fn target(&self, guild: &GuildId) -> Result<&Registration, Refusal> {
        self.targets
            .get(guild)
            .ok_or_else(|| Refusal::GuildNotRegistered {
                guild: guild.clone(),
            })
    }

    /// # Errors
    ///
    /// [`Refusal::GuildNotRegistered`] when the guild was never registered.
    pub fn target_mut(&mut self, guild: &GuildId) -> Result<&mut Registration, Refusal> {
        self.targets
            .get_mut(guild)
            .ok_or_else(|| Refusal::GuildNotRegistered {
                guild: guild.clone(),
            })
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.targets.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.targets.is_empty()
    }
}

/// `https`, or an explicit loopback host for the fixture suite.
///
/// # Errors
///
/// [`Refusal::BaseUrlInsecure`] otherwise.
fn assert_transport_secure(base_url: &str) -> Result<(), Refusal> {
    let insecure = || Refusal::BaseUrlInsecure {
        url: base_url.to_owned(),
    };
    let parsed = Url::parse(base_url).map_err(|_| insecure())?;
    let loopback = matches!(parsed.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"));
    if parsed.scheme() == "https" || (parsed.scheme() == "http" && loopback) {
        return Ok(());
    }
    Err(insecure())
}
