//! LIFE-REVOCATION durability: a revoked leaf stays refused across a
//! restart, by a binding created after the revocation, and when revocations
//! race on the stored binding set. A durable layer that cannot be written is
//! an error, never a `200` with a note.

use std::collections::BTreeMap;

use chrono::{Duration, Utc};
use opensesame_domain::transport::{operations, BindingPurpose, BindingScope, ServiceBindingSet};

use crate::app_state::AppState;
use crate::transport::bindings::{self, BindingsSource};
use crate::transport::test_support::{binding, peer, runtime, set, tls_extensions, THUMB_A};
use crate::transport_lifecycle::revocation::{self, RevokeReason, RevokeRequest};
use crate::transport_lifecycle::revocation_store::{
    self, DurableError, Revoked, RevokedLeaf, RevokedLeaves, KV_REVOKED_LEAVES, MAX_REVOKED,
    MAX_REVOKED_PER_ORGANIZATION, OPERATOR_RESERVED,
};
use crate::transport_lifecycle::test_support as support;
use crate::transport_lifecycle::{boot, LifecycleState};

fn by_thumbprint(thumbprint: &str) -> RevokeRequest {
    RevokeRequest {
        certificate_id: None,
        thumbprint: Some(thumbprint.to_owned()),
        reason: RevokeReason::KeyCompromise,
    }
}

/// The same store, a fresh process: nothing in memory survives.
fn restarted(state: &AppState) -> AppState {
    AppState {
        transport_lifecycle: LifecycleState::new(),
        transport: None,
        ..state.clone()
    }
}

fn bridge_binding() -> ServiceBindingSet {
    set(vec![binding(
        "b1",
        "bridge.test",
        BindingPurpose::NatsAuthBridge,
        &[operations::NATS_CALLOUT_DECIDE],
        BindingScope::Deployment,
    )])
}

fn admits(state: &AppState) -> Result<(), String> {
    let extensions = tls_extensions(&peer("bridge.test", THUMB_A, 1), 1);
    crate::transport::admission::require_service_caller(
        state,
        &extensions,
        BindingPurpose::NatsAuthBridge,
        operations::NATS_CALLOUT_DECIDE,
    )
    .map(|_| ())
    .map_err(|refused| {
        refused
            .headers()
            .get("x-opensesame-transport-error")
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_owned()
    })
}

#[tokio::test]
async fn a_revoked_leaf_stays_refused_after_a_restart_even_by_a_later_binding() {
    let state = support::state().await;
    revocation::revoke_transport(
        &state,
        &state.connection_organization,
        revocation::Revoker::Operator,
        by_thumbprint(THUMB_A),
    )
    .await
    .expect("revoke");

    // Restart: a new process over the same store, and a binding for the
    // peer that is created only now, carrying no denied_thumbprints.
    let mut after = restarted(&state);
    assert!(!after.transport_lifecycle.is_denied(THUMB_A));
    boot::restore(&after).await.expect("restore");
    assert!(
        after.transport_lifecycle.is_denied(THUMB_A),
        "the revocation outlives the process that made it",
    );
    after.transport = Some(runtime(bridge_binding(), 1));
    assert_eq!(admits(&after), Err("evidence_revoked".to_owned()));

    // The control: the same later binding admits a leaf nobody revoked.
    let mut control = restarted(&support::state().await);
    control.transport = Some(runtime(bridge_binding(), 1));
    assert_eq!(admits(&control), Ok(()));
}

#[tokio::test]
async fn a_replica_picks_up_a_revocation_on_refresh() {
    let state = support::state().await;
    let replica = restarted(&state);
    revocation::revoke_transport(
        &state,
        &state.connection_organization,
        revocation::Revoker::Operator,
        by_thumbprint(THUMB_A),
    )
    .await
    .expect("revoke");
    assert!(!replica.transport_lifecycle.is_denied(THUMB_A));
    boot::refresh_once(&replica).await;
    assert!(replica.transport_lifecycle.is_denied(THUMB_A));
}

/// Revocations racing on one stored binding set: every lost compare-and-set
/// is retried against a fresh read, so none of them is dropped.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn racing_revocations_all_land_in_the_stored_bindings() {
    let state = support::state().await;
    bindings::put_cas(
        &state.db,
        BindingsSource::Stored,
        None,
        ServiceBindingSet {
            revision: ServiceBindingSet::empty().revision,
            bindings: bridge_binding().bindings,
        },
    )
    .await
    .expect("bindings");
    let thumbprints: Vec<String> = (1..=4).map(|i| format!("{i:064x}")).collect();
    let organization = state.connection_organization;
    let revoke = |thumbprint: String| {
        let state = state.clone();
        tokio::spawn(async move {
            revocation::revoke_transport(
                &state,
                &organization,
                revocation::Revoker::Operator,
                by_thumbprint(&thumbprint),
            )
            .await
        })
    };
    let handles: Vec<_> = thumbprints.iter().cloned().map(revoke).collect();
    for handle in handles {
        let outcome = handle.await.expect("join").expect("revoke");
        assert!(
            outcome.bindings.starts_with("updated"),
            "{}",
            outcome.bindings
        );
    }
    let stored = bindings::load(&state.db, None).await.expect("load").set;
    let (_, durable) = revocation_store::load(&state).await.expect("denylist");
    for thumbprint in &thumbprints {
        assert!(
            stored.bindings[0].denied_thumbprints.contains(thumbprint),
            "{thumbprint} was dropped by a lost race",
        );
        assert!(durable.contains(thumbprint));
    }
}

