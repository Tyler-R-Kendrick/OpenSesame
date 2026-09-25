//! Unit tests for the NATS adapter's configuration surface (no server).

use super::*;
use crate::nats_policy::{
    NatsAuth, NatsServerName, NatsTransport, NatsTransportPolicy, NatsTransportPublic,
    NatsTransportSource, TrustRef,
};
use crate::nats_transport::NatsTransportSpec;
use crate::nats_transport_env::url_hosts;
use opensesame_domain::transport::{TransportError, TrustProfileKind};
use serde_json::json;
use std::collections::HashMap;

fn lookup(vars: &[(&str, &str)]) -> HashMap<String, String> {
    vars.iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect()
}

fn spec_from(vars: &[(&str, &str)]) -> Result<Option<NatsTransportSpec>, TransportError> {
    let map = lookup(vars);
    NatsTransportSpec::from_lookup("OPENSESAME_NATS", &|name| map.get(name).cloned())
}

const SECURE: &[(&str, &str)] = &[
    ("OPENSESAME_NATS_TLS_IDENTITY_SOURCE", "pem"),
    (
        "OPENSESAME_NATS_TLS_CERT_FILE",
        "/run/secrets/nats-client.crt",
    ),
    (
        "OPENSESAME_NATS_TLS_KEY_FILE",
        "/run/secrets/nats-client.key",
    ),
    ("OPENSESAME_NATS_TLS_TRUST_FILE", "/run/secrets/nats-ca.pem"),
    ("OPENSESAME_NATS_TLS_TRUST_KIND", "private_root"),
    ("OPENSESAME_NATS_TLS_SERVER_NAME", "nats.internal.example"),
    ("OPENSESAME_NATS_AUTH", "nkey"),
    ("OPENSESAME_NATS_NKEY_SEED_FILE", "/run/secrets/nats.seed"),
    ("OPENSESAME_NATS_TLS_FIRST", "1"),
];

#[test]
fn default_config_uses_worker_consumer_and_full_prefix() {
    let cfg = NatsJetStreamConfig::default();
    assert_eq!(cfg.stream_name, DEFAULT_STREAM_NAME);
    assert_eq!(cfg.consumer_name, DEFAULT_CONSUMER_NAME);
    assert_eq!(cfg.subject_prefix, DEFAULT_SUBJECT_PREFIX);
    assert!(cfg.filter_subject.is_none());
    assert_eq!(cfg.transport.policy(), NatsTransportPolicy::Plaintext);
    assert_eq!(cfg.role, NatsRole::Host);
}

#[test]
fn production_adapter_uses_jetstream_not_core_pub_and_never_bare_connect() {
    let src = include_str!("nats.rs");
    let production = src.split("#[cfg(test)]").next().unwrap_or(src);
    assert!(production.contains("session.js.send_publish"));
    assert!(!production.contains("async_nats::connect("));
    assert!(!production.contains("OPENSESAME_CONNECTION_KEY"));
    let connect = include_str!("nats_connect.rs");
    assert!(connect.contains(".require_tls(true)"));
    assert!(connect.contains(".ignore_discovered_servers()"));
    assert!(connect.contains(".tls_client_config(config)"));
    assert!(
        !connect.contains("add_root_certificates"),
        "one verifier only"
    );
    assert!(!connect.contains("danger"), "no permissive verifier");
}

/// AT-NATS-FACTORIES (crate half): every public constructor resolves a
/// transport before it dials, and no constructor calls `async_nats::connect`.
/// A new factory that forgets the transport fails here.
#[test]
fn every_public_factory_resolves_a_transport() {
    let lib = include_str!("lib.rs");
    let production = lib.split("#[cfg(test)]").next().unwrap_or(lib);
    assert!(!production.contains("async_nats::connect"));
    // `create_nats` is the only place a URL becomes a connection without an
    // explicit spec, and it resolves `OPENSESAME_NATS_*` first.
    let create_nats = production
        .split("pub async fn create_nats")
        .nth(1)
        .expect("create_nats exists");
    let body = create_nats
        .split("pub async fn")
        .next()
        .unwrap_or(create_nats);
    assert!(body.contains("NatsTransportSpec::from_env()"));
    assert!(body.contains("create_with("));
    // Provisioning never rides a runtime factory.
    assert!(production.contains("provision_backup_consumer"));
    assert!(production.contains("NatsRole::Provisioner"));
    // …and the runtime factory does not hard-code provisioning.
    let create_with = production
        .split("pub async fn create_with")
        .nth(1)
        .expect("create_with exists");
    assert!(create_with.contains("provision,"));
}

