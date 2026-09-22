//! LIFE-TRUST: validation, CAS, guarded removal, bounded rollover overlap,
//! and the rule that an invalid set never "recovers" onto another authority.

use std::collections::BTreeMap;

use chrono::{Duration, Utc};
use opensesame_domain::transport::{
    BindingPurpose, BindingScope, PeerIdentitySelector, ServiceBinding, ServiceBindingSet,
    TrustProfileKind,
};
use opensesame_transport_security::testkit::DisposableCa;

use crate::transport_lifecycle::test_support as support;
use crate::transport_lifecycle::trust::{
    self, StoredTrustProfile, TrustError, TrustProfileSet, MAX_OVERLAP_SECONDS,
};

fn profile(name: &str, ca: &DisposableCa) -> StoredTrustProfile {
    StoredTrustProfile {
        profile: support::profile_ref(name),
        kind: TrustProfileKind::PrivateRoot,
        anchors_pem: String::from_utf8(ca.root_pem()).expect("pem"),
        retiring_anchors_pem: None,
        overlap_until: None,
        enabled: true,
        trust_domain: None,
    }
}

fn binding(id: &str, profile_name: &str) -> ServiceBinding {
    ServiceBinding {
        id: id.into(),
        revision: 1,
        enabled: true,
        revoked: false,
        scope: BindingScope::Deployment,
        trust_profile: support::profile_ref(profile_name),
        peer: PeerIdentitySelector::DnsName("worker.test".into()),
        service_principal: "service:worker".into(),
        purpose: BindingPurpose::WorkerClient,
        allowed_operations: vec!["worker.health.ready".into()],
        allowed_audiences: vec!["https://opensesame.test".into()],
        not_after: None,
        denied_thumbprints: Vec::new(),
    }
}

#[tokio::test]
async fn a_valid_profile_is_stored_and_read_back_at_the_next_revision() {
    let state = support::state().await;
    let ca = DisposableCa::new("peers");
    let stored = trust::put_cas(
        &state,
        TrustProfileSet {
            revision: 0,
            profiles: vec![profile("peers", &ca)],
        },
        "operator",
        false,
    )
    .await
    .expect("put");
    assert_eq!(stored.revision, 1);
    assert_eq!(trust::load(&state).await.expect("load"), stored);
}

#[tokio::test]
async fn a_stale_revision_is_refused_so_two_operators_cannot_overwrite_each_other() {
    let state = support::state().await;
    let ca = DisposableCa::new("peers");
    let set = TrustProfileSet {
        revision: 0,
        profiles: vec![profile("peers", &ca)],
    };
    trust::put_cas(&state, set.clone(), "operator", false)
        .await
        .expect("first");
    let error = trust::put_cas(&state, set, "operator", false)
        .await
        .expect_err("second");
    assert!(matches!(error, TrustError::StaleRevision { current: 1 }));
    assert_eq!(error.http_status(), 409);
}

#[tokio::test]
async fn an_anchor_that_is_not_a_usable_ca_refuses_the_whole_write() {
    let state = support::state().await;
    let ca = DisposableCa::new("peers");
    let leaf = ca.issue_server("localhost");
    let mut bad = profile("peers", &ca);
    bad.anchors_pem = String::from_utf8(leaf.cert_pem.clone()).expect("pem");
    let error = trust::put_cas(
        &state,
        TrustProfileSet {
            revision: 0,
            profiles: vec![bad],
        },
        "operator",
        false,
    )
    .await
    .expect_err("a leaf is not an anchor");
    assert!(matches!(error, TrustError::Invalid(_)));
    assert_eq!(
        trust::load(&state).await.expect("load").revision,
        0,
        "a refused write stores nothing",
    );
}

#[tokio::test]
async fn a_spiffe_profile_must_name_its_trust_domain_and_nothing_else_may() {
    let state = support::state().await;
    let ca = DisposableCa::new("peers");
    let mut spiffe = profile("peers", &ca);
    spiffe.kind = TrustProfileKind::SpiffeTrustDomain;
    let error = trust::put_cas(
        &state,
        TrustProfileSet {
            revision: 0,
            profiles: vec![spiffe.clone()],
        },
        "operator",
        false,
    )
    .await
    .expect_err("no trust domain");
    assert!(matches!(error, TrustError::Invalid(_)));

    let mut wrong = profile("peers", &ca);
    wrong.trust_domain = Some("example.test".into());
    assert!(trust::put_cas(
        &state,
        TrustProfileSet {
            revision: 0,
            profiles: vec![wrong]
        },
        "operator",
        false
    )
    .await
    .is_err());

    spiffe.trust_domain = Some("example.test".into());
    assert!(trust::put_cas(
        &state,
        TrustProfileSet {
            revision: 0,
            profiles: vec![spiffe]
        },
        "operator",
        false
    )
    .await
    .is_ok());
}

