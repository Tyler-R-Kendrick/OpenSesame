//! The claims a descriptor may not make, each demonstrated once.
//!
//! Every case here is a plausible-looking descriptor. That is the point: none
//! of these is a typo, and all of them would read as working enforcement in a
//! table on a wiki page.

use opensesame_enforcement::conformance::ConformanceViolation;
use opensesame_enforcement::descriptor::{AdapterStatus, EnforcementDescriptor};
use opensesame_enforcement::dimension::Dimension;
use opensesame_enforcement::guarantee::{
    Bypass, Guarantee, Latency, Mechanism, Observability, Survival,
};
use opensesame_enforcement::ownership::{EnforcementPoint, SubjectSurface};
use opensesame_enforcement::unsupported::{Remedy, Unsupported, UnsupportedReason};

const MODULE: AdapterStatus = AdapterStatus::Implemented {
    module: "crates/enforcement/tests",
};

fn broker_expiry() -> Guarantee {
    Guarantee::new(
        Mechanism::GrantExpiryCheck,
        EnforcementPoint::HostBroker,
        Bypass::DistinctAuthority,
        Latency::BeforeNextUse,
        Survival::ProcessRestart,
        Observability::Reported,
    )
}

fn no_adapter() -> Unsupported {
    Unsupported::new(
        UnsupportedReason::NoAdapter,
        Remedy::NoneKnown,
        "nobody wrote one",
    )
}

fn platform_has_nothing() -> Unsupported {
    Unsupported::new(
        UnsupportedReason::PlatformProvidesNoMechanism,
        Remedy::RunOnSupervisedHost,
        "the platform offers no mechanism",
    )
}

/// Answer every dimension the same way, then override one. Keeps each case to
/// the single claim it is about.
fn all_unsupported(
    platform: &'static str,
    surface: SubjectSurface,
    adapter: AdapterStatus,
    unsupported: Unsupported,
) -> opensesame_enforcement::descriptor::DescriptorBuilder {
    EnforcementDescriptor::builder(platform, surface, adapter)
        .unsupported(Dimension::Expiry, unsupported)
        .unsupported(Dimension::Termination, unsupported)
        .unsupported(Dimension::Isolation, unsupported)
}

#[test]
fn a_dimension_left_unanswered_is_not_a_descriptor() {
    let violations =
        EnforcementDescriptor::builder("partial", SubjectSurface::BrokeredInvocation, MODULE)
            .enforced(Dimension::Expiry, broker_expiry())
            .build()
            .expect_err("two dimensions were never answered");
    assert_eq!(
        violations,
        vec![
            ConformanceViolation::DimensionUnanswered {
                dimension: Dimension::Termination
            },
            ConformanceViolation::DimensionUnanswered {
                dimension: Dimension::Isolation
            },
        ],
        "an unanswered axis is reported, never defaulted"
    );
}

#[test]
fn an_absent_adapter_cannot_claim_enforcement() {
    // The rule that keeps a platform nobody has built for from shipping a
    // descriptor full of plausible answers.
    let violations = all_unsupported(
        "pretend-ios",
        SubjectSurface::ForeignPlatformApp,
        AdapterStatus::Absent,
        no_adapter(),
    )
    .enforced(
        Dimension::Expiry,
        Guarantee::new(
            Mechanism::ProviderTokenTtl,
            EnforcementPoint::Provider,
            Bypass::DistinctAuthority,
            Latency::WithinSeconds(300),
            Survival::NetworkPartition,
            Observability::Inferred,
        ),
    )
    .build()
    .expect_err("there is no adapter to enforce anything");
    assert_eq!(
        violations,
        vec![ConformanceViolation::AbsentAdapterClaimsEnforcement {
            dimension: Dimension::Expiry,
            mechanism: Mechanism::ProviderTokenTtl,
        }]
    );
}

#[test]
fn a_token_lifetime_cannot_be_filed_as_a_termination_story() {
    let violations = all_unsupported(
        "mislabelled",
        SubjectSurface::MintedCredential,
        MODULE,
        platform_has_nothing(),
    )
    .enforced(
        Dimension::Termination,
        Guarantee::new(
            Mechanism::ProviderTokenTtl,
            EnforcementPoint::Provider,
            Bypass::DistinctAuthority,
            Latency::WithinSeconds(300),
            Survival::NetworkPartition,
            Observability::Inferred,
        ),
    )
    .build()
    .expect_err("a lifetime lapses; it does not stop anything now");
    assert_eq!(
        violations,
        vec![ConformanceViolation::MechanismDoesNotAnswerDimension {
            dimension: Dimension::Termination,
            mechanism: Mechanism::ProviderTokenTtl,
        }]
    );
}

