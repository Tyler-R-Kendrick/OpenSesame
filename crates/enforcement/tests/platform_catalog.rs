//! The catalogue's two promises: every entry is audited, and a platform we
//! have not built for says so in a form a caller can act on.

use opensesame_enforcement::descriptor::AdapterStatus;
use opensesame_enforcement::dimension::Dimension;
use opensesame_enforcement::grant::{GrantTerms, OfflineUse};
use opensesame_enforcement::platform::catalog;
use opensesame_enforcement::preflight::Shortfall;
use opensesame_enforcement::unsupported::{Remedy, UnsupportedReason};
use opensesame_enforcement::{preflight_grant, Mechanism};

const SEALED: GrantTerms = GrantTerms {
    offline_use: OfflineUse::Forbidden,
    raw_credential_export: false,
};

#[test]
fn every_catalogued_platform_passes_its_own_audit() {
    // The descriptors are built through the audited builder, so this is the
    // test that a new entry cannot be added with an inconsistent claim.
    let catalog = catalog().expect("every catalogued descriptor conforms");
    assert!(catalog.all().len() >= 5);
}

#[test]
fn the_mobile_platforms_claim_nothing_and_name_why() {
    // There is no iOS adapter and no Android adapter in this repository. The
    // single most damaging change anyone could make to this crate is to write
    // plausible-looking guarantees here, so the shape is asserted rather than
    // left to reviewer attention.
    let catalog = catalog().expect("catalog conforms");
    for platform in ["apple-ios", "android"] {
        let descriptor = catalog.find(platform).expect("the platform is catalogued");
        assert_eq!(
            descriptor.adapter(),
            AdapterStatus::Absent,
            "{platform} must not declare an implementation"
        );
        for dimension in Dimension::ALL {
            assert!(
                descriptor.guarantee(dimension).is_none(),
                "{platform} claims {dimension:?}"
            );
            let response = descriptor
                .unsupported(dimension)
                .expect("an unanswered dimension carries a reason");
            assert_eq!(response.reason, UnsupportedReason::NoAdapter);
            assert_eq!(response.remedy, Remedy::NoneKnown);
            assert_eq!(response.platform, platform);
        }
        assert_eq!(descriptor.unsupported_dimensions().len(), 3);
    }
}

#[test]
fn a_grant_on_a_platform_with_no_adapter_is_refused_dimension_by_dimension() {
    let catalog = catalog().expect("catalog conforms");
    let ios = catalog.find("apple-ios").expect("catalogued");
    let refusal = preflight_grant(SEALED, ios).expect_err("nothing is enforced on iOS");
    assert_eq!(refusal.unmet.len(), 3, "all three axes are refused");
    assert!(refusal.cites_unsupported());
    for response in refusal.unsupported() {
        assert_eq!(response.reason, UnsupportedReason::NoAdapter);
    }
}

#[test]
fn a_refusal_serializes_into_something_a_caller_can_branch_on() {
    // The operator-facing payload: no prose parsing, a reason code and a
    // remedy per dimension.
    let catalog = catalog().expect("catalog conforms");
    let android = catalog.find("android").expect("catalogued");
    let refusal = preflight_grant(SEALED, android).expect_err("nothing is enforced on Android");
    let json = serde_json::to_value(&refusal).expect("a refusal serializes");
    assert_eq!(json["platform"], "android");
    assert_eq!(json["surface"], "foreign_platform_app");
    let unmet = json["unmet"].as_array().expect("unmet is a list");
    assert_eq!(unmet.len(), 3);
    assert_eq!(unmet[0]["dimension"], "expiry");
    assert_eq!(unmet[0]["shortfall"], "not_enforced");
    assert_eq!(unmet[0]["response"]["reason"], "no_adapter");
    assert_eq!(unmet[0]["response"]["remedy"], "none_known");
    assert!(
        unmet[0]["response"]["detail"].is_string(),
        "the detail is a checked-in sentence, not a formatted message"
    );
}

#[test]
fn the_same_host_answers_the_dimensions_differently_per_surface() {
    // The argument against a scalar, as data. These three rows are the same
    // deployment; no ordering puts them on a ladder.
    let catalog = catalog().expect("catalog conforms");
    let brokered = catalog
        .find("host-brokered-invocation")
        .expect("catalogued");
    let minted = catalog.find("host-minted-token").expect("catalogued");
    let revocable = catalog
        .find("host-minted-token-revocable")
        .expect("catalogued");

    for dimension in Dimension::ALL {
        assert!(
            brokered.guarantee(dimension).is_some(),
            "a brokered call is a decision point for {dimension:?}"
        );
    }

    // Expiry is held on all three, by different points and to different
    // standards.
    assert_eq!(
        brokered
            .guarantee(Dimension::Expiry)
            .expect("expiry")
            .mechanism,
        Mechanism::GrantExpiryCheck
    );
    assert_eq!(
        minted
            .guarantee(Dimension::Expiry)
            .expect("expiry")
            .mechanism,
        Mechanism::ProviderTokenTtl
    );

    // Termination is the dimension a provider decides for us.
    assert!(minted.guarantee(Dimension::Termination).is_none());
    assert_eq!(
        minted
            .unsupported(Dimension::Termination)
            .expect("a reason")
            .reason,
        UnsupportedReason::ProviderDoesNotOffer
    );
    assert_eq!(
        revocable
            .guarantee(Dimension::Termination)
            .expect("termination")
            .mechanism,
        Mechanism::ProviderRevocation
    );

    // Isolation is the dimension minting ends, whatever the provider offers.
    for descriptor in [minted, revocable] {
        let response = descriptor
            .unsupported(Dimension::Isolation)
            .expect("a reason");
        assert_eq!(response.reason, UnsupportedReason::ValueLeftTheBoundary);
        assert_eq!(response.remedy, Remedy::BrokerTheInvocation);
    }
}

#[test]
fn an_unsupported_dimension_is_the_loudest_outcome_not_the_quietest() {
    // The tempting bug: nothing covers the dimension, so there is no
    // comparison to fail, so the grant sails through.
    let catalog = catalog().expect("catalog conforms");
    let minted = catalog.find("host-minted-token").expect("catalogued");
    let refusal = preflight_grant(
        GrantTerms {
            raw_credential_export: true,
            ..SEALED
        },
        minted,
    )
    .expect_err("a token nobody can revoke cannot carry a revocable grant");
    let kinds: Vec<&str> = refusal
        .unmet
        .iter()
        .map(|unmet| unmet.shortfall.kind())
        .collect();
    assert_eq!(kinds, vec!["not_enforced"]);
    assert!(matches!(
        refusal.unmet[0].shortfall,
        Shortfall::NotEnforced { .. }
    ));
    assert_eq!(refusal.unmet[0].dimension, Dimension::Termination);
    assert_eq!(
        refusal.unsupported()[0].remedy,
        Remedy::ChooseProviderWithControl,
        "the refusal says what would change the answer"
    );
}
