//! SBOX-PROFILE — the execution profile, derived from a validated chain.
//!
//! A [`SandboxProfile`] is the sandbox's half of an authority decision: it
//! says what a run may reach and what it may consume. It exists in exactly
//! one way, [`SandboxProfile::from_grant_chain`], which takes an
//! [`opensesame_domain::ValidatedGrantChain`] — the in-process proof that a
//! lineage is rooted, unrevoked, in-window and attenuating. There is no
//! `Default`, no public constructor, no `Deserialize`: a profile cannot be
//! assembled by a caller who merely wishes it were authorized, and a wire
//! round-trip cannot recreate one.
//!
//! Two properties are load-bearing:
//!
//! - **Ambient authority is denied structurally.** [`AmbientDenial`] has no
//!   constructor that produces a `false` anywhere, because the denial is not
//!   a setting — it is a restatement of the fact that the brokered import
//!   module contains no file, socket, environment, clock or entropy
//!   function to link. The struct exists so a receipt can say it out loud.
//! - **Every dimension narrows.** Capabilities are the intersection of the
//!   whole chain's actions, budgets are the componentwise minimum of the
//!   whole chain's budgets against the platform ceiling, and the deadline is
//!   further clamped to the time actually left on the authority.

use std::collections::BTreeSet;
use std::time::Duration;

use chrono::{DateTime, Utc};
use opensesame_domain::{Grant, GrantId, OrganizationId, ValidatedGrantChain};

use crate::budget::ResourceBudget;
use crate::capability::{AmbientKind, BrokeredCapability};
use crate::error::SandboxError;

/// The ambient surfaces a sandboxed run cannot reach, stated for the record.
///
/// Deliberately not a record of toggles. A struct of six booleans would
/// invite somebody to set one, and there is nothing to set: the brokered
/// import module contains no filesystem, environment, socket, clock,
/// entropy or process function, so every surface is denied by there being
/// nothing to link. This type is a witness a receipt can carry, and
/// [`AmbientDenial::denies`] answers `true` for every [`AmbientKind`] there
/// is — including [`AmbientKind::Unclassified`], because a surface nobody
/// named is refused too.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AmbientDenial;

impl AmbientDenial {
    /// The only value this type has.
    pub const TOTAL: Self = Self;

    /// Whether `kind` is out of reach. Always `true`.
    ///
    /// Kept as a method rather than a constant so the claim is checked
    /// against [`AmbientKind`] itself: adding a surface to that enum and
    /// forgetting it here is caught by [`Self::is_total`].
    #[must_use]
    pub const fn denies(self, kind: AmbientKind) -> bool {
        match kind {
            AmbientKind::Filesystem
            | AmbientKind::Environment
            | AmbientKind::Network
            | AmbientKind::Clock
            | AmbientKind::Randomness
            | AmbientKind::Process
            | AmbientKind::Unclassified => true,
        }
    }

    /// Whether every ambient surface is denied.
    #[must_use]
    pub fn is_total(self) -> bool {
        AmbientKind::ALL.into_iter().all(|kind| self.denies(kind))
    }
}

/// What one sandboxed run may reach and consume.
#[derive(Clone, Debug)]
pub struct SandboxProfile {
    budget: ResourceBudget,
    capabilities: BTreeSet<BrokeredCapability>,
    organization_id: OrganizationId,
    root_grant_id: GrantId,
    leaf_grant_id: GrantId,
    invalidation_generation: u64,
    expires_at: DateTime<Utc>,
}

impl SandboxProfile {
    /// Derive a profile from a validated chain, as of `now`.
    ///
    /// # Errors
    ///
    /// Returns [`SandboxError::RawExportDenied`] when any hop permits raw
    /// credential export — a sandbox never materializes a secret, so such a
    /// grant is refused rather than quietly downgraded. Returns
    /// [`SandboxError::Profile`] when the chain leaves no runnable budget:
    /// a malformed budget value, or an authority with no time left on it.
    pub fn from_grant_chain(
        chain: &ValidatedGrantChain,
        now: DateTime<Utc>,
    ) -> Result<Self, SandboxError> {
        let grants = chain.grants();
        if grants.iter().any(|g| g.constraints.raw_credential_export) {
            return Err(SandboxError::RawExportDenied);
        }
        let budget = fold_budgets(grants)?;
        let expires_at = earliest_expiry(grants);
        let remaining = remaining_from(now, expires_at)?;
        let budget = budget.clamped_to_remaining(remaining);
        if !budget.is_runnable() {
            return Err(SandboxError::Profile(
                "chain leaves no runnable budget".into(),
            ));
        }
        Ok(Self {
            budget,
            capabilities: intersect_capabilities(grants),
            organization_id: chain.organization_id(),
            root_grant_id: chain.root_id(),
            leaf_grant_id: chain.leaf_id(),
            invalidation_generation: chain.invalidation_generation(),
            expires_at,
        })
    }

