//! The enforcement fence on the grant path: refuse, never degrade.
//!
//! A grant states terms somebody will later try to hold — a deadline, a
//! revocation, a boundary. Whether they *can* be held is a property of the
//! platform the subject runs on, and `opensesame_enforcement` answers that
//! dimension by dimension. This module is the only place the two meet: it
//! projects a domain [`Grant`] onto [`GrantTerms`], derives the demands its own
//! constraints make, and puts them through
//! [`preflight`](opensesame_enforcement::preflight).
//!
//! The load-bearing property is that a shortfall is an error and not a
//! narrower grant. The tempting alternative — issue it anyway with isolation
//! dropped, or with the revocation demand quietly relaxed — produces authority
//! whose terms read as kept and are not, and nothing downstream can tell the
//! difference. So there is no function here that returns a weakened
//! `Requirements`, and the only outcomes are an [`Admitted`] naming the
//! guarantees relied on and an [`EnforcementRefused`] naming every gap.
//!
//! The projection lives on this side of the boundary on purpose: the
//! enforcement crate takes no dependency on the domain model, so a descriptor
//! and a refusal stay reasonable without dragging authorization in behind them.
//! `offline_use_projects_every_domain_variant` is what holds the two enums
//! together when one of them grows a variant.

use crate::{authorize_authority_use, AuthorityDecision, AuthorityUse, AuthzError, PolicyEngine};
use opensesame_domain::{Grant, InvokeLevel, OfflineUse};
use opensesame_enforcement::{
    preflight, requirements_for, Admitted, EnforcementDescriptor, GrantTerms,
    OfflineUse as EnforcedOfflineUse, Refusal, Requirements, SubjectSurface,
};
use thiserror::Error;

/// A grant whose terms the platform in front of it cannot hold.
#[derive(Clone, Debug, PartialEq, Eq, Error)]
pub enum EnforcementRefused {
    /// At least one dimension fell short. Carries the whole bill, including
    /// the platform's own reason where nothing enforces the dimension at all.
    #[error(transparent)]
    CannotHold(#[from] Refusal),
    /// The descriptor describes a different surface than the one this use runs
    /// on. Judging a materialization against the broker's own guarantees would
    /// admit it on the strength of a call path that is no longer taken, so the
    /// mismatch is refused rather than resolved in either direction.
    #[error(
        "`{platform}` describes `{}`, but this use runs on `{}`",
        described.as_str(),
        running_on.as_str()
    )]
    SurfaceMismatch {
        /// The platform whose descriptor was offered.
        platform: &'static str,
        /// The surface that descriptor speaks for.
        described: SubjectSurface,
        /// The surface the use actually runs on.
        running_on: SubjectSurface,
    },
    /// No catalogued descriptor uses this name. Missing is not a cue to fall
    /// back to the host broker: that would issue a grant for a surface nobody
    /// described.
    #[error("unknown enforcement platform `{0}`")]
    UnknownPlatform(String),
    /// The catalog failed its own audit, so nothing can be judged.
    #[error("enforcement catalog is not loadable")]
    CatalogUnusable,
}

impl From<EnforcementRefused> for AuthzError {
    fn from(refused: EnforcementRefused) -> Self {
        Self::EnforcementUnavailable(refused)
    }
}

/// The part of a grant that decides what the platform must hold.
#[must_use]
pub fn terms_of(grant: &Grant) -> GrantTerms {
    GrantTerms {
        offline_use: match grant.constraints.offline_use {
            OfflineUse::Forbidden => EnforcedOfflineUse::Forbidden,
            OfflineUse::ReadOnly => EnforcedOfflineUse::ReadOnly,
            OfflineUse::PreAuthorized => EnforcedOfflineUse::PreAuthorized,
        },
        raw_credential_export: grant.constraints.raw_credential_export,
    }
}

/// The enforcement this grant's own constraints demand.
///
/// Public so a deployment can *tighten* a dimension before calling
/// [`admit`] — a latency ceiling on the call path, say. There is deliberately
/// no helper for loosening one.
#[must_use]
pub fn requirements_for_grant(grant: &Grant) -> Requirements {
    requirements_for(terms_of(grant))
}

/// Judge a stated set of demands against what a platform holds.
///
/// # Errors
///
/// [`EnforcementRefused::CannotHold`] listing every unmet demand. All
/// dimensions are judged before returning, so an operator sees the whole gap
/// rather than the first one.
pub fn admit(
    requirements: &Requirements,
    descriptor: &EnforcementDescriptor,
) -> Result<Admitted, EnforcementRefused> {
    preflight(requirements, descriptor).map_err(EnforcementRefused::CannotHold)
}

/// Judge a grant against the platform it will be issued onto.
///
/// # Errors
///
/// [`EnforcementRefused::CannotHold`] naming every dimension the platform
/// cannot hold to the grant's terms.
pub fn admit_grant(
    grant: &Grant,
    descriptor: &EnforcementDescriptor,
) -> Result<Admitted, EnforcementRefused> {
    admit(&requirements_for_grant(grant), descriptor)
}

/// The surface a use at this invoke level actually runs on.
///
/// Materialization hands the value over, so the broker stops being in the
/// loop; the two brokered levels keep every call a decision point.
#[must_use]
pub const fn surface_for(level: InvokeLevel) -> SubjectSurface {
    match level {
        InvokeLevel::TypedOperation | InvokeLevel::ConstrainedHttp => {
            SubjectSurface::BrokeredInvocation
        }
        InvokeLevel::Materialize => SubjectSurface::MintedCredential,
    }
}

/// Judge one authority use against the platform it would be exercised on.
///
/// # Errors
///
/// [`EnforcementRefused::SurfaceMismatch`] when the descriptor speaks for a
/// different surface than the invoke level runs on, otherwise
/// [`EnforcementRefused::CannotHold`].
pub fn admit_authority_use(
    use_: &AuthorityUse<'_>,
    descriptor: &EnforcementDescriptor,
) -> Result<Admitted, EnforcementRefused> {
    let running_on = surface_for(use_.level);
    if descriptor.surface() != running_on {
        return Err(EnforcementRefused::SurfaceMismatch {
            platform: descriptor.platform(),
            described: descriptor.surface(),
            running_on,
        });
    }
    admit_grant(use_.grant, descriptor)
}

/// Authorize an authority use, having first established that the platform can
/// hold the grant's terms.
///
/// The gate runs before policy, not after: a use nothing will keep should be
/// refused whether or not the relationship store would have permitted it, and
/// an operator reading the refusal should see the platform gap rather than a
/// denial that looks like a policy mismatch.
///
/// # Errors
///
/// [`AuthzError::EnforcementUnavailable`] when the platform cannot hold the
/// grant, otherwise whatever [`authorize_authority_use`] returns.
pub fn authorize_authority_use_enforced(
    engine: &PolicyEngine,
    use_: &AuthorityUse<'_>,
    descriptor: &EnforcementDescriptor,
) -> Result<AuthorityDecision, AuthzError> {
    admit_authority_use(use_, descriptor)?;
    authorize_authority_use(engine, use_)
}
