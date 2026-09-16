//! Reading a grant's own constraints as enforcement demands.
//!
//! A grant already says what it expects; nobody has to invent a second policy
//! language for it. Three of its fields decide what the platform must hold,
//! and the mapping is deliberately small enough to argue with:
//!
//! - **Every grant carries a deadline** (`constraints.expires_at`), so expiry
//!   is always demanded, and always from a point outside the subject. A
//!   deadline the subject keeps for itself is a reminder.
//! - **Every grant is revocable** (`revoked_at` exists on the record), so
//!   termination is always demanded too. This is the demand that most often
//!   turns into a refusal, and that is the point: issuing a revocable-looking
//!   grant on a surface with no termination story is a promise to an operator
//!   that will not be kept.
//! - **`raw_credential_export == false` is a claim about reach.** It says the
//!   value stays inside the boundary, which requires something to *be* the
//!   boundary — so isolation is demanded, termination must be bypass-proof
//!   against a subject that escalates locally, and the stop must be
//!   observable. A grant that permits raw export has said the value may
//!   leave, and demands no isolation at all.
//! - **`offline_use` sets how long the deadline must outlive its enforcer.**
//!   A pre-authorized offline grant whose expiry dies with a process has no
//!   expiry. This floor is applied to expiry and termination, not to
//!   isolation: isolation only has to hold while the authority is usable, and
//!   on a brokered surface an enforcer that is gone is an authority that
//!   cannot be exercised at all.
//!
//! Nothing here reads an action, a resource, or a budget. Those are
//! authorization questions, decided elsewhere; this module only asks what the
//! platform must be able to *hold*.
//!
//! The input is [`GrantTerms`] rather than `opensesame_domain::Grant`: this
//! crate takes no dependency on the domain model, so a descriptor and a
//! refusal can be reasoned about — and fuzzed, and served — without dragging
//! authorization in behind them. The projection is two fields of
//! `Grant::constraints` and a three-arm match on `OfflineUse`; the wire names
//! of [`OfflineUse`] here are the domain's own, and
//! `offline_use_wire_names_match_the_domain` holds them to it.

use crate::descriptor::EnforcementDescriptor;
use crate::dimension::Dimension;
use crate::guarantee::{Bypass, Observability, Survival};
use crate::preflight::{preflight, Admitted, Refusal};
use crate::requirement::{Requirement, Requirements};
use serde::{Deserialize, Serialize};

/// What a grant permits the subject to do while it cannot reach us.
///
/// Mirrors `opensesame_domain::OfflineUse`, wire name for wire name.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OfflineUse {
    /// Nothing. The subject is expected to be able to reach us.
    Forbidden,
    /// Reads only.
    ReadOnly,
    /// The subject may act on authority granted in advance.
    PreAuthorized,
}

/// The part of a grant that decides what the platform must hold.
///
/// Projected from `Grant`: `constraints.offline_use` and
/// `constraints.raw_credential_export`. The deadline itself is not carried
/// because every grant has one — expiry is demanded unconditionally, and a
/// field here would invite a caller to pass `false`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct GrantTerms {
    /// What the subject may do while disconnected.
    pub offline_use: OfflineUse,
    /// Whether the grant permits the raw credential to be handed over.
    pub raw_credential_export: bool,
}

/// The enforcement a grant's own constraints demand.
#[must_use]
pub fn requirements_for(terms: GrantTerms) -> Requirements {
    let holds_the_boundary = !terms.raw_credential_export;
    let survival = survival_floor(terms.offline_use);
    let requirements = Requirements::none()
        .require(expiry(survival))
        .require(termination(survival, holds_the_boundary));
    if holds_the_boundary {
        requirements.require(isolation())
    } else {
        requirements
    }
}

/// Judge a grant against a platform before issuing it.
///
/// # Errors
///
/// A [`Refusal`] naming every dimension the platform cannot hold to the
/// grant's terms, with the platform's own unsupported reasons attached.
pub fn preflight_grant(
    terms: GrantTerms,
    descriptor: &EnforcementDescriptor,
) -> Result<Admitted, Refusal> {
    preflight(&requirements_for(terms), descriptor)
}

const fn survival_floor(offline_use: OfflineUse) -> Survival {
    match offline_use {
        // The subject is expected to be able to reach us, so an enforcer that
        // survives its own restart is enough.
        OfflineUse::Forbidden => Survival::ProcessRestart,
        // Reading while disconnected outlives a reboot of the enforcing host.
        OfflineUse::ReadOnly => Survival::DeviceReboot,
        // Acting while disconnected means the deadline has to hold with no
        // channel back to us at all.
        OfflineUse::PreAuthorized => Survival::NetworkPartition,
    }
}