#[tokio::test]
async fn a_profile_an_enabled_binding_names_cannot_be_removed_without_force() {
    let state = support::state().await;
    let ca = DisposableCa::new("peers");
    trust::put_cas(
        &state,
        TrustProfileSet {
            revision: 0,
            profiles: vec![profile("peers", &ca)],
        },
        "operator",
        false,
    )
    .await
    .expect("put");
    crate::transport::bindings::put_cas(
        &state.db,
        crate::transport::bindings::BindingsSource::Stored,
        None,
        ServiceBindingSet {
            revision: ServiceBindingSet::empty().revision,
            bindings: vec![binding("binding:1", "peers")],
        },
    )
    .await
    .expect("bindings");

    let empty = TrustProfileSet {
        revision: 1,
        profiles: Vec::new(),
    };
    let error = trust::put_cas(&state, empty.clone(), "operator", false)
        .await
        .expect_err("still referenced");
    assert!(matches!(error, TrustError::StillReferenced { .. }));
    assert_eq!(error.code(), "trust_still_referenced");

    // …and the same write goes through when the operator says so explicitly.
    trust::put_cas(&state, empty, "operator", true)
        .await
        .expect("forced removal is allowed and audited");
    assert!(trust::load(&state).await.expect("load").profiles.is_empty());
}

#[test]
fn a_rollover_overlap_is_bounded_and_both_halves_are_required() {
    let now = Utc::now();
    let ca = DisposableCa::new("peers");
    let retiring = DisposableCa::new("old");
    let mut rolling = profile("peers", &ca);
    rolling.retiring_anchors_pem = Some(String::from_utf8(retiring.root_pem()).expect("pem"));
    rolling.overlap_until = Some(now + Duration::hours(1));
    assert!(rolling.bundle(now).is_ok());
    assert!(rolling.overlap_active(now));
    assert!(!rolling.overlap_active(now + Duration::hours(2)));

    // Too long.
    let mut unbounded = rolling.clone();
    unbounded.overlap_until = Some(now + Duration::seconds(MAX_OVERLAP_SECONDS + 60));
    assert!(unbounded.bundle(now).is_err());

    // Half a rollover is a configuration error.
    let mut dangling = profile("peers", &ca);
    dangling.overlap_until = Some(now + Duration::hours(1));
    assert!(dangling.bundle(now).is_err());
}

#[test]
fn the_retiring_anchors_drop_out_of_the_bundle_once_the_window_passes() {
    let now = Utc::now();
    let ca = DisposableCa::new("peers");
    let retiring = DisposableCa::new("old");
    let mut rolling = profile("peers", &ca);
    rolling.retiring_anchors_pem = Some(String::from_utf8(retiring.root_pem()).expect("pem"));
    rolling.overlap_until = Some(now + Duration::hours(1));

    let during = rolling.bundle(now).expect("during overlap");
    assert_eq!(during.anchors().len(), 2);
    let after = rolling
        .bundle(now + Duration::hours(2))
        .expect("after overlap");
    assert_eq!(
        after.anchors().len(),
        1,
        "a bounded overlap actually ends; the old root stops being trusted",
    );
}

#[test]
fn a_stored_profile_may_not_shadow_a_deployment_plane_one() {
    let now = Utc::now();
    let ca = DisposableCa::new("peers");
    let base: BTreeMap<_, _> = [(
        support::profile_ref("peers"),
        support::private_root("peers", &DisposableCa::new("deployment")),
    )]
    .into();
    let error = trust::bundles(
        &base,
        &TrustProfileSet {
            revision: 1,
            profiles: vec![profile("peers", &ca)],
        },
        now,
    )
    .expect_err("shadowing is refused");
    assert!(error.code() == "malformed_configuration");
}

#[test]
fn a_disabled_profile_contributes_no_anchors_at_all() {
    let now = Utc::now();
    let ca = DisposableCa::new("peers");
    let mut off = profile("peers", &ca);
    off.enabled = false;
    let built = trust::bundles(
        &BTreeMap::new(),
        &TrustProfileSet {
            revision: 1,
            profiles: vec![off],
        },
        now,
    )
    .expect("build");
    assert!(built.is_empty());
}

#[test]
fn a_duplicate_profile_name_is_refused_rather_than_last_one_wins() {
    let now = Utc::now();
    let ca = DisposableCa::new("peers");
    let set = TrustProfileSet {
        revision: 0,
        profiles: vec![profile("peers", &ca), profile("peers", &ca)],
    };
    assert!(set.validate(now).is_err());
}

#[tokio::test]
async fn reconcile_is_a_no_op_until_an_overlap_deadline_has_actually_passed() {
    let state = support::state().await;
    let now = Utc::now();
    // No epoch recorded: nothing to narrow, and no activation is attempted.
    trust::reconcile(&state, now).await.expect("no-op");
    state.transport_lifecycle.with_trust_epoch(|epoch| {
        epoch.next_overlap_expiry = Some(now + Duration::hours(1));
    });
    trust::reconcile(&state, now).await.expect("still no-op");
    assert_eq!(
        state
            .transport_lifecycle
            .with_trust_epoch(|epoch| epoch.next_overlap_expiry),
        Some(now + Duration::hours(1)),
    );
}
