//! The rules a descriptor is judged against, in one place.
//!
//! Every other module in this crate states facts. This one is the only module
//! that says a set of facts cannot go together, and that is deliberate. The
//! failure this crate exists to prevent is an adapter author filling a
//! required field with the plausible-sounding value that was right there; if
//! the rules lived beside each constructor, each constructor would grow its own
//! idea of what is consistent, and the one that forgot would be the one that
//! shipped.
//!
//! So [`Guarantee::new`](crate::guarantee::Guarantee::new) checks nothing,
//! [`Unsupported::new`](crate::unsupported::Unsupported::new) checks nothing,
//! and [`audit`] runs once, when
//! [`DescriptorBuilder::build`](crate::descriptor::DescriptorBuilder::build)
//! freezes the answers. A descriptor that exists has already passed this, which
//! is why nothing downstream re-checks it.
//!
//! The rules fall into three groups:
//!
//! - **There has to be code.** An adapter declared absent may not claim
//!   enforcement anywhere ([`ConformanceViolation::AbsentAdapterClaimsEnforcement`]),
//!   and an adapter that exists may not blame the absence of one
//!   ([`ConformanceViolation::NoAdapterReasonWithAdapterPresent`]). Together
//!   these are what keep the two mobile entries in
//!   [`crate::platform::catalog`] honest in both directions.
//! - **The mechanism has to be in the path.** It must answer the dimension it
//!   was offered for, and its enforcement point must be one the surface
//!   actually routes through — a minted credential is not held by the broker
//!   that minted it.
//! - **A limit inside the subject may not be described as one outside it.**
//!   This is the group with teeth. Something the subject administers may not
//!   claim to be expensive to bypass, may not claim to act before the
//!   subject's own next use, and may not report on itself. Each of those is a
//!   way of making a preference read like a boundary.
//!
//! [`audit`] reports every violation rather than the first: an author fixing
//! one claim should see the rest in the same run instead of discovering them a
//! build at a time.