/// A binding store that refuses the write is an error response. The leaf is
/// still refused in this process and in the durable denylist.
#[tokio::test]
async fn a_bindings_write_that_cannot_apply_is_an_error_not_a_note() {
    let state = support::state().await;
    bindings::put_cas(
        &state.db,
        BindingsSource::Stored,
        None,
        ServiceBindingSet {
            revision: ServiceBindingSet::empty().revision,
            bindings: bridge_binding().bindings,
        },
    )
    .await
    .expect("bindings");
    sqlx::query(&format!(
        "CREATE TRIGGER bindings_down BEFORE UPDATE ON host_kv WHEN NEW.key = '{}' \
         BEGIN SELECT RAISE(ABORT, 'store down'); END",
        bindings::KV_SERVICE_BINDINGS,
    ))
    .execute(state.db.pool())
    .await
    .expect("trigger");
    let error = revocation::revoke_transport(
        &state,
        &state.connection_organization,
        revocation::Revoker::Operator,
        by_thumbprint(THUMB_A),
    )
    .await
    .expect_err("bindings not updated");
    assert_eq!(error.http_status(), 500);
    assert_eq!(error.code(), "storage_error");
    assert!(state.transport_lifecycle.is_denied(THUMB_A));
    let stored = state.db.get_host_kv(KV_REVOKED_LEAVES).await.expect("kv");
    assert!(stored.is_some_and(|raw| raw.contains(THUMB_A)));
}