#[test]
fn env_absent_means_no_transport_spec() {
    assert!(spec_from(&[]).unwrap().is_none());
}

#[test]
fn env_secure_profile_resolves_references_not_paths() {
    let spec = spec_from(SECURE).unwrap().expect("spec");
    assert_eq!(spec.source, NatsTransportSource::Env);
    assert!(spec.transport.require_tls, "identity/trust/auth imply TLS");
    assert!(spec.transport.tls_first);
    assert_eq!(spec.policy(), NatsTransportPolicy::MtlsRequired);
    assert_eq!(
        spec.transport.server_trust,
        Some(TrustRef {
            name: "nats-server-trust".into(),
            kind: TrustProfileKind::PrivateRoot
        })
    );
    assert_eq!(
        spec.transport.server_name,
        Some(NatsServerName::Dns("nats.internal.example".into()))
    );
    assert_eq!(
        spec.auth,
        NatsAuth::Nkey {
            seed_ref: "OPENSESAME_NATS_NKEY_SEED_FILE".into()
        }
    );

    // The persisted / returned shapes carry no locator.
    for value in [
        serde_json::to_value(spec.public()).unwrap(),
        serde_json::to_value(spec.view()).unwrap(),
    ] {
        let text = value.to_string();
        for forbidden in ["/run/secrets", ".key", ".seed", "nats-ca.pem", "BEGIN"] {
            assert!(!text.contains(forbidden), "{forbidden} leaked into {text}");
        }
    }
    let debug = format!("{spec:?}");
    assert!(!debug.contains("/run/secrets"), "{debug}");
    assert!(debug.contains("<redacted>"));
}

#[test]
fn env_unknown_auth_word_is_refused() {
    let err = spec_from(&[("OPENSESAME_NATS_AUTH", "password")]).unwrap_err();
    assert_eq!(err.code(), "malformed_configuration");
    let err = spec_from(&[("OPENSESAME_NATS_AUTH", "creds")]).unwrap_err();
    assert!(err.to_string().contains("OPENSESAME_NATS_CREDS_FILE"));
}

#[test]
fn tls_url_implies_require_tls_and_needs_trust() {
    let spec = NatsTransportSpec::plaintext();
    let err = spec
        .normalized("tls://nats.internal.example:4222")
        .unwrap_err();
    assert_eq!(err.code(), "trust_unknown");
}

#[test]
fn plaintext_profile_refuses_credentials_and_identity() {
    let mut public = NatsTransportPublic {
        transport: NatsTransport::default(),
        auth: NatsAuth::None,
    };
    public.auth = NatsAuth::Nkey {
        seed_ref: "OPENSESAME_NATS_NKEY_SEED_FILE".into(),
    };
    let spec = NatsTransportSpec::from_public(public, NatsTransportSource::Stored);
    let err = spec.normalized("nats://127.0.0.1:4222").unwrap_err();
    assert_eq!(err.code(), "policy_downgrade_refused");
}

#[test]
fn mixed_plain_and_tls_hosts_are_refused() {
    let spec = spec_from(SECURE).unwrap().unwrap();
    let err = spec
        .normalized("tls://nats.internal.example:4222,nats://nats.internal.example:4223")
        .unwrap_err();
    assert_eq!(err.code(), "policy_downgrade_refused");
}

#[test]
fn server_name_must_be_the_dialed_host() {
    let spec = spec_from(SECURE).unwrap().unwrap();
    let err = spec
        .clone()
        .normalized("tls://other.example:4222")
        .unwrap_err();
    assert_eq!(err.code(), "malformed_configuration");
    let ok = spec.normalized("tls://NATS.internal.example:4222").unwrap();
    assert!(ok.transport.require_tls);
}

#[test]
fn server_name_defaults_to_the_dialed_dns_host_never_an_ip() {
    let vars: Vec<(&str, &str)> = SECURE
        .iter()
        .copied()
        .filter(|(k, _)| *k != "OPENSESAME_NATS_TLS_SERVER_NAME")
        .collect();
    let spec = spec_from(&vars).unwrap().unwrap();
    let ok = spec
        .clone()
        .normalized("tls://nats.internal.example:4222")
        .unwrap();
    assert_eq!(
        ok.transport.server_name,
        Some(NatsServerName::Dns("nats.internal.example".into()))
    );
    let err = spec.normalized("tls://10.0.0.5:4222").unwrap_err();
    assert_eq!(err.code(), "malformed_configuration");
}

