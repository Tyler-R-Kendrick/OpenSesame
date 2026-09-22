//! The ordering pact, and the fences that must bite before an identity is
//! resolved or a credential opened.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use async_trait::async_trait;
use opensesame_domain::transport::{
    IdentitySourceRef, TransportError, TransportPolicy, TrustProfileRef,
};
use opensesame_invoke_through::{AuthStyle, EgressRule};
use secrecy::SecretString;

use super::{
    assert_invoke_order, ConnectionCredential, ConnectorContext, ConnectorInvocation,
    ConnectorInvokeError, ConnectorTransportExecutor,
};
use crate::transport::client::is_internal;
use crate::transport::memory::MemoryTransportResolver;
use crate::transport::pool::ConnectorClientPool;
use crate::transport::{
    ConnectionTransport, ConnectorExecutionTarget, ConnectorResolvers, ServerNameSelector,
};

const RULES: &[EgressRule] = &[EgressRule {
    provider_id: "acme",
    scheme: "https",
    hosts: &["connector.example"],
    auth: AuthStyle::Bearer,
}];

/// Counts how often the sealed credential was opened. On every denial path
/// this must stay at zero: a request the fences refuse never touches it.
#[derive(Default)]
struct CountingCredential {
    opened: AtomicUsize,
}

#[async_trait]
impl ConnectionCredential for CountingCredential {
    async fn open_bearer(&self, _ctx: &ConnectorContext) -> Result<SecretString, TransportError> {
        self.opened.fetch_add(1, Ordering::SeqCst);
        Ok(SecretString::from("never-on-the-wire-in-these-tests"))
    }
}

/// Counts identity resolutions the same way.
struct CountingResolver {
    inner: MemoryTransportResolver,
    resolved: AtomicUsize,
}

#[async_trait]
impl crate::transport::ClientIdentityResolver for CountingResolver {
    async fn resolve(
        &self,
        scope: crate::transport::IdentityScope,
    ) -> Result<Arc<opensesame_transport_security::TlsIdentity>, TransportError> {
        self.resolved.fetch_add(1, Ordering::SeqCst);
        self.inner.resolve(scope).await
    }
}

#[async_trait]
impl crate::transport::TrustProfileResolver for CountingResolver {
    async fn resolve_trust(
        &self,
        scope: crate::transport::TrustScope,
    ) -> Result<Arc<opensesame_transport_security::TrustBundle>, TransportError> {
        self.inner.resolve_trust(scope).await
    }
}

fn mtls_record() -> ConnectionTransport {
    ConnectionTransport {
        policy: TransportPolicy::MtlsRequired,
        identity: Some(IdentitySourceRef::new("acme-client").unwrap()),
        trust: Some(TrustProfileRef::new("acme-root").unwrap()),
        server_name: Some(ServerNameSelector::Dns("connector.example".into())),
        execution_target: ConnectorExecutionTarget::Host,
    }
}

fn ctx() -> ConnectorContext {
    ConnectorContext {
        organization_id: "org-a".into(),
        connection_id: "conn-1".into(),
        provider_id: "acme".into(),
    }
}

fn get(url: &str) -> ConnectorInvocation {
    ConnectorInvocation {
        method: "GET".into(),
        url: url.into(),
        headers: vec![("accept".into(), "application/json".into())],
        body: None,
    }
}

fn executor(resolvers: &Arc<CountingResolver>) -> ConnectorTransportExecutor {
    ConnectorTransportExecutor::new(
        ConnectorResolvers {
            identities: Arc::clone(resolvers) as Arc<dyn crate::transport::ClientIdentityResolver>,
            trust: Arc::clone(resolvers) as Arc<dyn crate::transport::TrustProfileResolver>,
        },
        Arc::new(ConnectorClientPool::with_capacity(8)),
        RULES.to_vec(),
    )
}

fn resolvers() -> Arc<CountingResolver> {
    Arc::new(CountingResolver {
        inner: MemoryTransportResolver::new(),
        resolved: AtomicUsize::new(0),
    })
}

#[test]
fn the_invoke_order_is_pinned_in_this_module_source() {
    // Moving `open_bearer` (or the identity resolution) above the egress fence
    // is the regression this catches — the ADR 0076 pact, extended to keys.
    assert_invoke_order();
}

