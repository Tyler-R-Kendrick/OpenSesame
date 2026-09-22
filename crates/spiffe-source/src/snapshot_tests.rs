use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;
use spiffe::{TrustDomain, X509Bundle, X509BundleSet, X509Context, X509Svid};

use super::SvidGeneration;
use crate::config::SpiffeSourceConfig;
use crate::fake::{FakeTrustDomain, IssuedSvid};

const TD: &str = "example.test";
const GW: &str = "spiffe://example.test/opensesame/gateway";
const WK: &str = "spiffe://example.test/opensesame/worker";

fn svid(issued: &IssuedSvid) -> Arc<X509Svid> {
    use secrecy::ExposeSecret as _;
    Arc::new(
        X509Svid::parse_from_der(
            &issued.chain_der.concat(),
            issued.key_pkcs8_der.expose_secret(),
        )
        .unwrap(),
    )
}

fn context(td: &FakeTrustDomain, svids: &[&IssuedSvid], with_bundle: bool) -> X509Context {
    let mut set = X509BundleSet::new();
    if with_bundle {
        set.add_bundle(
            X509Bundle::parse_from_der(TrustDomain::new(td.name()).unwrap(), &td.bundle_der())
                .unwrap(),
        );
    }
    X509Context::new(svids.iter().map(|s| svid(s)), set)
}

fn config() -> SpiffeSourceConfig {
    SpiffeSourceConfig::deployment_plane(GW, "/run/spire/api.sock").unwrap()
}

#[test]
fn at_spiffe_select_exact_identity_wins_regardless_of_order_and_hint() {
    let td = FakeTrustDomain::new(TD);
    let worker = td.issue_svid(WK, Duration::from_secs(60));
    let gateway = td.issue_svid(GW, Duration::from_secs(60));
    let ctx = context(&td, &[&worker, &gateway], true);
    assert_eq!(
        ctx.default_svid().unwrap().spiffe_id().to_string(),
        WK,
        "first returned is the worker"
    );
    let gen = SvidGeneration::select(&ctx, &config(), Utc::now()).unwrap();
    assert_eq!(gen.spiffe_id, GW);
    assert_eq!(gen.leaf_thumbprint_sha256, gateway.leaf_thumbprint_sha256);
    assert_eq!(gen.bundles.trust_domains().collect::<Vec<_>>(), vec![TD]);
    let dbg = format!("{gen:?}");
    assert!(!dbg.contains("PRIVATE"), "{dbg}");
}

#[test]
fn at_spiffe_select_first_returned_is_never_chosen_when_the_configured_id_is_absent() {
    let td = FakeTrustDomain::new(TD);
    let worker = td.issue_svid(WK, Duration::from_secs(60));
    let ctx = context(&td, &[&worker], true);
    let err = SvidGeneration::select(&ctx, &config(), Utc::now()).unwrap_err();
    assert_eq!(err.code(), "svid_not_issued");
    assert!(err.is_withdrawal());
    assert_eq!(err.to_transport_error().code(), "identity_missing");
}

#[test]
fn duplicate_configured_identity_is_ambiguous_not_first_wins() {
    let td = FakeTrustDomain::new(TD);
    let one = td.issue_svid(GW, Duration::from_secs(60));
    let two = td.issue_svid(GW, Duration::from_secs(60));
    let ctx = context(&td, &[&one, &two], true);
    let err = SvidGeneration::select(&ctx, &config(), Utc::now()).unwrap_err();
    assert_eq!(err.code(), "svid_ambiguous");
    assert!(!err.is_withdrawal());
}

#[test]
fn missing_own_bundle_is_an_authoritative_withdrawal() {
    let td = FakeTrustDomain::new(TD);
    let gateway = td.issue_svid(GW, Duration::from_secs(60));
    let ctx = context(&td, &[&gateway], false);
    let err = SvidGeneration::select(&ctx, &config(), Utc::now()).unwrap_err();
    assert_eq!(err.code(), "bundle_missing");
    assert!(err.is_withdrawal());
    assert_eq!(err.to_transport_error().code(), "trust_unknown");
}

#[test]
fn profile_violation_is_a_malformed_update_not_a_withdrawal() {
    let td = FakeTrustDomain::new(TD);
    let mut spec = crate::fake::SvidSpec::conforming(GW, Duration::from_secs(60));
    spec.eku = crate::fake::Eku::ServerOnly;
    let bad = td.issue(&spec);
    let ctx = context(&td, &[&bad], true);
    let err = SvidGeneration::select(&ctx, &config(), Utc::now()).unwrap_err();
    assert_eq!(err.code(), "svid_profile");
    assert!(!err.is_withdrawal());
}

#[test]
fn rotation_keeps_the_canonical_identity_and_changes_the_thumbprint() {
    let td = FakeTrustDomain::new(TD);
    let first = td.issue_svid(GW, Duration::from_secs(60));
    let second = td.issue_svid(GW, Duration::from_secs(60));
    let g1 = SvidGeneration::select(&context(&td, &[&first], true), &config(), Utc::now()).unwrap();
    let g2 =
        SvidGeneration::select(&context(&td, &[&second], true), &config(), Utc::now()).unwrap();
    assert_eq!(g1.spiffe_id, g2.spiffe_id);
    assert_ne!(g1.leaf_thumbprint_sha256, g2.leaf_thumbprint_sha256);
    assert_ne!(g1.chain_pem(), g2.chain_pem());
}
