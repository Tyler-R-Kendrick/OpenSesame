//! SPI-ISOLATION: a source configured for one workload identity cannot be
//! used to satisfy a binding for another. Resolution is exact-match on the
//! SPIFFE ID the generation manager will present, through the one binding
//! ledger (`ServiceBindingSet`), so a wrong identity is `peer_not_bound`.

use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;
use opensesame_domain::{
    BindingPurpose, BindingScope, PeerIdentitySelector, ServiceBinding, ServiceBindingSet,
    TransportError, TrustProfileRef,
};
use opensesame_spiffe_source::fake::{FakeTrustDomain, IssuedSvid};
use opensesame_spiffe_source::sink::TransportGenerationsSink;
use opensesame_spiffe_source::{SpiffeSourceConfig, SvidGeneration};
use secrecy::ExposeSecret as _;
use spiffe::{TrustDomain, X509Bundle, X509BundleSet, X509Context, X509Svid};

const TD: &str = "example.test";
const A: &str = "spiffe://example.test/a";
const B: &str = "spiffe://example.test/b";

fn binding(id: &str, peer: &str) -> ServiceBinding {
    ServiceBinding {
        id: id.to_owned(),
        revision: 1,
        enabled: true,
        revoked: false,
        scope: BindingScope::Deployment,
        trust_profile: TrustProfileRef::new(TD).unwrap(),
        peer: PeerIdentitySelector::SpiffeId(peer.to_owned()),
        service_principal: format!("svc:{id}"),
        purpose: BindingPurpose::WorkerClient,
        allowed_operations: vec!["worker.health.ready".to_owned()],
        allowed_audiences: vec![],
        not_after: None,
        denied_thumbprints: vec![],
    }
}

fn generation_for(td: &FakeTrustDomain, issued: &IssuedSvid, configured: &str) -> SvidGeneration {
    let svid = Arc::new(
        X509Svid::parse_from_der(
            &issued.chain_der.concat(),
            issued.key_pkcs8_der.expose_secret(),
        )
        .unwrap(),
    );
    let mut set = X509BundleSet::new();
    set.add_bundle(
        X509Bundle::parse_from_der(TrustDomain::new(TD).unwrap(), &td.bundle_der()).unwrap(),
    );
    let ctx = X509Context::new([svid], set);
    let cfg = SpiffeSourceConfig::deployment_plane(configured, "/run/spire/api.sock").unwrap();
    SvidGeneration::select(&ctx, &cfg, Utc::now()).unwrap()
}

fn presented(generation: &SvidGeneration) -> Vec<PeerIdentitySelector> {
    vec![
        PeerIdentitySelector::SpiffeId(generation.spiffe_id.clone()),
        PeerIdentitySelector::LeafThumbprintSha256(generation.leaf_thumbprint_sha256.clone()),
    ]
}

#[test]
fn a_source_for_a_cannot_satisfy_a_binding_for_b() {
    let td = FakeTrustDomain::new(TD);
    let issued_a = td.issue_svid(A, Duration::from_secs(60));
    let gen_a = generation_for(&td, &issued_a, A);
    let profile = TrustProfileRef::new(TD).unwrap();
    let only_b = ServiceBindingSet {
        revision: 1,
        bindings: vec![binding("worker-b", B)],
    };
    only_b.validate().unwrap();
    assert_eq!(
        only_b
            .resolve(
                &profile,
                &presented(&gen_a),
                BindingPurpose::WorkerClient,
                Utc::now()
            )
            .err(),
        Some(TransportError::PeerNotBound)
    );
    let both = ServiceBindingSet {
        revision: 2,
        bindings: vec![binding("worker-b", B), binding("worker-a", A)],
    };
    let resolved = both
        .resolve(
            &profile,
            &presented(&gen_a),
            BindingPurpose::WorkerClient,
            Utc::now(),
        )
        .unwrap();
    assert_eq!(resolved.service_principal, "svc:worker-a");
}

#[test]
fn the_generation_manager_only_ever_presents_the_configured_identity() {
    let td = FakeTrustDomain::new(TD);
    let issued_a = td.issue_svid(A, Duration::from_secs(60));
    let gen_a = generation_for(&td, &issued_a, A);
    let candidate = TransportGenerationsSink::candidate(&gen_a).unwrap();
    let identity = candidate.identity.expect("identity");
    assert_eq!(identity.spiffe_id(), Some(A));
    assert!(identity
        .selectors()
        .iter()
        .all(|s| !matches!(s, PeerIdentitySelector::SpiffeId(id) if id == B)));
    assert_eq!(candidate.own_trust, Some(TrustProfileRef::new(TD).unwrap()));
    assert!(candidate.identity_required);
    assert_eq!(candidate.peer_trust.len(), 1);
}

#[test]
fn a_snapshot_carrying_only_b_never_yields_a_generation_for_a() {
    let td = FakeTrustDomain::new(TD);
    let issued_b = td.issue_svid(B, Duration::from_secs(60));
    let svid = Arc::new(
        X509Svid::parse_from_der(
            &issued_b.chain_der.concat(),
            issued_b.key_pkcs8_der.expose_secret(),
        )
        .unwrap(),
    );
    let mut set = X509BundleSet::new();
    set.add_bundle(
        X509Bundle::parse_from_der(TrustDomain::new(TD).unwrap(), &td.bundle_der()).unwrap(),
    );
    let ctx = X509Context::new([svid], set);
    let cfg = SpiffeSourceConfig::deployment_plane(A, "/run/spire/api.sock").unwrap();
    let err = SvidGeneration::select(&ctx, &cfg, Utc::now()).unwrap_err();
    assert_eq!(err.to_transport_error(), TransportError::IdentityMissing);
}