#[tokio::test]
async fn a_corrupt_stored_denylist_stops_boot_rather_than_reading_as_empty() {
    let state = support::state().await;
    state
        .db
        .set_host_kv(KV_REVOKED_LEAVES, r#"{"thumbprints":["not-hex"]}"#)
        .await
        .expect("seed");
    assert!(boot::restore(&restarted(&state)).await.is_err());
}

fn filler(index: usize) -> String {
    format!("{:064x}", 0x00f0_0000 + index)
}

async fn seed(state: &AppState, leaves: &RevokedLeaves) {
    let json = serde_json::to_string(leaves).expect("encode");
    state
        .db
        .set_host_kv(KV_REVOKED_LEAVES, &json)
        .await
        .expect("seed");
}

async fn store_bridge_binding(state: &AppState) {
    bindings::put_cas(
        &state.db,
        BindingsSource::Stored,
        None,
        ServiceBindingSet {
            revision: ServiceBindingSet::empty().revision,
            bindings: bridge_binding().bindings,
        },
    )
    .await
    .expect("bindings");
}

/// A denylist nobody can add to any more still leaves the revocation durable
/// in the stored bindings, which a restarted process reads back.
#[tokio::test]
async fn a_full_denylist_still_reaches_the_stored_bindings_and_survives_a_restart() {
    let state = support::state().await;
    store_bridge_binding(&state).await;
    let full = RevokedLeaves {
        thumbprints: (0..MAX_REVOKED).map(filler).collect(),
        leaves: BTreeMap::new(),
    };
    seed(&state, &full).await;

    let error = revocation::revoke_transport(
        &state,
        &state.connection_organization,
        revocation::Revoker::Operator,
        by_thumbprint(THUMB_A),
    )
    .await
    .expect_err("the denylist is full");
    assert_eq!(error.code(), "denylist_full");
    assert!(state.transport_lifecycle.is_denied(THUMB_A));
    let stored = bindings::load(&state.db, None).await.expect("load").set;
    assert!(bindings::denies_thumbprint(&stored, THUMB_A));

    let mut after = restarted(&state);
    boot::restore(&after).await.expect("restore");
    let reloaded = bindings::load(&after.db, None).await.expect("load").set;
    assert!(bindings::denies_thumbprint(&reloaded, THUMB_A));
    after.transport = Some(runtime(reloaded, 1));
    assert!(
        admits(&after).is_err(),
        "the restarted process readmitted it"
    );
}

#[tokio::test]
async fn expired_entries_are_pruned_in_the_same_write() {
    let state = support::state().await;
    let now = Utc::now();
    let leaf = |days: i64| RevokedLeaf {
        organization: Some("org_tenant".into()),
        not_after: Some(now + Duration::days(days)),
    };
    // A list that is full only because of a long-expired leaf.
    let mut seeded = RevokedLeaves {
        thumbprints: (0..MAX_REVOKED - 2).map(filler).collect(),
        leaves: BTreeMap::new(),
    };
    seeded.leaves.insert(filler(MAX_REVOKED), leaf(-3));
    seeded.leaves.insert(filler(MAX_REVOKED + 1), leaf(30));
    seed(&state, &seeded).await;

    let revoked = Revoked {
        thumbprint: THUMB_A,
        organization: None,
        not_after: None,
    };
    revocation_store::persist(&state, &revoked, now)
        .await
        .expect("room once the expired leaf is pruned");
    let (_, stored) = revocation_store::load(&state).await.expect("load");
    assert!(stored.contains(THUMB_A));
    assert!(!stored.contains(&filler(MAX_REVOKED)), "expired leaf kept");
    assert!(
        stored.contains(&filler(MAX_REVOKED + 1)),
        "live leaf pruned"
    );
    assert!(
        stored.contains(&filler(0)),
        "an entry with no expiry pruned"
    );
}

/// Tenants filling their share, and one tenant at its own quota, refuse more
/// tenant revocations and never the operator's.
#[tokio::test]
async fn a_tenant_at_its_quota_cannot_block_an_operator_revocation() {
    let state = support::state().await;
    let now = Utc::now();
    let tenant_share = MAX_REVOKED - OPERATOR_RESERVED;
    let mut seeded = RevokedLeaves::default();
    for index in 0..tenant_share {
        let organization = format!("org_{}", index / MAX_REVOKED_PER_ORGANIZATION);
        let leaf = RevokedLeaf {
            organization: Some(organization),
            not_after: Some(now + Duration::days(30)),
        };
        seeded.leaves.insert(filler(index), leaf);
    }
    seed(&state, &seeded).await;

    let tenant = |thumbprint, organization| Revoked {
        thumbprint,
        organization: Some(organization),
        not_after: Some(now + Duration::days(30)),
    };
    let quota = revocation_store::persist(&state, &tenant(THUMB_A, "org_0"), now).await;
    assert!(matches!(quota, Err(DurableError::Quota)), "{quota:?}");
    let share = revocation_store::persist(&state, &tenant(THUMB_A, "org_new"), now).await;
    assert!(matches!(share, Err(DurableError::Full)), "{share:?}");

    revocation::revoke_transport(
        &state,
        &state.connection_organization,
        revocation::Revoker::Operator,
        by_thumbprint(THUMB_A),
    )
    .await
    .expect("the operator's revocation is never crowded out");
    let (_, stored) = revocation_store::load(&state).await.expect("load");
    assert!(stored.contains(THUMB_A));
}

/// Operator and legacy entries past `OPERATOR_RESERVED` do not let tenants
/// take the reserved slots: the tenant share counts every entry.
#[tokio::test]
async fn operator_and_legacy_entries_never_let_tenants_take_the_reserved_slots() {
    let state = support::state().await;
    let now = Utc::now();
    let tenant_share = MAX_REVOKED - OPERATOR_RESERVED;
    let operator = OPERATOR_RESERVED + 16;
    let mut seeded = RevokedLeaves {
        thumbprints: (0..operator).map(filler).collect(),
        leaves: BTreeMap::new(),
    };
    for index in operator..tenant_share {
        let leaf = RevokedLeaf {
            organization: Some(format!("org_{}", index / MAX_REVOKED_PER_ORGANIZATION)),
            not_after: Some(now + Duration::days(30)),
        };
        seeded.leaves.insert(filler(index), leaf);
    }
    seed(&state, &seeded).await;
    let tenant = Revoked {
        thumbprint: THUMB_A,
        organization: Some("org_new"),
        not_after: Some(now + Duration::days(30)),
    };
    let refused = revocation_store::persist(&state, &tenant, now).await;
    assert!(matches!(refused, Err(DurableError::Full)), "{refused:?}");

    // Every reserved slot is still the operator's, up to the last one.
    let (_, mut stored) = revocation_store::load(&state).await.expect("load");
    let reserved = MAX_REVOKED..MAX_REVOKED + OPERATOR_RESERVED - 1;
    stored.thumbprints.extend(reserved.map(filler));
    seed(&state, &stored).await;
    let last = Revoked {
        thumbprint: THUMB_A,
        organization: None,
        not_after: None,
    };
    revocation_store::persist(&state, &last, now)
        .await
        .expect("the operator's last reserved slot");
    let (_, stored) = revocation_store::load(&state).await.expect("load");
    assert_eq!(stored.all().count(), MAX_REVOKED);
}
