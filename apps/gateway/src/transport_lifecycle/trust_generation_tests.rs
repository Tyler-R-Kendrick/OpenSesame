//! LIFE-TRUST against a live generation: a trust write never resurrects a
//! withdrawn generation, never rolls deployment-plane bundles back to their
//! boot snapshot, never overwrites a concurrent rotation, and two writers
//! with the same revision cannot both win.

use std::sync::Arc;

use opensesame_domain::transport::{TransportError, TrustProfileKind};
use opensesame_transport_security::testkit::DisposableCa;
use opensesame_transport_security::{GenerationCandidate, TransportGenerations};

use crate::app_state::AppState;
use crate::transport_lifecycle::test_support::{self as support, CLIENTS};
use crate::transport_lifecycle::trust::{self, StoredTrustProfile, TrustError, TrustProfileSet};
use crate::transport_lifecycle::{activation, HOST_LISTENER_TARGET};

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

fn one_profile(revision: u32) -> TrustProfileSet {
    TrustProfileSet {
        revision,
        profiles: vec![profile("peers", &DisposableCa::new("peers"))],
    }
}

/// A state whose lifecycle is attached to a real generation manager, the
/// way `transport_lifecycle::boot::attach` does it: the boot-time peer trust
/// is recorded as the deployment plane's base map.
fn attached(state: &AppState, client_ca: &DisposableCa) -> Arc<TransportGenerations> {
    let server = DisposableCa::new("servers")
        .issue_server("localhost")
        .identity();
    let generations = support::generations(server, client_ca);
    state.transport_lifecycle.attach_generations(
        generations.clone(),
        generations.current().peer_trust.clone(),
    );
    generations
}

#[tokio::test]
async fn a_trust_write_does_not_resurrect_a_withdrawn_generation() {
    let state = support::state().await;
    let generations = attached(&state, &DisposableCa::new("clients"));
    generations.withdraw(TransportError::EvidenceRevoked);
    let withdrawn = generations.current().number;

    let error = trust::put_cas(&state, one_profile(0), "operator", false)
        .await
        .expect_err("a withdrawn generation is not reactivated by a trust write");
    assert!(matches!(error, TrustError::Withdrawn(_)), "{error:?}");
    assert_eq!(error.http_status(), 409);
    assert_eq!(error.code(), "generation_withdrawn");

    let current = generations.current();
    assert_eq!(current.number, withdrawn, "nothing was activated");
    assert_eq!(current.withdrawn, Some(TransportError::EvidenceRevoked));
    assert_eq!(
        trust::load(&state).await.expect("load").revision,
        0,
        "a refused write stores nothing",
    );
}

/// A deployment-plane source rotated its bundle after boot (what the SPIFFE
/// Workload API does on every snapshot). A trust write keeps the rotated
/// bundle; the root the boot snapshot held is not trusted again.
#[tokio::test]
async fn a_trust_write_keeps_a_rotated_deployment_plane_bundle() {
    let state = support::state().await;
    let boot_ca = DisposableCa::new("clients-boot");
    let rotated_ca = DisposableCa::new("clients-rotated");
    let generations = attached(&state, &boot_ca);
    let current = generations.current();
    generations
        .activate(GenerationCandidate {
            identity: current.identity.clone(),
            peer_trust: [(
                support::profile_ref(CLIENTS),
                support::private_root(CLIENTS, &rotated_ca),
            )]
            .into(),
            own_trust: None,
            identity_required: true,
        })
        .expect("deployment-plane rotation");

    trust::put_cas(&state, one_profile(0), "operator", false)
        .await
        .expect("put");

    let serving = generations.current();
    let clients = serving
        .trust(&support::profile_ref(CLIENTS))
        .expect("deployment-plane profile still served");
    let rotated = support::private_root(CLIENTS, &rotated_ca);
    let boot = support::private_root(CLIENTS, &boot_ca);
    assert_eq!(clients.anchor_thumbprints(), rotated.anchor_thumbprints());
    assert!(
        !clients
            .anchor_thumbprints()
            .iter()
            .any(|thumbprint| boot.anchor_thumbprints().contains(thumbprint)),
        "the boot-time root must not be trusted again",
    );
    assert!(serving.trust(&support::profile_ref("peers")).is_ok());
}

/// The activation a trust write uses is conditional on the generation it
/// was built from: a rotation that landed in between wins, and the refusal
/// records no `reload_failed` for material that was never tried.
#[tokio::test]
async fn a_candidate_built_from_an_older_generation_is_refused() {
    let state = support::state().await;
    let generations = attached(&state, &DisposableCa::new("clients"));
    let seen = generations.current();
    let outdated = GenerationCandidate {
        identity: seen.identity.clone(),
        peer_trust: seen.peer_trust.clone(),
        own_trust: None,
        identity_required: true,
    };
    let rotated = Arc::new(
        DisposableCa::new("servers-2")
            .issue_server("localhost")
            .identity(),
    );
    let rotated_thumbprint = rotated.leaf_thumbprint_sha256();
    generations
        .activate(activation::candidate_with_identity(&generations, rotated))
        .expect("rotation");

    let refused = activation::activate_candidate_if_current(
        &state,
        HOST_LISTENER_TARGET,
        &generations,
        seen.number,
        outdated,
    )
    .await;
    assert_eq!(refused, Err(TransportError::GenerationStale));
    assert_eq!(
        generations
            .current()
            .identity
            .as_ref()
            .map(|identity| identity.leaf_thumbprint_sha256()),
        Some(rotated_thumbprint),
        "the rotated identity keeps serving",
    );
}