use crate::descriptor::{Coverage, EnforcementDescriptor};
use crate::dimension::Dimension;
use crate::guarantee::{Bypass, Guarantee, Latency, Mechanism};
use crate::ownership::{EnforcementPoint, SubjectSurface};
use crate::unsupported::{Unsupported, UnsupportedReason};
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// A claim a descriptor is not allowed to make.
///
/// Each variant names the two facts that cannot hold at once, so the message
/// tells an author which one to change rather than that something was invalid.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Error, Serialize, Deserialize)]
#[serde(tag = "violation", rename_all = "snake_case")]
pub enum ConformanceViolation {
    /// A dimension was never answered. Raised by the builder before the rest of
    /// the audit can run: there is nothing yet to judge.
    #[error("the `{}` dimension was left unanswered", dimension.as_str())]
    DimensionUnanswered {
        /// The axis with no answer.
        dimension: Dimension,
    },
    /// The adapter is declared absent and a dimension claims code anyway.
    #[error(
        "the adapter is declared absent, so the `{}` dimension cannot be enforced by `{:?}`",
        dimension.as_str(),
        mechanism
    )]
    AbsentAdapterClaimsEnforcement {
        /// The axis claiming enforcement.
        dimension: Dimension,
        /// The mechanism it named.
        mechanism: Mechanism,
    },
    /// The named mechanism does not answer the dimension it was offered for —
    /// a token lifetime put forward as a termination story, say.
    #[error("`{:?}` does not answer the `{}` dimension", mechanism, dimension.as_str())]
    MechanismDoesNotAnswerDimension {
        /// The axis.
        dimension: Dimension,
        /// The mechanism that does not serve it.
        mechanism: Mechanism,
    },
    /// The enforcement point is not in the call path for this surface, so the
    /// guarantee describes a decision nobody makes.
    #[error(
        "a subject on `{}` is not held by `{}`, so the `{}` dimension names a call path that does not exist",
        surface.as_str(),
        point.as_str(),
        dimension.as_str()
    )]
    SurfaceDoesNotAdmitPoint {
        /// The axis.
        dimension: Dimension,
        /// The surface the subject runs on.
        surface: SubjectSurface,
        /// The point that is not in its path.
        point: EnforcementPoint,
    },
    /// Something inside the subject is credited with a bypass cost the subject
    /// would have to pay to get around itself.
    #[error(
        "`{}` is not independent of the subject, so the `{}` dimension cannot cost `{:?}` to bypass",
        point.as_str(),
        dimension.as_str(),
        bypass
    )]
    SelfAdministeredClaimsBypass {
        /// The axis.
        dimension: Dimension,
        /// The point inside the subject.
        point: EnforcementPoint,
        /// The bypass cost claimed for it.
        bypass: Bypass,
    },
    /// Something inside the subject claims to act before the subject's own next
    /// use. Whatever runs in the subject's process runs when the subject lets
    /// it, so there is a window by construction.
    #[error(
        "`{}` runs inside the subject, so the `{}` dimension cannot take hold before the subject's next use",
        point.as_str(),
        dimension.as_str()
    )]
    SelfAdministeredClaimsImmediacy {
        /// The axis.
        dimension: Dimension,
        /// The point inside the subject.
        point: EnforcementPoint,
    },
    /// The only thing that would report this state is the subject, so a
    /// reported observability is the subject's word for it.
    #[error(
        "`{}` would be reporting on itself, so the `{}` dimension cannot call its state reported",
        point.as_str(),
        dimension.as_str()
    )]
    SelfReportedClaimsObservability {
        /// The axis.
        dimension: Dimension,
        /// The point that would be its own witness.
        point: EnforcementPoint,
    },
    /// An implemented adapter blamed the absence of an adapter. Keeps
    /// [`UnsupportedReason::NoAdapter`] from papering over a gap in code that
    /// otherwise claims to work.
    #[error(
        "`no_adapter` is not a reason an implemented adapter may give for the `{}` dimension",
        dimension.as_str()
    )]
    NoAdapterReasonWithAdapterPresent {
        /// The axis with the borrowed excuse.
        dimension: Dimension,
    },
    /// [`UnsupportedReason::ValueLeftTheBoundary`] was given on a surface that
    /// never hands the value out.
    #[error(
        "no value leaves the boundary on `{}`, so it cannot be why the `{}` dimension is unsupported",
        surface.as_str(),
        dimension.as_str()
    )]
    ValueNeverLeftTheBoundary {
        /// The axis.
        dimension: Dimension,
        /// The surface that keeps the value.
        surface: SubjectSurface,
    },
}

impl ConformanceViolation {
    /// The dimension the violation is about. Every variant has one, so a
    /// caller can group a run's findings by axis without matching.
    #[must_use]
    pub const fn dimension(&self) -> Dimension {
        match self {
            Self::DimensionUnanswered { dimension }
            | Self::AbsentAdapterClaimsEnforcement { dimension, .. }
            | Self::MechanismDoesNotAnswerDimension { dimension, .. }
            | Self::SurfaceDoesNotAdmitPoint { dimension, .. }
            | Self::SelfAdministeredClaimsBypass { dimension, .. }
            | Self::SelfAdministeredClaimsImmediacy { dimension, .. }
            | Self::SelfReportedClaimsObservability { dimension, .. }
            | Self::NoAdapterReasonWithAdapterPresent { dimension }
            | Self::ValueNeverLeftTheBoundary { dimension, .. } => *dimension,
        }
    }
}

/// Whether a descriptor claims no enforcement at all.
///
/// True for the two mobile entries in [`crate::platform::catalog`], and the
/// property a test can assert about them directly: "there is no iOS adapter" is
/// a statement about the descriptor, not about the absence of one.
#[must_use]
pub fn claims_nothing(descriptor: &EnforcementDescriptor) -> bool {
    descriptor
        .coverages()
        .iter()
        .all(|entry| matches!(entry.coverage, Coverage::Unsupported(_)))
}

