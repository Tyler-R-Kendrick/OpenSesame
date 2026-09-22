//! The reference/locator fence, the policy coherence rules, the browser
//! capability refusal, and the resolver's tenant rule.

use std::sync::Arc;

use opensesame_domain::transport::{
    CapabilityOutcome, IdentitySourceRef, TransportError, TransportPolicy, TrustProfileKind,
    TrustProfileRef,
};
use opensesame_transport_security::testkit::DisposableCa;
use opensesame_transport_security::TrustBundle;

use super::memory::MemoryTransportResolver;
use super::{
    ClientIdentityResolver, ConnectionTransport, ConnectorExecutionTarget, IdentityScope,
    ServerNameSelector, TrustProfileResolver, TrustScope, BROWSER_VAULT_KEY_INJECTION,
    MAX_TRANSPORT_JSON_BYTES, PURPOSE_CONNECTOR_INVOKE,
};

fn mtls_json(identity: &str) -> String {
    format!(
        r#"{{"policy":"mtls_required","identity":{{"name":"{identity}"}},
            "trust":{{"name":"acme-root"}},
            "server_name":{{"dns":"connector.example"}},
            "execution_target":"host"}}"#
    )
}

#[test]
fn a_reference_is_a_name_and_never_a_locator() {
    // AT-CUSTODY-SOURCE: every spelling of "point me at a file, a socket, a
    // URL or a key" is refused before the record ever becomes a value, so no
    // tenant can name native source material through a connection id.
    for locator in [
        "/etc/ssl/private/acme.key",
        "..\\..\\keys\\acme",
        "https://evil.example/key.pem",
        "unix:/run/spire/agent.sock",
        "-----BEGIN PRIVATE KEY-----",
        "spiffe://acme.example/workload",
    ] {
        let raw = mtls_json(locator);
        let error = ConnectionTransport::parse_json(raw.as_bytes())
            .expect_err("a locator is not a reference");
        assert_eq!(error.code(), "malformed_configuration", "{locator}");
        assert!(
            !format!("{error}").contains("BEGIN PRIVATE KEY"),
            "the refusal must not echo key material"
        );
    }
}

#[test]
fn an_oversized_or_unknown_field_record_is_refused() {
    let big = vec![b'{'; MAX_TRANSPORT_JSON_BYTES + 1];
    assert!(ConnectionTransport::parse_json(&big).is_err());
    let unknown = br#"{"policy":"server_tls","execution_target":"host","proxy":"http://x"}"#;
    assert!(ConnectionTransport::parse_json(unknown).is_err());
    let over_long = "a".repeat(65);
    assert!(ConnectionTransport::parse_json(mtls_json(&over_long).as_bytes()).is_err());
}

#[test]
fn only_connector_policies_are_accepted_and_they_must_be_coherent() {
    let good = ConnectionTransport::parse_json(mtls_json("acme-client").as_bytes()).unwrap();
    assert_eq!(good.policy, TransportPolicy::MtlsRequired);
    assert!(good.requires_vault_identity());

    // Through JSON every incoherence is a malformed record; `validate` keeps
    // the semantic code for a caller that built the value in memory.
    for raw in [
        r#"{"policy":"existing_local","execution_target":"host"}"#,
        r#"{"policy":"trusted_ingress","execution_target":"host"}"#,
        r#"{"policy":"mtls_required","execution_target":"host"}"#,
        r#"{"policy":"mtls_required","identity":{"name":"c"},"execution_target":"host"}"#,
        r#"{"policy":"server_tls","identity":{"name":"c"},"execution_target":"host"}"#,
        r#"{"policy":"server_tls","trust":{"name":"r"},"execution_target":"host"}"#,
    ] {
        let error = ConnectionTransport::parse_json(raw.as_bytes()).expect_err(raw);
        assert_eq!(error.code(), "malformed_configuration", "{raw}");
    }

    let base = ConnectionTransport {
        policy: TransportPolicy::MtlsRequired,
        identity: None,
        trust: None,
        server_name: None,
        execution_target: ConnectorExecutionTarget::Host,
    };
    assert_eq!(base.validate().unwrap_err().code(), "identity_missing");
    let with_identity = ConnectionTransport {
        identity: Some(IdentitySourceRef::new("acme-client").unwrap()),
        ..base.clone()
    };
    assert_eq!(with_identity.validate().unwrap_err().code(), "trust_unknown");
    let no_server_name = ConnectionTransport {
        trust: Some(TrustProfileRef::new("acme-root").unwrap()),
        ..with_identity.clone()
    };
    assert_eq!(
        no_server_name.validate().unwrap_err().code(),
        "malformed_configuration"
    );
    for refused in [TransportPolicy::ExistingLocal, TransportPolicy::TrustedIngress] {
        let record = ConnectionTransport {
            policy: refused,
            ..good.clone()
        };
        assert_eq!(
            record.validate().unwrap_err().code(),
            "malformed_configuration"
        );
    }
}

