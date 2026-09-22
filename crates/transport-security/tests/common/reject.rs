//! Shared fixtures for the refusal suites: a served `MtlsRequired` stack
//! and a rustls client built straight from PEM so the *server* is what
//! refuses.
#![allow(dead_code)]

use std::sync::Arc;

use crate::common::*;
use opensesame_domain::transport::{TlsVersion, TransportPolicy};
use opensesame_transport_security::testkit::{DisposableCa, IssuedLeaf};
use opensesame_transport_security::{ClientProfile, ServerNamePolicy};
use rustls::pki_types::pem::PemObject;
use secrecy::ExposeSecret;

pub struct Stack {
    pub server_ca: DisposableCa,
    pub client_ca: DisposableCa,
    pub served: Served,
    pub hits: Hits,
}

pub async fn stack() -> Stack {
    let server_ca = DisposableCa::new("servers");
    let client_ca = DisposableCa::new("clients");
    let server_identity = server_ca.issue_server("localhost").identity();
    let gens = generations(server_identity, &client_ca);
    let hits = Hits::default();
    let served = serve(
        gens.clone(),
        profile_fn(TransportPolicy::MtlsRequired),
        router(gens, hits.clone()),
    )
    .await;
    Stack {
        server_ca,
        client_ca,
        served,
        hits,
    }
}

pub fn profile(
    stack: &Stack,
    identity: Option<opensesame_transport_security::TlsIdentity>,
) -> ClientProfile {
    ClientProfile {
        server_trust: private_root("servers", &stack.server_ca),
        server_name: ServerNamePolicy::Dns("localhost".into()),
        identity: identity.map(Arc::new),
        min_version: TlsVersion::Tls13,
    }
}

/// A rustls client config built straight from a leaf's PEM, bypassing
/// `TlsIdentity`'s load-time checks so the *server* is what refuses.
pub fn raw_client(
    stack: &Stack,
    leaf: &IssuedLeaf,
) -> Result<Arc<rustls::ClientConfig>, rustls::Error> {
    let chain = rustls::pki_types::CertificateDer::pem_slice_iter(&leaf.cert_pem)
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    let key =
        rustls::pki_types::PrivateKeyDer::from_pem_slice(leaf.key_pem.expose_secret()).unwrap();
    rustls::ClientConfig::builder_with_provider(opensesame_transport_security::provider())
        .with_protocol_versions(&[&rustls::version::TLS13])
        .unwrap()
        .with_root_certificates(private_root("servers", &stack.server_ca).roots())
        .with_client_auth_cert(chain, key)
        .map(Arc::new)
}

/// The request must not succeed, and the protected handler must not run.
pub async fn expect_refused(stack: &Stack, config: Arc<rustls::ClientConfig>, why: &str) {
    let before = stack.hits.protected();
    let err = raw_get(config, stack.served.addr, localhost(), "/protected")
        .await
        .unwrap_err();
    assert!(!err.contains("200"), "{why}: {err}");
    assert_eq!(
        stack.hits.protected(),
        before,
        "{why}: protected handler ran"
    );
}