/// Judge a descriptor's answers against every rule.
///
/// Called by [`DescriptorBuilder::build`](crate::descriptor::DescriptorBuilder::build),
/// so callers rarely invoke it directly. It is public because an adapter's own
/// test suite should be able to assert *why* a candidate descriptor is refused.
///
/// # Errors
///
/// Every [`ConformanceViolation`] the descriptor commits, in
/// [`Dimension::ALL`] order and then rule order within a dimension.
pub fn audit(descriptor: &EnforcementDescriptor) -> Result<(), Vec<ConformanceViolation>> {
    let mut violations = Vec::new();
    for entry in descriptor.coverages() {
        match entry.coverage {
            Coverage::Enforced(guarantee) => {
                audit_enforced(descriptor, entry.dimension, guarantee, &mut violations);
            }
            Coverage::Unsupported(unsupported) => {
                audit_unsupported(descriptor, entry.dimension, unsupported, &mut violations);
            }
        }
    }
    if violations.is_empty() {
        Ok(())
    } else {
        Err(violations)
    }
}

fn audit_enforced(
    descriptor: &EnforcementDescriptor,
    dimension: Dimension,
    guarantee: Guarantee,
    violations: &mut Vec<ConformanceViolation>,
) {
    let mechanism = guarantee.mechanism;
    let point = guarantee.point;
    let surface = descriptor.surface();
    if !descriptor.adapter().is_implemented() {
        violations.push(ConformanceViolation::AbsentAdapterClaimsEnforcement {
            dimension,
            mechanism,
        });
    }
    if !mechanism.answers(dimension) {
        violations.push(ConformanceViolation::MechanismDoesNotAnswerDimension {
            dimension,
            mechanism,
        });
    }
    if !surface.admits(point) {
        violations.push(ConformanceViolation::SurfaceDoesNotAdmitPoint {
            dimension,
            surface,
            point,
        });
    }
    audit_self_administered(dimension, guarantee, violations);
}

/// The three ways a limit inside the subject gets written as one outside it.
fn audit_self_administered(
    dimension: Dimension,
    guarantee: Guarantee,
    violations: &mut Vec<ConformanceViolation>,
) {
    let point = guarantee.point;
    if point.independent_of_subject() {
        return;
    }
    if !matches!(guarantee.bypass, Bypass::TrivialForSubject) {
        violations.push(ConformanceViolation::SelfAdministeredClaimsBypass {
            dimension,
            point,
            bypass: guarantee.bypass,
        });
    }
    if matches!(guarantee.latency, Latency::BeforeNextUse) {
        violations.push(ConformanceViolation::SelfAdministeredClaimsImmediacy { dimension, point });
    }
    if guarantee.self_reported() {
        violations.push(ConformanceViolation::SelfReportedClaimsObservability { dimension, point });
    }
}

fn audit_unsupported(
    descriptor: &EnforcementDescriptor,
    dimension: Dimension,
    unsupported: Unsupported,
    violations: &mut Vec<ConformanceViolation>,
) {
    let surface = descriptor.surface();
    match unsupported.reason {
        UnsupportedReason::NoAdapter if descriptor.adapter().is_implemented() => {
            violations.push(ConformanceViolation::NoAdapterReasonWithAdapterPresent { dimension });
        }
        UnsupportedReason::ValueLeftTheBoundary
            if !matches!(surface, SubjectSurface::MintedCredential) =>
        {
            violations.push(ConformanceViolation::ValueNeverLeftTheBoundary { dimension, surface });
        }
        UnsupportedReason::NoAdapter
        | UnsupportedReason::PlatformProvidesNoMechanism
        | UnsupportedReason::PrivilegeUnavailable
        | UnsupportedReason::ProviderDoesNotOffer
        | UnsupportedReason::ValueLeftTheBoundary => {}
    }
}