#[test]
fn a_browser_target_that_needs_a_vault_key_is_refused_by_type() {
    // AT-BROWSER-KEY. The refusal is a value, not an export and not a proxy.
    let browser = ConnectionTransport {
        policy: TransportPolicy::MtlsRequired,
        identity: Some(IdentitySourceRef::new("acme-client").unwrap()),
        trust: Some(TrustProfileRef::new("acme-root").unwrap()),
        server_name: Some(ServerNameSelector::Dns("connector.example".into())),
        execution_target: ConnectorExecutionTarget::Browser,
    };
    assert_eq!(
        browser.execution_capability(),
        CapabilityOutcome::unsupported(BROWSER_VAULT_KEY_INJECTION)
    );
    assert!(matches!(
        browser.require_executable(),
        Err(TransportError::SourceUnsupported)
    ));

    // The same connection executed on the Host is supported, and a browser
    // connection that needs no vault identity is not blocked at all: an
    // optional feature nobody configured is never an error.
    let on_host = ConnectionTransport {
        execution_target: ConnectorExecutionTarget::Host,
        ..browser.clone()
    };
    assert!(on_host.execution_capability().is_supported());
    let plain_browser = ConnectionTransport {
        policy: TransportPolicy::ServerTls,
        identity: None,
        trust: None,
        server_name: None,
        execution_target: ConnectorExecutionTarget::Browser,
    };
    assert!(plain_browser.execution_capability().is_supported());
    assert!(plain_browser.require_executable().is_ok());
}

#[test]
fn a_record_round_trips_through_storage_json() {
    let record = ConnectionTransport::parse_json(mtls_json("acme-client").as_bytes()).unwrap();
    let json = record.to_json().unwrap();
    assert_eq!(
        ConnectionTransport::parse_json(json.as_bytes()).unwrap(),
        record
    );
    // The stored shape is the snake_case wire the PWA's gate reads.
    assert!(json.contains("\"execution_target\":\"host\""));
    assert!(json.contains("\"policy\":\"mtls_required\""));
}

#[tokio::test]
async fn a_reference_another_tenant_owns_reads_as_missing() {
    // AT-TLS-TENANT / AT-CUSTODY-SOURCE: tenant B's identity is not an error
    // message that tells tenant A it exists — it is simply absent.
    let ca = DisposableCa::new("acme");
    let leaf = ca.issue_client(opensesame_domain::transport::PeerIdentitySelector::DnsName(
        "client.acme.example".into(),
    ));
    let resolver = MemoryTransportResolver::new();
    resolver.register_identity("org-b", "payments", Arc::new(leaf.identity()));
    resolver.register_trust(
        "org-b",
        "acme-root",
        Arc::new(
            TrustBundle::from_pem(
                TrustProfileRef::new("acme-root").unwrap(),
                TrustProfileKind::PrivateRoot,
                &ca.root_pem(),
            )
            .unwrap(),
        ),
    );

    let scope = |org: &str| IdentityScope {
        organization_id: org.into(),
        connection_id: "conn-1".into(),
        identity: IdentitySourceRef::new("payments").unwrap(),
        purpose: PURPOSE_CONNECTOR_INVOKE,
    };
    assert!(resolver.resolve(scope("org-b")).await.is_ok());
    assert!(matches!(
        resolver.resolve(scope("org-a")).await,
        Err(TransportError::IdentityMissing)
    ));
    // A name that was never registered answers identically — no oracle.
    assert!(matches!(
        resolver
            .resolve(IdentityScope {
                identity: IdentitySourceRef::new("nothing-here").unwrap(),
                ..scope("org-b")
            })
            .await,
        Err(TransportError::IdentityMissing)
    ));

    let trust_scope = |org: &str| TrustScope {
        organization_id: org.into(),
        connection_id: "conn-1".into(),
        trust: TrustProfileRef::new("acme-root").unwrap(),
        purpose: PURPOSE_CONNECTOR_INVOKE,
    };
    assert!(resolver.resolve_trust(trust_scope("org-b")).await.is_ok());
    assert!(matches!(
        resolver.resolve_trust(trust_scope("org-a")).await,
        Err(TransportError::TrustUnknown)
    ));
}

#[tokio::test]
async fn a_revoked_or_wrong_purpose_identity_stops_resolving() {
    let ca = DisposableCa::new("acme");
    let leaf = ca.issue_client(opensesame_domain::transport::PeerIdentitySelector::DnsName(
        "client.acme.example".into(),
    ));
    let resolver = MemoryTransportResolver::new();
    resolver.register_identity_for(
        "org-a",
        "probe-only",
        Arc::new(leaf.identity()),
        vec!["transport.probe"],
    );
    resolver.register_identity("org-a", "connector", Arc::new(leaf.identity()));

    let scope = |name: &str| IdentityScope {
        organization_id: "org-a".into(),
        connection_id: "conn-1".into(),
        identity: IdentitySourceRef::new(name).unwrap(),
        purpose: PURPOSE_CONNECTOR_INVOKE,
    };
    assert!(matches!(
        resolver.resolve(scope("probe-only")).await,
        Err(TransportError::PeerDisallowed)
    ));
    assert!(resolver.resolve(scope("connector")).await.is_ok());
    resolver.revoke_identity("connector");
    assert!(matches!(
        resolver.resolve(scope("connector")).await,
        Err(TransportError::EvidenceRevoked)
    ));
}