/// LIFE-TRUST CAS is serialized: two writes carrying the same revision
/// cannot both pass the compare, however their awaits interleave.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn two_same_revision_writes_exactly_one_succeeds() {
    let state = support::state().await;
    attached(&state, &DisposableCa::new("clients"));
    let (first, second) = tokio::join!(
        trust::put_cas(&state, one_profile(0), "operator-a", false),
        trust::put_cas(&state, one_profile(0), "operator-b", false),
    );
    let outcomes = [first, second];
    let won = outcomes.iter().filter(|outcome| outcome.is_ok()).count();
    assert_eq!(won, 1, "exactly one same-revision write wins");
    assert!(outcomes
        .iter()
        .any(|outcome| matches!(outcome, Err(TrustError::StaleRevision { current: 1 }))));
    assert_eq!(trust::load(&state).await.expect("load").revision, 1);
}

/// A second gateway process over the same store: its own lifecycle and its
/// own serving generation, the database shared.
fn replica(state: &AppState, client_ca: &DisposableCa) -> (AppState, Arc<TransportGenerations>) {
    let other = AppState {
        transport_lifecycle: crate::transport_lifecycle::LifecycleState::new(),
        ..state.clone()
    };
    let generations = attached(&other, client_ca);
    (other, generations)
}

fn serves(generations: &TransportGenerations, name: &str) -> bool {
    generations
        .current()
        .trust(&support::profile_ref(name))
        .is_ok()
}

/// Replica B keeps nothing A removed past its next refresh, and a write B
/// builds on the revision it last saw is refused against the stored one.
#[tokio::test]
async fn a_replica_adopts_a_removal_on_refresh_and_its_stale_write_is_refused() {
    let client_ca = DisposableCa::new("clients");
    let a = support::state().await;
    let a_generations = attached(&a, &client_ca);
    let (b, b_generations) = replica(&a, &client_ca);

    trust::put_cas(&a, one_profile(0), "operator-a", false)
        .await
        .expect("A adds");
    assert!(serves(&a_generations, "peers"));
    assert!(!serves(&b_generations, "peers"), "B has not refreshed yet");
    assert!(trust::refresh(&b, chrono::Utc::now())
        .await
        .expect("B refresh"));
    assert!(serves(&b_generations, "peers"), "B adopts A's addition");

    let removal = TrustProfileSet {
        revision: 1,
        profiles: Vec::new(),
    };
    trust::put_cas(&a, removal, "operator-a", false)
        .await
        .expect("A removes");
    assert!(!serves(&a_generations, "peers"));
    assert!(serves(&b_generations, "peers"), "B still on revision 1");
    assert!(trust::refresh(&b, chrono::Utc::now())
        .await
        .expect("B refresh"));
    assert!(
        !serves(&b_generations, "peers"),
        "B stops trusting the removed anchor without a restart",
    );
    assert!(
        !trust::refresh(&b, chrono::Utc::now()).await.expect("again"),
        "nothing newer: a refresh is a no-op",
    );

    // B still holds revision 1 in hand; the store is at 2.
    let error = trust::put_cas(&b, one_profile(1), "operator-b", false)
        .await
        .expect_err("stale against the store");
    assert!(
        matches!(error, TrustError::StaleRevision { current: 2 }),
        "{error:?}"
    );
    assert!(!serves(&b_generations, "peers"));
    assert!(!serves(&a_generations, "peers"));
    assert_eq!(trust::load(&a).await.expect("load").revision, 2);
}

/// A document over the size bound is refused before anything activates.
#[tokio::test]
async fn an_oversized_document_leaves_the_running_generation_unchanged() {
    let state = support::state().await;
    let generations = attached(&state, &DisposableCa::new("clients"));
    let before = generations.current().number;
    // Explanatory text outside the PEM blocks: each profile's anchors stay
    // within their own bound and still build, the document as a whole
    // does not fit.
    let padding = "padding outside any pem block\n".repeat(1_400);
    let padded = |name: &str| {
        let mut stored = profile(name, &DisposableCa::new(name));
        stored.anchors_pem.push_str(&padding);
        stored
    };
    let oversized = TrustProfileSet {
        revision: 0,
        profiles: vec![padded("peers-a"), padded("peers-b")],
    };
    let error = trust::put_cas(&state, oversized, "operator", false)
        .await
        .expect_err("oversized");
    assert!(matches!(error, TrustError::Invalid(_)), "{error:?}");
    assert_eq!(error.http_status(), 400);
    assert_eq!(generations.current().number, before, "nothing activated");
    assert!(!serves(&generations, "peers-a"));
    assert_eq!(trust::load(&state).await.expect("load").revision, 0);
}

/// A store that refuses the write leaves the serving anchors as they were.
#[tokio::test]
async fn a_store_failure_leaves_the_running_generation_unchanged() {
    let state = support::state().await;
    let generations = attached(&state, &DisposableCa::new("clients"));
    let before = generations.current().number;
    for event in ["INSERT", "UPDATE"] {
        sqlx::query(&format!(
            "CREATE TRIGGER trust_store_down_{event} BEFORE {event} ON host_kv \
             WHEN NEW.key = '{}' BEGIN SELECT RAISE(ABORT, 'store down'); END",
            trust::KV_TRUST_PROFILES,
        ))
        .execute(state.db.pool())
        .await
        .expect("trigger");
    }
    let error = trust::put_cas(&state, one_profile(0), "operator", false)
        .await
        .expect_err("store down");
    assert!(matches!(error, TrustError::Storage(_)), "{error:?}");
    assert_eq!(error.http_status(), 500);
    assert_eq!(generations.current().number, before, "nothing activated");
    assert!(!serves(&generations, "peers"));
}