#[test]
fn stored_public_policy_without_material_fails_closed() {
    let public: NatsTransportPublic = serde_json::from_value(json!({
        "transport": {
            "require_tls": true,
            "server_trust": {"name": "nats-ca", "kind": "private_root"},
            "client_identity": {"name": "nats-client", "kind": "pem_files"}
        },
        "auth": {"kind": "none"}
    }))
    .unwrap();
    let spec = NatsTransportSpec::from_public(public, NatsTransportSource::Stored)
        .normalized("tls://nats.internal.example:4222")
        .unwrap();
    let err = match crate::nats_connect::load_material(&spec, &InjectedMaterial::default()) {
        Ok(_) => panic!("material must not load without locators"),
        Err(err) => err,
    };
    assert_eq!(err.code(), "trust_unknown");
}

#[test]
fn public_policy_rejects_locator_shaped_fields() {
    for body in [
        json!({"transport": {"require_tls": true, "cert_file": "/x"}, "auth": {"kind": "none"}}),
        json!({"transport": {}, "auth": {"kind": "nkey", "seed": "SUAA"}}),
        json!({"transport": {}, "auth": {"kind": "creds", "path": "/x"}}),
    ] {
        assert!(
            serde_json::from_value::<NatsTransportPublic>(body.clone()).is_err(),
            "{body}"
        );
    }
}

#[test]
fn provisioning_spec_swaps_only_the_credential() {
    let mut vars = SECURE.to_vec();
    vars.push(("OPENSESAME_NATS_PROVISION_AUTH", "creds"));
    vars.push((
        "OPENSESAME_NATS_PROVISION_CREDS_FILE",
        "/run/secrets/provisioner.creds",
    ));
    let spec = spec_from(&vars).unwrap().unwrap();
    let prov = spec.for_provisioning();
    assert_eq!(prov.auth.kind(), "creds");
    assert_eq!(prov.transport, spec.transport);
    assert_eq!(spec.auth.kind(), "nkey");
}

#[test]
fn roles_name_their_client_and_scope_their_api() {
    assert_eq!(NatsRole::Backup.client_name(), "opensesame-backup");
    assert!(!NatsRole::Publisher.consumes());
    assert!(!NatsRole::Consumer.publishes());
    assert!(NatsRole::Provisioner.consumes() && NatsRole::Provisioner.publishes());
    assert!(!NatsRole::Callout.consumes() && !NatsRole::Callout.publishes());
}

#[test]
fn health_records_reason_codes_only() {
    let health = BusHealth::default();
    health.record(&async_nats::Event::Connected);
    health.record(&async_nats::Event::Disconnected);
    health.record(&async_nats::Event::ServerError(
        async_nats::ServerError::Other("user \"alice\" seed SUAAAAA".into()),
    ));
    assert_eq!(health.last_event().as_deref(), Some("server_error:other"));
    assert_eq!(health.disconnects(), 1);
    assert!(!health.connected());
}

#[test]
fn url_hosts_parse_lists_and_ipv6() {
    let hosts = url_hosts("tls://a.example:4222, tls://[::1]:4222").unwrap();
    assert_eq!(hosts[0], ("tls".into(), "a.example".into()));
    assert_eq!(hosts[1], ("tls".into(), "::1".into()));
    assert!(url_hosts("nats://user:pw@a.example:4222").is_err());
}

/// AT-NATS-PAYLOAD: a foreign `organization_id` inside `data` is data.
/// The envelope parses, the event is returned verbatim, and nothing about
/// the drain — its consumer, its filter, its role — changes with it.
#[tokio::test]
async fn foreign_principal_in_payload_never_changes_drain_scope() {
    let bus = crate::InMemoryTaskBus::default();
    let honest = BusEvent::cloud_event(
        "1",
        "opensesame/gateway",
        "principal.created",
        "2026-09-22T00:00:00Z",
        json!({"organization_id": "org_a"}),
    );
    let forged = BusEvent::cloud_event(
        "2",
        "opensesame/gateway",
        "principal.created",
        "2026-09-22T00:00:00Z",
        json!({"organization_id": "org_b", "role": "owner", "system": true}),
    );
    bus.publish(honest.clone()).await.unwrap();
    bus.publish(forged.clone()).await.unwrap();
    let drained = bus.drain(10).await.unwrap();
    assert_eq!(drained, vec![honest, forged.clone()]);
    // The subject a forged event lands on is decided by its *type*, never
    // by a claim inside `data`: a user event cannot reach the system prefix.
    assert!(!forged
        .subject(DEFAULT_SUBJECT_PREFIX)
        .starts_with(crate::SYSTEM_SUBJECT_PREFIX));
    assert!(!crate::is_system_event_type(&forged.r#type));
}
