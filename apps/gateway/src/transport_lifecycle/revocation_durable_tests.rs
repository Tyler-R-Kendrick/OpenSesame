//! LIFE-REVOCATION durability: a revoked leaf stays refused across a
//! restart, by a binding created after the revocation, and when revocations
//! race on the stored binding set. A durable layer that cannot be written is
//! an error, never a `200` with a note.

use opensesame_domain::transport::{operations, BindingPurpose, BindingScope, ServiceBindingSet};

use crate::app_state::AppState;
use crate::transport::bindings::{self, BindingsSource};
use crate::transport::test_support::{binding, peer, runtime, set, tls_extensions, THUMB_A};
use crate::transport_lifecycle::revocation::{self, RevokeReason, RevokeRequest};
use crate::transport_lifecycle::revocation_store::{self, KV_REVOKED_LEAVES};
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
            revocation::revoke_transport(&state, &organization, by_thumbprint(&thumbprint)).await
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
        assert!(durable.thumbprints.contains(thumbprint));
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
