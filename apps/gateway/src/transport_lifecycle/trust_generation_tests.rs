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