#[cfg(test)]
mod tests {
    use super::{audit, claims_nothing, ConformanceViolation};
    use crate::descriptor::{AdapterStatus, DescriptorBuilder, EnforcementDescriptor};
    use crate::dimension::Dimension;
    use crate::guarantee::{Bypass, Guarantee, Latency, Mechanism, Observability, Survival};
    use crate::ownership::{EnforcementPoint, SubjectSurface};
    use crate::unsupported::{Remedy, Unsupported, UnsupportedReason};

    const IMPLEMENTED: AdapterStatus = AdapterStatus::Implemented {
        module: "crates/enforcement",
    };

    fn no_adapter() -> Unsupported {
        Unsupported::new(
            UnsupportedReason::NoAdapter,
            Remedy::NoneKnown,
            "no adapter exists",
        )
    }

    fn no_mechanism() -> Unsupported {
        Unsupported::new(
            UnsupportedReason::PlatformProvidesNoMechanism,
            Remedy::RunOnSupervisedHost,
            "the platform offers nothing that would do it",
        )
    }

    /// A builder with expiry and termination already answered honestly, so a
    /// test can put the claim under examination on isolation alone.
    fn claiming(surface: SubjectSurface, adapter: AdapterStatus) -> DescriptorBuilder {
        EnforcementDescriptor::builder("test-platform", surface, adapter)
            .unsupported(Dimension::Expiry, no_mechanism())
            .unsupported(Dimension::Termination, no_mechanism())
    }

    #[test]
    fn a_cooperative_limit_is_admitted_when_it_is_described_as_one() {
        // The same point and mechanism as the refusal above. Nothing here
        // stops a deployment shipping a cooperative runtime limit; the audit
        // only stops it being *described* as independent enforcement.
        let descriptor = claiming(SubjectSurface::ForeignPlatformApp, IMPLEMENTED)
            .enforced(
                Dimension::Isolation,
                Guarantee::new(
                    Mechanism::OsSandbox,
                    EnforcementPoint::SubjectRuntime,
                    Bypass::TrivialForSubject,
                    Latency::WithinSeconds(60),
                    Survival::ProcessLifetime,
                    Observability::Inferred,
                ),
            )
            .build()
            .expect("an honestly described preference is a valid answer");
        assert!(!claims_nothing(&descriptor));
    }

    #[test]
    fn a_descriptor_that_answers_nothing_says_so_without_a_special_case() {
        let descriptor = claiming(SubjectSurface::ForeignPlatformApp, AdapterStatus::Absent)
            .unsupported(Dimension::Isolation, no_adapter())
            .build()
            .expect("an honestly empty descriptor is a valid one");
        assert!(claims_nothing(&descriptor));
        assert_eq!(descriptor.unsupported_dimensions().len(), 3);
    }

    /// A surface that keeps the value cannot excuse an unsupported axis by
    /// saying the value left. That reason is reserved for minted credentials.
    #[test]
    fn a_value_that_never_left_cannot_be_why_a_dimension_is_unsupported() {
        let left = Unsupported::new(
            UnsupportedReason::ValueLeftTheBoundary,
            Remedy::BrokerTheInvocation,
            "the value is gone",
        );
        let violations = claiming(SubjectSurface::ForeignPlatformApp, IMPLEMENTED)
            .unsupported(Dimension::Isolation, left)
            .build()
            .expect_err("the surface never hands the value out");
        assert!(
            violations.iter().any(|violation| {
                matches!(
                    violation,
                    ConformanceViolation::ValueNeverLeftTheBoundary {
                        dimension: Dimension::Isolation,
                        surface: SubjectSurface::ForeignPlatformApp,
                    }
                )
            }),
            "expected ValueNeverLeftTheBoundary, got {violations:?}"
        );

        let minted = claiming(SubjectSurface::MintedCredential, IMPLEMENTED)
            .unsupported(Dimension::Isolation, left)
            .build()
            .expect("a minted credential may honestly say the value left");
        assert!(
            audit(&minted).is_ok(),
            "ValueLeftTheBoundary is legal on MintedCredential"
        );
    }
}