#[test]
fn a_minted_credential_cannot_be_held_by_the_broker_that_minted_it() {
    // The most tempting descriptor in the crate: the code really does run in
    // our gateway, and it really is not consulted again after minting.
    let violations = all_unsupported(
        "minted-but-brokered",
        SubjectSurface::MintedCredential,
        MODULE,
        platform_has_nothing(),
    )
    .enforced(Dimension::Expiry, broker_expiry())
    .build()
    .expect_err("the broker is not in the path of a minted credential");
    assert_eq!(
        violations,
        vec![ConformanceViolation::SurfaceDoesNotAdmitPoint {
            dimension: Dimension::Expiry,
            surface: SubjectSurface::MintedCredential,
            point: EnforcementPoint::HostBroker,
        }]
    );
}

#[test]
fn a_limit_inside_the_subject_cannot_cost_the_subject_anything_to_escape() {
    let violations = all_unsupported(
        "cooperative",
        SubjectSurface::BrokeredInvocation,
        MODULE,
        platform_has_nothing(),
    )
    .enforced(
        Dimension::Isolation,
        Guarantee::new(
            Mechanism::OsSandbox,
            EnforcementPoint::SubjectRuntime,
            Bypass::LocalPrivilegeEscalation,
            Latency::WithinSeconds(1),
            Survival::ProcessLifetime,
            Observability::Inferred,
        ),
    )
    .build()
    .expect_err("a library in the subject is removed by not linking it");
    assert_eq!(
        violations,
        vec![ConformanceViolation::SelfAdministeredClaimsBypass {
            dimension: Dimension::Isolation,
            point: EnforcementPoint::SubjectRuntime,
            bypass: Bypass::LocalPrivilegeEscalation,
        }]
    );
}

#[test]
fn the_subject_cannot_be_its_own_witness() {
    let violations = all_unsupported(
        "self-reporting",
        SubjectSurface::BrokeredInvocation,
        MODULE,
        platform_has_nothing(),
    )
    .enforced(
        Dimension::Isolation,
        Guarantee::new(
            Mechanism::OsSandbox,
            EnforcementPoint::SubjectItself,
            Bypass::TrivialForSubject,
            Latency::WithinSeconds(1),
            Survival::ProcessLifetime,
            Observability::Reported,
        ),
    )
    .build()
    .expect_err("the subject's own account is not an observation");
    assert_eq!(
        violations,
        vec![ConformanceViolation::SelfReportedClaimsObservability {
            dimension: Dimension::Isolation,
            point: EnforcementPoint::SubjectItself,
        }]
    );
}

#[test]
fn a_working_adapter_may_not_blame_the_absence_of_an_adapter() {
    // Otherwise `no_adapter` becomes the reason for every gap, and the
    // catalogue stops distinguishing "not built" from "cannot be built".
    let violations = all_unsupported(
        "implemented",
        SubjectSurface::BrokeredInvocation,
        MODULE,
        no_adapter(),
    )
    .build()
    .expect_err("an implemented adapter names the real cause");
    assert_eq!(violations.len(), Dimension::ALL.len());
    for (violation, dimension) in violations.iter().zip(Dimension::ALL) {
        assert_eq!(
            *violation,
            ConformanceViolation::NoAdapterReasonWithAdapterPresent { dimension }
        );
    }
}

#[test]
fn a_value_that_never_left_cannot_be_why_a_dimension_is_unsupported() {
    let violations = all_unsupported(
        "brokered",
        SubjectSurface::BrokeredInvocation,
        MODULE,
        Unsupported::new(
            UnsupportedReason::ValueLeftTheBoundary,
            Remedy::BrokerTheInvocation,
            "borrowed excuse",
        ),
    )
    .build()
    .expect_err("nothing is minted on a brokered surface");
    assert_eq!(
        violations[0],
        ConformanceViolation::ValueNeverLeftTheBoundary {
            dimension: Dimension::Expiry,
            surface: SubjectSurface::BrokeredInvocation,
        }
    );
}

#[test]
fn every_violation_is_reported_in_one_run() {
    // An author fixing one claim should see the rest of the bill, not
    // discover it one build at a time.
    let violations = EnforcementDescriptor::builder(
        "everything-wrong",
        SubjectSurface::MintedCredential,
        AdapterStatus::Absent,
    )
    .enforced(Dimension::Expiry, broker_expiry())
    .unsupported(Dimension::Termination, no_adapter())
    .enforced(
        Dimension::Isolation,
        Guarantee::new(
            Mechanism::ProviderTokenTtl,
            EnforcementPoint::SubjectItself,
            Bypass::DistinctAuthority,
            Latency::WithinSeconds(5),
            Survival::ProcessLifetime,
            Observability::Reported,
        ),
    )
    .build()
    .expect_err("this descriptor breaks most of the rules at once");
    assert!(
        violations.len() >= 5,
        "expected the whole bill, got {violations:?}"
    );
    let dimensions: Vec<Dimension> = violations
        .iter()
        .map(ConformanceViolation::dimension)
        .collect();
    assert!(dimensions.contains(&Dimension::Expiry));
    assert!(dimensions.contains(&Dimension::Isolation));
    // Termination's `no_adapter` is legitimate here: the adapter really is
    // absent, so that dimension contributes nothing to the bill.
    assert!(!dimensions.contains(&Dimension::Termination));
}