#[tokio::test]
async fn a_browser_target_is_refused_before_anything_is_resolved_or_opened() {
    // AT-BROWSER-KEY: no export, no proxy, no key resolution, no credential.
    let resolvers = resolvers();
    let executor = executor(&resolvers);
    let credential = CountingCredential::default();
    let record = ConnectionTransport {
        execution_target: ConnectorExecutionTarget::Browser,
        ..mtls_record()
    };
    let error = executor
        .invoke(
            &ctx(),
            &record,
            &credential,
            get("https://connector.example/v1/ping"),
        )
        .await
        .expect_err("a browser cannot present a Host-held identity");
    assert_eq!(error.code(), "source_unsupported");
    assert!(matches!(error, ConnectorInvokeError::Transport(_)));
    assert_eq!(resolvers.resolved.load(Ordering::SeqCst), 0);
    assert_eq!(credential.opened.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn an_egress_denial_never_resolves_a_key_or_opens_a_credential() {
    // AT-CONNECTOR-EGRESS: a host outside the connection's rule, a plain-http
    // target, an embedded credential, and an unknown provider all stop at the
    // fence — before the private key is even asked for.
    let resolvers = resolvers();
    let executor = executor(&resolvers);
    let credential = CountingCredential::default();
    let record = mtls_record();
    for url in [
        "https://evil.example/v1/ping",
        "https://connector.example.evil.test/v1/ping",
        "http://connector.example/v1/ping",
        "https://user:pass@connector.example/v1/ping",
    ] {
        let error = executor
            .invoke(&ctx(), &record, &credential, get(url))
            .await
            .expect_err(url);
        assert!(matches!(error, ConnectorInvokeError::Egress(_)), "{url}");
    }
    let unknown = ConnectorContext {
        provider_id: "not-in-the-allowlist".into(),
        ..ctx()
    };
    assert!(executor
        .invoke(
            &unknown,
            &record,
            &credential,
            get("https://connector.example/v1/ping")
        )
        .await
        .is_err());
    assert_eq!(resolvers.resolved.load(Ordering::SeqCst), 0);
    assert_eq!(credential.opened.load(Ordering::SeqCst), 0);
    assert!(executor.pool().is_empty());
}

#[tokio::test]
async fn an_unresolvable_reference_stops_before_the_credential() {
    // Nothing is registered, so the reference does not resolve — and because
    // resolution precedes the credential, nothing is opened either.
    let resolvers = resolvers();
    let executor = executor(&resolvers);
    let credential = CountingCredential::default();
    let error = executor
        .invoke(
            &ctx(),
            &mtls_record(),
            &credential,
            get("https://connector.example/v1/ping"),
        )
        .await
        .expect_err("an unregistered identity reference resolves to nothing");
    assert_eq!(error.code(), "identity_missing");
    assert_eq!(resolvers.resolved.load(Ordering::SeqCst), 1);
    assert_eq!(credential.opened.load(Ordering::SeqCst), 0);
    assert!(executor.pool().is_empty());
}

#[test]
fn an_internal_address_is_never_a_connector_upstream() {
    // AT-CONNECTOR-EGRESS: whatever DNS answers, these are somebody's inside.
    for blocked in [
        "127.0.0.1",
        "169.254.169.254",
        "10.0.0.5",
        "172.16.4.1",
        "192.168.1.1",
        "100.64.0.1",
        "0.0.0.0",
        "224.0.0.1",
        "::1",
        "fe80::1",
        "fd00::1",
        "::ffff:127.0.0.1",
    ] {
        assert!(
            is_internal(blocked.parse::<IpAddr>().unwrap()),
            "{blocked} must never be dialed with a credential"
        );
    }
    for public in ["93.184.216.34", "1.1.1.1", "2606:4700:4700::1111"] {
        assert!(!is_internal(public.parse::<IpAddr>().unwrap()), "{public}");
    }
    assert!(is_internal(IpAddr::V4(Ipv4Addr::UNSPECIFIED)));
    assert!(is_internal(IpAddr::V6(Ipv6Addr::UNSPECIFIED)));
}
