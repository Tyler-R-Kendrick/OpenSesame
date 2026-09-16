//! What a grant's own constraints demand, and which platforms can carry them.
//!
//! Each case is a decision a deployment actually faces, and the interesting
//! half is the refusals: a grant that cannot be held is refused before it is
//! issued rather than behaving differently in production.

use opensesame_enforcement::dimension::Dimension;
use opensesame_enforcement::grant::{GrantTerms, OfflineUse};
use opensesame_enforcement::guarantee::Survival;
use opensesame_enforcement::platform::catalog;
use opensesame_enforcement::preflight::Shortfall;
use opensesame_enforcement::unsupported::{Remedy, UnsupportedReason};
use opensesame_enforcement::{preflight_grant, requirements_for};

const SEALED: GrantTerms = GrantTerms {
    offline_use: OfflineUse::Forbidden,
    raw_credential_export: false,
};

const EXPORTED: GrantTerms = GrantTerms {
    offline_use: OfflineUse::Forbidden,
    raw_credential_export: true,
};

#[test]
fn a_sealed_grant_is_carried_by_a_brokered_surface() {
    let catalog = catalog().expect("catalog conforms");
    let brokered = catalog
        .find("host-brokered-invocation")
        .expect("catalogued");
    let admitted = preflight_grant(SEALED, brokered).expect("a brokered call holds all three");
    assert_eq!(admitted.platform(), "host-brokered-invocation");
    assert_eq!(admitted.held().len(), 3);
    for dimension in Dimension::ALL {
        assert!(
            admitted.guarantee(dimension).is_some(),
            "{dimension:?} is held, and the admission says by what"
        );
    }
}

#[test]
fn a_sealed_grant_cannot_be_carried_by_minting_the_credential() {
    // The headline refusal. `raw_credential_export == false` is a claim that
    // the value stays inside the boundary, and minting it ends the boundary
    // however good the provider's revocation is.
    let catalog = catalog().expect("catalog conforms");
    let revocable = catalog
        .find("host-minted-token-revocable")
        .expect("catalogued");
    let refusal = preflight_grant(SEALED, revocable).expect_err("nothing holds the reach");
    assert_eq!(refusal.unmet.len(), 1);
    assert_eq!(refusal.unmet[0].dimension, Dimension::Isolation);
    let response = refusal.unsupported()[0];
    assert_eq!(response.reason, UnsupportedReason::ValueLeftTheBoundary);
    assert_eq!(response.remedy, Remedy::BrokerTheInvocation);
}

#[test]
fn a_grant_that_permits_export_is_carried_by_a_provider_that_revokes() {
    // It said the value may leave, so isolation is not demanded — but
    // somebody outside the subject must still be able to pull the authority.
    let catalog = catalog().expect("catalog conforms");
    let revocable = catalog
        .find("host-minted-token-revocable")
        .expect("catalogued");
    let admitted = preflight_grant(EXPORTED, revocable).expect("the provider revokes");
    assert_eq!(admitted.held().len(), 2);
    assert!(admitted.guarantee(Dimension::Isolation).is_none());
    assert!(admitted.guarantee(Dimension::Termination).is_some());
}

#[test]
fn a_provider_with_no_revocation_cannot_carry_any_grant() {
    // Every grant is revocable — `revoked_at` exists on the record — so
    // termination is demanded even when the value was allowed to leave.
    let catalog = catalog().expect("catalog conforms");
    let minted = catalog.find("host-minted-token").expect("catalogued");
    for terms in [SEALED, EXPORTED] {
        let refusal = preflight_grant(terms, minted).expect_err("nothing can pull the authority");
        let refused: Vec<Dimension> = refusal.unmet.iter().map(|unmet| unmet.dimension).collect();
        assert!(
            refused.contains(&Dimension::Termination),
            "termination is demanded for {terms:?}"
        );
    }
}

#[test]
fn a_pre_authorized_offline_grant_needs_a_deadline_that_outlives_the_broker() {
    // A deadline held only by a process the subject cannot reach is no
    // deadline for a subject that may act while disconnected. This is a
    // *policy* shortfall, not a platform gap: the dimension is enforced, just
    // not to this grant's terms, and the refusal says which.
    let catalog = catalog().expect("catalog conforms");
    let brokered = catalog
        .find("host-brokered-invocation")
        .expect("catalogued");
    let terms = GrantTerms {
        offline_use: OfflineUse::PreAuthorized,
        ..SEALED
    };
    let refusal =
        preflight_grant(terms, brokered).expect_err("the broker's deadline dies with the broker");
    assert!(
        !refusal.cites_unsupported(),
        "the dimension is enforced; it falls short"
    );
    let expiry = refusal
        .unmet
        .iter()
        .find(|unmet| unmet.dimension == Dimension::Expiry)
        .expect("expiry fell short");
    assert_eq!(
        expiry.shortfall,
        Shortfall::TooShortLived {
            offered: Survival::ProcessRestart,
            required: Survival::NetworkPartition,
        }
    );
}

#[test]
fn a_pre_authorized_offline_grant_is_carried_by_a_provider_side_deadline() {
    // The same grant, on a surface where the deadline is the provider's: it
    // holds with no channel back to us at all.
    let catalog = catalog().expect("catalog conforms");
    let revocable = catalog
        .find("host-minted-token-revocable")
        .expect("catalogued");
    let terms = GrantTerms {
        offline_use: OfflineUse::PreAuthorized,
        raw_credential_export: true,
    };
    let admitted = preflight_grant(terms, revocable).expect("a provider TTL survives partition");
    assert_eq!(
        admitted
            .guarantee(Dimension::Expiry)
            .expect("expiry")
            .survival,
        Survival::NetworkPartition
    );
}

#[test]
fn the_derived_demands_can_be_tightened_without_being_rebuilt() {
    // A deployment with its own policy narrows the derived set; it does not
    // start from scratch and risk dropping a dimension.
    let requirements = requirements_for(SEALED);
    assert_eq!(requirements.dimensions(), Dimension::ALL.to_vec());
    let tightened = requirements.clone().require(
        requirements
            .get(Dimension::Termination)
            .expect("termination is demanded")
            .surviving(Survival::DeviceReboot),
    );
    assert_eq!(tightened.stated().len(), 3, "replaced, not appended");
    assert_eq!(
        tightened
            .get(Dimension::Termination)
            .expect("termination")
            .survival_floor,
        Survival::DeviceReboot
    );
    let catalog = catalog().expect("catalog conforms");
    let brokered = catalog
        .find("host-brokered-invocation")
        .expect("catalogued");
    assert!(
        opensesame_enforcement::preflight(&tightened, brokered).is_err(),
        "the tightened demand is genuinely stricter than the platform"
    );
}
