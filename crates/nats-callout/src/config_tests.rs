use std::collections::HashMap;

use opensesame_domain::transport::PeerIdentitySelector;
use opensesame_transport_security::testkit::{tempdir, DisposableCa};

use super::*;

/// A complete, valid environment written into `dir`.
fn full_env(dir: &Path) -> HashMap<String, String> {
    let host_ca = DisposableCa::new("hosts");
    let bridge_ca = DisposableCa::new("bridges");
    let nats_ca = DisposableCa::new("nats");
    let bridge = bridge_ca.issue_client(PeerIdentitySelector::DnsName("bridge.internal".into()));
    let (cert, key) = bridge.write_to(dir);
    let host_trust = write_secret_file(
        dir,
        "host-ca.pem",
        std::str::from_utf8(&host_ca.root_pem()).unwrap(),
    )
    .unwrap();
    let nats_trust = write_secret_file(
        dir,
        "nats-ca.pem",
        std::str::from_utf8(&nats_ca.root_pem()).unwrap(),
    )
    .unwrap();
    let seed = write_secret_file(
        dir,
        "account.seed",
        &nkeys::KeyPair::new_account().seed().unwrap(),
    )
    .unwrap();
    let creds = write_secret_file(
        dir,
        "bridge.nk",
        &nkeys::KeyPair::new_user().seed().unwrap(),
    )
    .unwrap();
    let s = |p: &Path| p.to_string_lossy().into_owned();
    HashMap::from([
        (
            "OPENSESAME_NATS_URL".to_owned(),
            "tls://127.0.0.1:4222".to_owned(),
        ),
        (
            "OPENSESAME_NATS_CALLOUT_NKEY_SEED_FILE".to_owned(),
            s(&creds),
        ),
        ("OPENSESAME_NATS_TLS_TRUST_FILE".to_owned(), s(&nats_trust)),
        (
            "OPENSESAME_NATS_TLS_TRUST_KIND".to_owned(),
            "private_root".to_owned(),
        ),
        (
            "OPENSESAME_NATS_TLS_SERVER_NAME".to_owned(),
            "nats.internal".to_owned(),
        ),
        (
            "OPENSESAME_NATS_CALLOUT_SIGNING_SEED_FILE".to_owned(),
            s(&seed),
        ),
        (
            "OPENSESAME_NATS_CALLOUT_TARGET_ACCOUNT".to_owned(),
            "APP".to_owned(),
        ),
        (
            "OPENSESAME_NATS_CALLOUT_HOST_URL".to_owned(),
            "https://host.internal:8787".to_owned(),
        ),
        (
            "OPENSESAME_CALLOUT_TLS_IDENTITY_SOURCE".to_owned(),
            "pem".to_owned(),
        ),
        ("OPENSESAME_CALLOUT_TLS_CERT_FILE".to_owned(), s(&cert)),
        ("OPENSESAME_CALLOUT_TLS_KEY_FILE".to_owned(), s(&key)),
        (
            "OPENSESAME_CALLOUT_TLS_TRUST_FILE".to_owned(),
            s(&host_trust),
        ),
        (
            "OPENSESAME_CALLOUT_TLS_TRUST_KIND".to_owned(),
            "private_root".to_owned(),
        ),
        (
            "OPENSESAME_CALLOUT_TLS_SERVER_NAME".to_owned(),
            "host.internal".to_owned(),
        ),
    ])
}

fn load(env: &HashMap<String, String>) -> Result<BridgeConfig, CalloutError> {
    BridgeConfig::from_lookup(&|name| env.get(name).cloned())
}

#[test]
fn a_complete_environment_loads_and_prints_no_secret() {
    let dir = tempdir();
    let env = full_env(dir.path());
    let cfg = load(&env).unwrap();
    assert_eq!(cfg.target_account, "APP");
    assert_eq!(cfg.max_exp_secs, DEFAULT_EXP_SECS);
    assert!(cfg.nats_tls.is_some());
    assert!(cfg.host_tls.identity.is_some());
    let text = format!("{cfg:?}");
    assert!(!text.contains("SAA"), "account seed must not print");
    assert!(!text.contains("PRIVATE KEY"));
    assert!(cfg.connect_options().is_ok());
}