    /// What this run may consume.
    #[must_use]
    pub const fn budget(&self) -> ResourceBudget {
        self.budget
    }

    /// The brokered functions that will be linked, and no others.
    #[must_use]
    pub const fn capabilities(&self) -> &BTreeSet<BrokeredCapability> {
        &self.capabilities
    }

    /// Whether a capability is in this profile.
    #[must_use]
    pub fn grants(&self, capability: BrokeredCapability) -> bool {
        self.capabilities.contains(&capability)
    }

    /// The ambient surfaces this profile denies — all of them, always.
    #[must_use]
    pub const fn ambient_denial(&self) -> AmbientDenial {
        AmbientDenial::TOTAL
    }

    /// The tenant this run belongs to.
    #[must_use]
    pub const fn organization_id(&self) -> OrganizationId {
        self.organization_id
    }

    /// The chain root that ultimately authorized the run.
    #[must_use]
    pub const fn root_grant_id(&self) -> GrantId {
        self.root_grant_id
    }

    /// The leaf grant the run is bound to.
    #[must_use]
    pub const fn leaf_grant_id(&self) -> GrantId {
        self.leaf_grant_id
    }

    /// The revocation generation this profile was minted against.
    #[must_use]
    pub const fn invalidation_generation(&self) -> u64 {
        self.invalidation_generation
    }

    /// When the authority behind this profile runs out.
    #[must_use]
    pub const fn expires_at(&self) -> DateTime<Utc> {
        self.expires_at
    }

    /// Re-check that this profile still describes the chain presented.
    ///
    /// A profile is cheap to hold and a chain is re-validated often; this is
    /// how a caller proves the two are still the same authority rather than
    /// trusting that nobody swapped one.
    #[must_use]
    pub fn binds_chain(&self, chain: &ValidatedGrantChain) -> bool {
        self.leaf_grant_id == chain.leaf_id()
            && self.root_grant_id == chain.root_id()
            && self.organization_id == chain.organization_id()
            && self.invalidation_generation == chain.invalidation_generation()
    }
}

fn fold_budgets(grants: &[Grant]) -> Result<ResourceBudget, SandboxError> {
    let mut folded = ResourceBudget::CEILING;
    for grant in grants {
        folded = folded.narrowed_to(ResourceBudget::from_grant_budgets(
            &grant.constraints.budgets,
        )?);
    }
    Ok(folded)
}

fn earliest_expiry(grants: &[Grant]) -> DateTime<Utc> {
    grants
        .iter()
        .map(|g| g.constraints.expires_at)
        .min()
        // SAFETY: ValidatedGrantChain rejects empty chains, so `min` over a
        // validated chain always yields a value.
        .unwrap_or_else(Utc::now)
}

fn remaining_from(now: DateTime<Utc>, expires_at: DateTime<Utc>) -> Result<Duration, SandboxError> {
    (expires_at - now)
        .to_std()
        .map_err(|_| SandboxError::Profile("authority has no time left on it".into()))
}

/// The capabilities every hop agrees on.
///
/// Attenuation already guarantees the leaf's actions are a subset of its
/// parent's, so the intersection equals the leaf's set. Computing it anyway
/// costs nothing and means a future change to attenuation cannot silently
/// widen what a sandbox can reach.
fn intersect_capabilities(grants: &[Grant]) -> BTreeSet<BrokeredCapability> {
    BrokeredCapability::ALL
        .into_iter()
        .filter(|capability| {
            grants
                .iter()
                .all(|grant| grant.actions.iter().any(|a| a == capability.action()))
        })
        .collect()
}

#[cfg(test)]
mod tests;
