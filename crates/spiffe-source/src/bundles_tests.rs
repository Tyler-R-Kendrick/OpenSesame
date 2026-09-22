use std::time::Duration;

use chrono::Utc;

use super::{PeerVerifyError, TrustDomainBundles};
use crate::fake::FakeTrustDomain;
use crate::svid_profile::{SvidProfileError, SvidRole};

const A: &str = "a.test";
const B: &str = "b.test";
const PEER_A: &str = "spiffe://a.test/peer";
const PEER_B: &str = "spiffe://b.test/peer";

fn bundles(domains: &[&FakeTrustDomain]) -> TrustDomainBundles {
    let mut out = TrustDomainBundles::default();
    for td in domains {
        out.insert(td.name(), vec![td.ca_der().to_vec()]).unwrap();
    }
    out
}

#[test]
fn peer_verifies_against_its_own_domain_and_the_allowed_set() {
    let a = FakeTrustDomain::new(A);
    let leaf = a.issue_svid(PEER_A, Duration::from_secs(60));
    let bundles = bundles(&[&a]);
    let chain: Vec<&[u8]> = leaf.chain_der.iter().map(Vec::as_slice).collect();
    let facts = bundles
        .verify_peer(&chain, SvidRole::Client, &[PEER_A], Utc::now())
        .unwrap();
    assert_eq!(facts.spiffe_id, PEER_A);
    assert_eq!(
        bundles.verify_peer(
            &chain,
            SvidRole::Client,
            &["spiffe://a.test/other"],
            Utc::now()
        ),
        Err(PeerVerifyError::PeerNotAllowed {
            presented: PEER_A.into()
        })
    );
    assert_eq!(
        bundles
            .verify_peer(&chain[..1], SvidRole::Client, &[PEER_A], Utc::now())
            .map(|f| f.spiffe_id),
        Ok(PEER_A.into()),
        "leaf alone chains straight to the anchor"
    );
}

#[test]
fn at_spiffe_federation_domain_a_bundle_never_vouches_for_a_domain_b_svid() {
    let a = FakeTrustDomain::new(A);
    let b = FakeTrustDomain::new(B);
    let leaf_b = b.issue_svid(PEER_B, Duration::from_secs(60));
    let chain: Vec<&[u8]> = leaf_b.chain_der.iter().map(Vec::as_slice).collect();

    // Only A's bundle known: B's SVID is unroutable, A's anchors are not tried.
    let only_a = bundles(&[&a]);
    assert_eq!(
        only_a.verify_peer(&chain, SvidRole::Client, &[PEER_B], Utc::now()),
        Err(PeerVerifyError::NoBundleForPresentedDomain {
            trust_domain: B.into()
        })
    );

    // A's anchors filed under B's name (a mis-federated bundle): chain fails.
    let mut swapped = TrustDomainBundles::default();
    swapped.insert(B, vec![a.ca_der().to_vec()]).unwrap();
    assert!(matches!(
        swapped.verify_peer(&chain, SvidRole::Client, &[PEER_B], Utc::now()),
        Err(PeerVerifyError::ChainInvalid(_))
    ));

    // Both known: B verifies under B, and removing B withdraws it at once.
    let both = bundles(&[&a, &b]);
    assert!(both
        .verify_peer(&chain, SvidRole::Client, &[PEER_B], Utc::now())
        .is_ok());
    let after_removal = bundles(&[&a]);
    assert!(after_removal
        .verify_peer(&chain, SvidRole::Client, &[PEER_B], Utc::now())
        .is_err());
}

#[test]
fn a_rotated_ca_replaces_the_domain_and_old_leaves_stop_verifying() {
    let old = FakeTrustDomain::new(A);
    let new = FakeTrustDomain::new(A);
    let leaf_old = old.issue_svid(PEER_A, Duration::from_secs(60));
    let chain: Vec<&[u8]> = leaf_old.chain_der.iter().map(Vec::as_slice).collect();
    let mut b = bundles(&[&old]);
    assert!(b
        .verify_peer(&chain, SvidRole::Client, &[PEER_A], Utc::now())
        .is_ok());
    b.insert(A, vec![new.ca_der().to_vec()]).unwrap();
    assert!(matches!(
        b.verify_peer(&chain, SvidRole::Client, &[PEER_A], Utc::now()),
        Err(PeerVerifyError::ChainInvalid(_))
    ));
}

#[test]
fn at_tls_purpose_peer_role_is_checked_by_webpki_and_the_profile() {
    let a = FakeTrustDomain::new(A);
    let mut spec = crate::fake::SvidSpec::conforming(PEER_A, Duration::from_secs(60));
    spec.eku = crate::fake::Eku::ServerOnly;
    let leaf = a.issue(&spec);
    let chain: Vec<&[u8]> = leaf.chain_der.iter().map(Vec::as_slice).collect();
    let b = bundles(&[&a]);
    assert!(matches!(
        b.verify_peer(&chain, SvidRole::Client, &[PEER_A], Utc::now()),
        Err(PeerVerifyError::ChainInvalid(_) | PeerVerifyError::Profile(_))
    ));
    assert_eq!(
        b.verify_peer(&chain, SvidRole::Server, &[PEER_A], Utc::now()),
        Err(PeerVerifyError::Profile(
            SvidProfileError::ExtendedKeyUsageLacks {
                needed: "client_auth"
            }
        ))
    );
}

#[test]
fn a_ca_leaf_is_refused_as_a_peer_even_when_it_chains() {
    let a = FakeTrustDomain::new(A);
    let mut spec = crate::fake::SvidSpec::conforming(PEER_A, Duration::from_secs(60));
    spec.is_ca = true;
    spec.key_usages = vec![
        rcgen::KeyUsagePurpose::DigitalSignature,
        rcgen::KeyUsagePurpose::KeyCertSign,
    ];
    let leaf = a.issue(&spec);
    let chain: Vec<&[u8]> = leaf.chain_der.iter().map(Vec::as_slice).collect();
    assert!(bundles(&[&a])
        .verify_peer(&chain, SvidRole::Client, &[PEER_A], Utc::now())
        .is_err());
}

#[test]
fn bundle_insert_rejects_empty_garbage_and_non_ca_material() {
    let a = FakeTrustDomain::new(A);
    let mut b = TrustDomainBundles::default();
    assert_eq!(b.insert(A, vec![]).unwrap_err().code(), "bundle_malformed");
    assert_eq!(
        b.insert(A, vec![vec![1, 2, 3]]).unwrap_err().code(),
        "bundle_malformed"
    );
    let leaf = a.issue_svid(PEER_A, Duration::from_secs(60));
    assert_eq!(
        b.insert(A, vec![leaf.leaf_der().to_vec()])
            .unwrap_err()
            .code(),
        "bundle_malformed"
    );
    assert!(b.is_empty());
    assert_eq!(
        TrustDomainBundles::default().verify_peer(&[], SvidRole::Client, &[], Utc::now()),
        Err(PeerVerifyError::EmptyChain)
    );
}