#[test]
fn each_required_variable_is_named_when_missing() {
    let dir = tempdir();
    let env = full_env(dir.path());
    for required in [
        "OPENSESAME_NATS_URL",
        "OPENSESAME_NATS_CALLOUT_NKEY_SEED_FILE",
        "OPENSESAME_NATS_CALLOUT_SIGNING_SEED_FILE",
        "OPENSESAME_NATS_CALLOUT_TARGET_ACCOUNT",
        "OPENSESAME_NATS_CALLOUT_HOST_URL",
        "OPENSESAME_CALLOUT_TLS_IDENTITY_SOURCE",
        "OPENSESAME_CALLOUT_TLS_TRUST_FILE",
        "OPENSESAME_CALLOUT_TLS_SERVER_NAME",
        "OPENSESAME_NATS_TLS_TRUST_FILE",
    ] {
        let mut e = env.clone();
        e.remove(required);
        let err = load(&e).unwrap_err();
        assert!(
            matches!(err, CalloutError::MalformedConfiguration(_)),
            "{required}"
        );
    }
}

#[test]
fn plaintext_nats_needs_the_explicit_development_switch() {
    let dir = tempdir();
    let mut env = full_env(dir.path());
    env.remove("OPENSESAME_NATS_TLS_TRUST_FILE");
    env.remove("OPENSESAME_NATS_TLS_TRUST_KIND");
    env.remove("OPENSESAME_NATS_TLS_SERVER_NAME");
    assert!(load(&env).is_err());
    env.insert(
        "OPENSESAME_NATS_CALLOUT_ALLOW_PLAINTEXT_NATS".into(),
        "1".into(),
    );
    let cfg = load(&env).unwrap();
    assert!(cfg.nats_tls.is_none());
}

#[test]
fn host_url_must_be_https_and_bridge_identity_is_mandatory() {
    let dir = tempdir();
    let mut env = full_env(dir.path());
    env.insert(
        "OPENSESAME_NATS_CALLOUT_HOST_URL".into(),
        "http://host.internal".into(),
    );
    let cfg = load(&env).unwrap();
    assert!(crate::host_client::HttpHost::new(&cfg.host_tls, &cfg.host_url).is_err());
    let mut env = full_env(dir.path());
    env.remove("OPENSESAME_CALLOUT_TLS_IDENTITY_SOURCE");
    assert!(load(&env).is_err(), "no identity, no bridge");
}

#[test]
fn server_pins_and_expiry_are_validated() {
    let dir = tempdir();
    let mut env = full_env(dir.path());
    env.insert("OPENSESAME_NATS_SERVER_NKEYS".into(), "not-a-key".into());
    assert!(load(&env).is_err());
    let server = nkeys::KeyPair::new_server().public_key();
    env.insert(
        "OPENSESAME_NATS_SERVER_NKEYS".into(),
        format!(" {server}, "),
    );
    assert_eq!(load(&env).unwrap().server_public_keys, vec![server]);
    env.insert("OPENSESAME_NATS_CALLOUT_MAX_EXP_SECS".into(), "abc".into());
    assert!(load(&env).is_err());
    env.insert("OPENSESAME_NATS_CALLOUT_MAX_EXP_SECS".into(), "60".into());
    assert_eq!(load(&env).unwrap().max_exp_secs, 60);
}

#[test]
fn creds_and_nkey_are_mutually_exclusive() {
    let dir = tempdir();
    let mut env = full_env(dir.path());
    let creds = env["OPENSESAME_NATS_CALLOUT_NKEY_SEED_FILE"].clone();
    env.insert("OPENSESAME_NATS_CALLOUT_CREDS_FILE".into(), creds);
    assert!(load(&env).is_err());
}