fn expiry(survival: Survival) -> Requirement {
    // No latency ceiling: a grant states a deadline, not a tolerance for how
    // long past it the platform may take. A deployment that needs the deadline
    // honoured on the call path says so with its own requirement.
    Requirement::independent(Dimension::Expiry)
        .surviving(survival)
        .observed_at_least(Observability::Inferred)
}

fn termination(survival: Survival, holds_the_boundary: bool) -> Requirement {
    let requirement = Requirement::independent(Dimension::Termination).surviving(survival);
    if holds_the_boundary {
        requirement
            .bypass_at_least(Bypass::DistinctAuthority)
            .observed_at_least(Observability::Reported)
    } else {
        // The value is in the subject's hands. All that can be demanded is
        // that somebody outside it is able to pull the authority — which is
        // exactly the demand a provider with no revocation endpoint fails.
        requirement.observed_at_least(Observability::Inferred)
    }
}

fn isolation() -> Requirement {
    Requirement::independent(Dimension::Isolation).bypass_at_least(Bypass::DistinctAuthority)
}

#[cfg(test)]
mod tests {
    use super::{requirements_for, GrantTerms, OfflineUse};
    use crate::dimension::Dimension;
    use crate::guarantee::{Bypass, Observability, Survival};

    const SEALED: GrantTerms = GrantTerms {
        offline_use: OfflineUse::Forbidden,
        raw_credential_export: false,
    };

    #[test]
    fn offline_use_wire_names_match_the_domain() {
        // This enum mirrors `opensesame_domain::OfflineUse` so the crate can
        // stay free of the domain model. If the domain renames a variant, the
        // projection in the Host breaks at the match — and a payload built
        // from this enum would have drifted silently, so the names are pinned.
        for (value, wire) in [
            (OfflineUse::Forbidden, "\"forbidden\""),
            (OfflineUse::ReadOnly, "\"read_only\""),
            (OfflineUse::PreAuthorized, "\"pre_authorized\""),
        ] {
            let json = serde_json::to_string(&value).expect("serializes");
            assert_eq!(json, wire);
        }
    }

    #[test]
    fn a_grant_that_keeps_the_value_inside_demands_all_three_dimensions() {
        let requirements = requirements_for(SEALED);
        assert_eq!(requirements.stated().len(), 3);
        let isolation = requirements
            .get(Dimension::Isolation)
            .expect("isolation is demanded");
        assert!(isolation.independent_point);
        assert_eq!(isolation.bypass_floor, Bypass::DistinctAuthority);
        let termination = requirements
            .get(Dimension::Termination)
            .expect("termination is always demanded");
        assert_eq!(termination.observability_floor, Observability::Reported);
    }

    #[test]
    fn a_grant_that_permits_raw_export_demands_no_isolation() {
        // It said the value may leave. Demanding a boundary afterwards would
        // refuse every legitimate minted credential in the product.
        let terms = GrantTerms {
            raw_credential_export: true,
            ..SEALED
        };
        let requirements = requirements_for(terms);
        assert!(requirements.get(Dimension::Isolation).is_none());
        // Expiry and termination are still demanded — a minted credential is
        // not an unrevokable one.
        assert!(requirements.get(Dimension::Expiry).is_some());
        let termination = requirements
            .get(Dimension::Termination)
            .expect("termination survives raw export");
        assert!(termination.independent_point);
        assert_eq!(termination.bypass_floor, Bypass::LocalPrivilegeEscalation);
    }

    #[test]
    fn offline_use_raises_how_long_the_deadline_must_outlive_its_enforcer() {
        let floors = [
            (OfflineUse::Forbidden, Survival::ProcessRestart),
            (OfflineUse::ReadOnly, Survival::DeviceReboot),
            (OfflineUse::PreAuthorized, Survival::NetworkPartition),
        ];
        for (offline_use, expected) in floors {
            let requirements = requirements_for(GrantTerms {
                offline_use,
                ..SEALED
            });
            let expiry = requirements
                .get(Dimension::Expiry)
                .expect("expiry is always demanded");
            assert_eq!(expiry.survival_floor, expected, "{offline_use:?}");
        }
        // Isolation is deliberately exempt: it only has to hold while the
        // authority is usable at all.
        let requirements = requirements_for(GrantTerms {
            offline_use: OfflineUse::PreAuthorized,
            ..SEALED
        });
        assert_eq!(
            requirements
                .get(Dimension::Isolation)
                .expect("isolation is demanded")
                .survival_floor,
            Survival::ProcessLifetime
        );
    }
}
