//! `TransportGenerations::activate_if_current`: a candidate derived from a
//! snapshot of one generation is activated only while that generation is
//! still serving and has not been withdrawn.

mod common;

use std::sync::Arc;

use common::*;
use opensesame_domain::transport::TransportError;
use opensesame_transport_security::testkit::DisposableCa;
use opensesame_transport_security::GenerationCandidate;

fn copy_of_current(
    gens: &opensesame_transport_security::TransportGenerations,
) -> (u64, GenerationCandidate) {
    let current = gens.current();
    (
        current.number,
        GenerationCandidate {
            identity: current.identity.clone(),
            peer_trust: current.peer_trust.clone(),
            own_trust: None,
            identity_required: true,
        },
    )
}

#[test]
fn an_unchanged_generation_is_replaced() {
    let server_ca = DisposableCa::new("servers");
    let gens = generations(
        server_ca.issue_server("localhost").identity(),
        &DisposableCa::new("clients"),
    );
    let (seen, candidate) = copy_of_current(&gens);
    assert_eq!(gens.activate_if_current(seen, candidate), Ok(seen + 1));
    assert_eq!(gens.current().number, seen + 1);
}

/// A rotation that landed after the snapshot wins; the older material is
/// never swapped back in over it.
#[test]
fn a_rotation_in_between_is_not_overwritten() {
    let server_ca = DisposableCa::new("servers");
    let gens = generations(
        server_ca.issue_server("localhost").identity(),
        &DisposableCa::new("clients"),
    );
    let (seen, stale) = copy_of_current(&gens);
    let rotated = Arc::new(server_ca.issue_server("localhost").identity());
    let rotated_thumbprint = rotated.leaf_thumbprint_sha256();
    gens.activate(GenerationCandidate {
        identity: Some(rotated),
        peer_trust: gens.current().peer_trust.clone(),
        own_trust: None,
        identity_required: true,
    })
    .expect("rotation");
    let after_rotation = gens.current().number;

    assert_eq!(
        gens.activate_if_current(seen, stale),
        Err(TransportError::GenerationStale)
    );
    let current = gens.current();
    assert_eq!(current.number, after_rotation);
    assert_eq!(
        current
            .identity
            .as_ref()
            .map(|identity| identity.leaf_thumbprint_sha256()),
        Some(rotated_thumbprint),
    );
}

/// A withdrawn generation stays withdrawn: copying its identity into a new
/// candidate does not clear the withdrawal, whichever number it names.
#[test]
fn a_withdrawn_generation_is_never_reactivated() {
    let server_ca = DisposableCa::new("servers");
    let gens = generations(
        server_ca.issue_server("localhost").identity(),
        &DisposableCa::new("clients"),
    );
    gens.withdraw(TransportError::EvidenceRevoked);
    let (seen, candidate) = copy_of_current(&gens);
    assert_eq!(
        gens.activate_if_current(seen, candidate),
        Err(TransportError::GenerationStale)
    );
    let current = gens.current();
    assert_eq!(current.number, seen);
    assert_eq!(current.withdrawn, Some(TransportError::EvidenceRevoked));
}
