//! AT-TLS-BADCONFIG, one case per refusal.
//!
//! Every one of these is a deployment that *asked* for an authenticating
//! profile and cannot have it. The assertion in each case is the same: an
//! error, with a stable code — never a `TransportConfig` that quietly reads
//! as "no TLS configured", and never a legacy mode.

use opensesame_domain::transport::{BindingPurpose, TransportError};

use super::config::{AuthMode, TransportConfig};
use super::managed::NoManagedIdentity;
use super::test_support::lookup;
use super::TransportRuntime;

const TOKEN: &str = "mapping-token-0123456789abcdef0123456789";
const SECRET: &str = "callout-secret-0123456789abcdef0123456789";

fn parse(pairs: Vec<(&'static str, &str)>) -> Result<TransportConfig, TransportError> {
    let owned = pairs
        .into_iter()
        .map(|(k, v)| (k, v.to_owned()))
        .collect::<Vec<_>>();
    TransportConfig::from_lookup(&lookup(owned))
}

fn mtls_listener(extra: Vec<(&'static str, &str)>) -> Vec<(&'static str, &str)> {
    let mut pairs = vec![
        ("OPENSESAME_TLS_LISTEN", "127.0.0.1:8443"),
        ("OPENSESAME_TLS_POLICY", "mtls_required"),
        ("OPENSESAME_TLS_IDENTITY_SOURCE", "pem"),
        ("OPENSESAME_TLS_CERT_FILE", "/tmp/cert.pem"),
        ("OPENSESAME_TLS_KEY_FILE", "/tmp/key.pem"),
        ("OPENSESAME_TLS_TRUST_FILE", "/tmp/ca.pem"),
        ("OPENSESAME_TLS_TRUST_KIND", "private_root"),
    ];
    pairs.extend(extra);
    pairs
}

#[test]
fn nothing_configured_is_not_an_error() {
    let config = parse(vec![]).expect("empty configuration");
    assert!(config.listener.is_none());
    assert_eq!(config.mapping_auth, AuthMode::Unconfigured);
    assert_eq!(config.callout_auth, AuthMode::Unconfigured);
    assert!(!config.mapping_client_required());
}

#[test]
fn a_listener_and_a_policy_require_each_other() {
    assert!(parse(vec![("OPENSESAME_TLS_LISTEN", "127.0.0.1:8443")]).is_err());
    assert!(parse(vec![("OPENSESAME_TLS_POLICY", "mtls_required")]).is_err());
}

#[test]
fn an_unknown_policy_or_source_word_is_refused() {
    assert!(parse(vec![
        ("OPENSESAME_TLS_LISTEN", "127.0.0.1:8443"),
        ("OPENSESAME_TLS_POLICY", "auto"),
    ])
    .is_err());
    assert!(parse(vec![
        ("OPENSESAME_TLS_LISTEN", "127.0.0.1:8443"),
        ("OPENSESAME_TLS_POLICY", "mtls_required"),
        ("OPENSESAME_TLS_IDENTITY_SOURCE", "keychain"),
    ])
    .is_err());
}

#[test]
fn a_required_listener_without_material_refuses() {
    // No identity source at all.
    assert_eq!(
        parse(vec![
            ("OPENSESAME_TLS_LISTEN", "127.0.0.1:8443"),
            ("OPENSESAME_TLS_POLICY", "mtls_required"),
        ])
        .unwrap_err()
        .code(),
        "identity_missing"
    );
    // Identity but no bundle to verify clients with.
    assert_eq!(
        parse(vec![
            ("OPENSESAME_TLS_LISTEN", "127.0.0.1:8443"),
            ("OPENSESAME_TLS_POLICY", "mtls_required"),
            ("OPENSESAME_TLS_IDENTITY_SOURCE", "pem"),
            ("OPENSESAME_TLS_CERT_FILE", "/tmp/cert.pem"),
            ("OPENSESAME_TLS_KEY_FILE", "/tmp/key.pem"),
        ])
        .unwrap_err()
        .code(),
        "trust_unknown"
    );
}

#[test]
fn the_public_web_pki_cannot_authenticate_clients() {
    assert!(parse(mtls_listener(vec![(
        "OPENSESAME_TLS_TRUST_KIND",
        "webpki_dns"
    )]))
    .is_err());
}

#[test]
fn server_tls_refuses_client_trust_rather_than_implying_mtls() {
    assert!(parse(vec![
        ("OPENSESAME_TLS_LISTEN", "127.0.0.1:8443"),
        ("OPENSESAME_TLS_POLICY", "server_tls"),
        ("OPENSESAME_TLS_IDENTITY_SOURCE", "pem"),
        ("OPENSESAME_TLS_CERT_FILE", "/tmp/cert.pem"),
        ("OPENSESAME_TLS_KEY_FILE", "/tmp/key.pem"),
        ("OPENSESAME_TLS_TRUST_FILE", "/tmp/ca.pem"),
        ("OPENSESAME_TLS_TRUST_KIND", "private_root"),
    ])
    .is_err());
}

#[test]
fn trusted_ingress_requires_its_originating_bundle() {
    let mut pairs = mtls_listener(vec![]);
    pairs.retain(|(k, _)| *k != "OPENSESAME_TLS_POLICY");
    pairs.push(("OPENSESAME_TLS_POLICY", "trusted_ingress"));
    assert!(parse(pairs.clone()).is_err());
    pairs.push((
        "OPENSESAME_INGRESS_ORIGINATING_TRUST_FILE",
        "/tmp/originating.pem",
    ));
    assert!(parse(pairs).is_ok());
}

#[test]
fn two_mapping_credentials_without_a_chosen_mode_refuse() {
    let both = vec![
        ("OPENSESAME_MAPPING_RESOLVE_TOKEN", TOKEN),
        ("OPENSESAME_MAPPING_TLS_IDENTITY_SOURCE", "pem"),
        ("OPENSESAME_MAPPING_TLS_CERT_FILE", "/tmp/c.pem"),
        ("OPENSESAME_MAPPING_TLS_KEY_FILE", "/tmp/k.pem"),
        ("OPENSESAME_MAPPING_TLS_TRUST_FILE", "/tmp/ca.pem"),
        ("OPENSESAME_MAPPING_TLS_TRUST_KIND", "private_root"),
        ("OPENSESAME_MAPPING_TLS_SERVER_NAME", "identity.test"),
    ];
    assert!(parse(both.clone()).is_err());
    let mut chosen = both.clone();
    chosen.push(("OPENSESAME_MAPPING_AUTH", "mtls"));
    let config = parse(chosen).expect("explicit mode resolves the ambiguity");
    assert_eq!(config.mapping_auth, AuthMode::Mtls);
    assert!(config.mapping_tls.is_some());
}

#[test]
fn a_chosen_mapping_mode_without_its_material_refuses() {
    assert!(parse(vec![("OPENSESAME_MAPPING_AUTH", "shared_secret")]).is_err());
    assert_eq!(
        parse(vec![("OPENSESAME_MAPPING_AUTH", "mtls")])
            .unwrap_err()
            .code(),
        "identity_missing"
    );
    // An identity without the bundle or the expected server name is not a
    // usable client profile.
    assert!(parse(vec![
        ("OPENSESAME_MAPPING_AUTH", "mtls"),
        ("OPENSESAME_MAPPING_TLS_IDENTITY_SOURCE", "pem"),
        ("OPENSESAME_MAPPING_TLS_CERT_FILE", "/tmp/c.pem"),
        ("OPENSESAME_MAPPING_TLS_KEY_FILE", "/tmp/k.pem"),
    ])
    .is_err());
}

#[test]
fn callout_mtls_has_no_secret_and_needs_an_authenticating_listener() {
    let mut with_secret = mtls_listener(vec![("OPENSESAME_NATS_CALLOUT_AUTH", "mtls")]);
    with_secret.push(("OPENSESAME_NATS_CALLOUT_SECRET", SECRET));
    assert!(parse(with_secret).is_err());
    assert!(parse(vec![("OPENSESAME_NATS_CALLOUT_AUTH", "mtls")]).is_err());
    let ok = parse(mtls_listener(vec![(
        "OPENSESAME_NATS_CALLOUT_AUTH",
        "mtls",
    )]))
    .expect("callout mtls with an authenticating listener");
    assert!(ok.requires_mtls(BindingPurpose::NatsAuthBridge));
    assert!(ok.requires_mtls(BindingPurpose::ServiceProbe));
    assert!(ok.mapping_client_required());
}

#[tokio::test]
async fn unreadable_material_fails_the_runtime_build() {
    let db = opensesame_storage::Db::connect_memory().await.expect("db");
    let config = parse(mtls_listener(vec![])).expect("configuration parses");
    // The paths do not exist: the build refuses rather than serving without
    // an identity.
    let error = TransportRuntime::build(config, &db, &NoManagedIdentity)
        .await
        .expect_err("unreadable certificate");
    assert_eq!(error.code(), "malformed_configuration");
}

#[tokio::test]
async fn a_managed_identity_with_no_custody_bridge_fails_the_build() {
    let db = opensesame_storage::Db::connect_memory().await.expect("db");
    let config = parse(vec![
        ("OPENSESAME_TLS_LISTEN", "127.0.0.1:8443"),
        ("OPENSESAME_TLS_POLICY", "mtls_required"),
        ("OPENSESAME_TLS_IDENTITY_SOURCE", "managed"),
        ("OPENSESAME_TLS_MANAGED_CERTIFICATE_ID", "cert-1"),
        ("OPENSESAME_TLS_TRUST_FILE", "/tmp/ca.pem"),
        ("OPENSESAME_TLS_TRUST_KIND", "private_root"),
    ])
    .expect("configuration parses");
    assert_eq!(
        TransportRuntime::build(config, &db, &NoManagedIdentity)
            .await
            .expect_err("no custody bridge")
            .code(),
        "source_unsupported"
    );
}

#[tokio::test]
async fn nothing_configured_builds_no_runtime() {
    let db = opensesame_storage::Db::connect_memory().await.expect("db");
    let config = parse(vec![]).expect("empty");
    assert!(TransportRuntime::build(config, &db, &NoManagedIdentity)
        .await
        .expect("no error")
        .is_none());
}
