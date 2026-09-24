//! The connector invoke path over an optional client identity
//! (ADR 0132, CONN-EXECUTE).
//!
//! ## The order is the security property
//!
//! ```text
//! capability   // can this execution target carry this transport at all?
//! preflight    // egress allowlist, exact host, scheme, method, headers, caps
//! resolve      // identity + trust *references* -> loaded material
//! pin          // the approved authority's addresses, resolved once
//! pool         // the client for exactly this scope
//! open         // the sealed credential, for this one request
//! execute      // the wire
//! ```
//!
//! This preserves the ADR 0076 pact `rotation_verify` established — the fence
//! runs before the credential is opened — and extends it: a denied request
//! also never causes a **private key to be resolved**, so a wrong-host or
//! wrong-scheme request costs nothing but a parse (AT-CONNECTOR-EGRESS,
//! AT-TLS-TENANT). [`assert_invoke_order`] pins the order in this file's own
//! source, so a future edit that moves `open_bearer` above `preflight` fails a
//! test rather than shipping.
//!
//! ## What an agent cannot do here
//!
//! An agent supplies a [`ConnectionRef`](opensesame_domain::ConnectionRef) and
//! an intent. It does not supply a certificate, a key, a path, a trust anchor,
//! a signing callback, or a server name: those come from the connection's
//! stored transport record, whose references were refused at parse if they
//! looked like locators, and are resolved only through
//! [`ClientIdentityResolver`](crate::transport::ClientIdentityResolver).

use std::net::SocketAddr;
use std::sync::Arc;

use async_trait::async_trait;
use opensesame_domain::transport::{TransportError, TransportPolicy};
use opensesame_invoke_through::{
    EgressFence, EgressRule, InvokeError, InvokeRequest, InvokeResponse, PreparedRequest,
};
use opensesame_transport_security::{TlsIdentity, TrustBundle};
use secrecy::SecretString;

use super::client::{build_invoker, is_internal, PinnedAuthority};
use super::pool::{ConnectorClientPool, ConnectorPoolKey};
use super::{
    ConnectionTransport, ConnectorResolvers, IdentityScope, TrustScope, PURPOSE_CONNECTOR_INVOKE,
};

/// Who the invocation is for. Never read from a request body: the caller's
/// authenticated context decides both fields.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConnectorContext {
    pub organization_id: String,
    pub connection_id: String,
    pub provider_id: String,
}

/// Opens the connection's sealed credential for exactly one request.
///
/// Implemented by [`ConnectionBroker`](crate::ConnectionBroker) over
/// `crypto::open_scoped`; a test implementation stands in where no database
/// is needed. Nothing public returns the value — it goes straight into one
/// sensitive header and is zeroized with the request.
#[async_trait]
pub trait ConnectionCredential: Send + Sync {
    /// # Errors
    ///
    /// Implementation-defined; the executor treats any failure as a refusal to
    /// proceed and never falls back to an unauthenticated request.
    async fn open_bearer(&self, ctx: &ConnectorContext) -> Result<SecretString, TransportError>;
}

/// Why a connector invocation did not happen.
#[derive(Debug, thiserror::Error)]
pub enum ConnectorInvokeError {
    #[error(transparent)]
    Transport(#[from] TransportError),
    #[error(transparent)]
    Egress(#[from] InvokeError),
}

impl ConnectorInvokeError {
    /// Stable, non-secret reason code.
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            Self::Transport(error) => error.code(),
            Self::Egress(_) => "egress_denied",
        }
    }
}

/// One outbound connector call.
#[derive(Clone, Debug)]
pub struct ConnectorInvocation {
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<bytes::Bytes>,
}

/// Runs connector invocations over the connection's configured transport.
pub struct ConnectorTransportExecutor {
    resolvers: ConnectorResolvers,
    pool: Arc<ConnectorClientPool>,
    fence: EgressFence,
    /// Loopback targets, for in-process TLS listeners in tests. Never set in
    /// production construction; a production authority is never loopback.
    allow_loopback_for_tests: bool,
}

impl std::fmt::Debug for ConnectorTransportExecutor {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ConnectorTransportExecutor")
            .field("pooled", &self.pool.len())
            .finish_non_exhaustive()
    }
}

impl ConnectorTransportExecutor {
    #[must_use]
    pub fn new(
        resolvers: ConnectorResolvers,
        pool: Arc<ConnectorClientPool>,
        rules: Vec<EgressRule>,
    ) -> Self {
        Self {
            resolvers,
            pool,
            fence: EgressFence::new(rules, opensesame_invoke_through::DEFAULT_REQUEST_BODY_CAP),
            allow_loopback_for_tests: false,
        }
    }

    /// Permit loopback authorities and non-default ports, for a test TLS
    /// listener bound to port 0.
    #[must_use]
    pub fn allow_loopback_for_tests(mut self) -> Self {
        self.allow_loopback_for_tests = true;
        self.fence = self.fence.clone().allow_http_for_tests();
        self
    }

    #[must_use]
    pub fn pool(&self) -> &Arc<ConnectorClientPool> {
        &self.pool
    }

    /// Invoke the upstream over the connection's transport.
    ///
    /// # Errors
    ///
    /// `Egress` when the pre-connect fence refuses the request (nothing was
    /// resolved, opened, pooled or dialed); `Transport` when the execution
    /// target cannot carry this transport, an identity or trust reference does
    /// not resolve for this organization, the approved authority does not
    /// resolve to a permitted address, or the credential cannot be opened.
    pub async fn invoke(
        &self,
        ctx: &ConnectorContext,
        transport: &ConnectionTransport,
        credential: &dyn ConnectionCredential,
        invocation: ConnectorInvocation,
    ) -> Result<InvokeResponse, ConnectorInvokeError> {
        // 1. Capability. A browser execution target that needs a vault-held
        //    TLS identity is refused here, typed, with no export and no proxy.
        transport.require_executable()?;

        // 2. Egress preflight, before anything is resolved or opened.
        let prepared = self.fence.preflight(InvokeRequest {
            provider_id: ctx.provider_id.clone(),
            method: invocation.method,
            url: invocation.url,
            headers: invocation.headers,
            body: invocation.body,
            subject: None,
            actor: None,
        })?;

        // 3. Resolve the references. The broker reads no file and opens no
        //    socket of its own; the resolver owns custody.
        let identity = self.resolve_identity(ctx, transport).await?;
        let (trust, trust_generation) = self.resolve_trust(ctx, transport).await?;

        // 4. Pin the approved authority's addresses. Resolved once, here,
        //    between the fence and the dial, so no second lookup can point a
        //    credentialed request somewhere else.
        let authority = self.pin_authority(&prepared).await?;

        // 5. The client for exactly this scope.
        let key = ConnectorPoolKey {
            organization_id: ctx.organization_id.clone(),
            connection_id: ctx.connection_id.clone(),
            executor: transport.execution_target,
            authority: authority.label.clone(),
            credential_thumbprint: identity
                .as_ref()
                .map(|value| value.leaf_thumbprint_sha256()),
            trust_profile: transport.trust.as_ref().map(|value| value.name.clone()),
            trust_generation,
            policy: transport.policy,
        };
        let allow_loopback = self.allow_loopback_for_tests;
        let invoker = self.pool.get_or_build(&key, || {
            build_invoker(
                transport,
                identity.as_ref(),
                trust.as_ref(),
                &authority,
                self.fence.rules().to_vec(),
                allow_loopback,
            )
        })?;

        // 6. Only now is the sealed credential opened, for this one request.
        let token = credential.open_bearer(ctx).await?;

        // 7. The wire.
        Ok(invoker.execute(&token, prepared).await?)
    }

    async fn resolve_identity(
        &self,
        ctx: &ConnectorContext,
        transport: &ConnectionTransport,
    ) -> Result<Option<Arc<TlsIdentity>>, TransportError> {
        let Some(reference) = transport.identity.clone() else {
            return Ok(None);
        };
        self.resolvers
            .identities
            .resolve(IdentityScope {
                organization_id: ctx.organization_id.clone(),
                connection_id: ctx.connection_id.clone(),
                identity: reference,
                purpose: PURPOSE_CONNECTOR_INVOKE,
            })
            .await
            .map(Some)
    }

    async fn resolve_trust(
        &self,
        ctx: &ConnectorContext,
        transport: &ConnectionTransport,
    ) -> Result<(Option<Arc<TrustBundle>>, u64), TransportError> {
        let Some(reference) = transport.trust.clone() else {
            if transport.policy == TransportPolicy::MtlsRequired {
                return Err(TransportError::TrustUnknown);
            }
            return Ok((None, 0));
        };
        let bundle = self
            .resolvers
            .trust
            .resolve_trust(TrustScope {
                organization_id: ctx.organization_id.clone(),
                connection_id: ctx.connection_id.clone(),
                trust: reference,
                purpose: PURPOSE_CONNECTOR_INVOKE,
            })
            .await?;
        let generation = bundle.generation();
        Ok((Some(bundle), generation))
    }

    /// Resolve the cleared authority to addresses, refusing anything an
    /// upstream should never be: a loopback, link-local, private or otherwise
    /// internal address a DNS answer could point a credentialed request at
    /// (AT-CONNECTOR-EGRESS).
    async fn pin_authority(
        &self,
        prepared: &PreparedRequest,
    ) -> Result<PinnedAuthority, TransportError> {
        let host = prepared.host().to_ascii_lowercase();
        let port = prepared.port().unwrap_or(443);
        let mut addrs: Vec<SocketAddr> = tokio::net::lookup_host((host.as_str(), port))
            .await
            .map_err(|_| TransportError::malformed("connector authority did not resolve"))?
            .collect();
        if !self.allow_loopback_for_tests {
            addrs.retain(|addr| !is_internal(addr.ip()));
        }
        if addrs.is_empty() {
            return Err(TransportError::malformed(
                "connector authority resolved to no permitted address",
            ));
        }
        Ok(PinnedAuthority {
            label: format!("{host}:{port}"),
            host,
            addrs,
        })
    }
}

/// Every step of [`ConnectorTransportExecutor::invoke`], in the only order
/// that is safe, as markers to look for in this file's production source.
pub const INVOKE_ORDER: &[&str] = &[
    "transport.require_executable()",
    "self.fence.preflight(",
    "self.resolve_identity(",
    "self.pin_authority(",
    "self.pool.get_or_build(",
    "credential.open_bearer(",
    "invoker.execute(",
];

/// The ordering above, read back out of this file's own source. The same
/// oracle `crates/gateway` uses for the ADR 0076 rotation pact, kept local so
/// the broker gains no dependency for it.
///
/// # Panics
///
/// Panics when a step is missing or has moved ahead of one it must follow.
pub fn assert_invoke_order() {
    let src = include_str!("transport_execute.rs");
    let production = src.split("#[cfg(test)]").next().unwrap_or(src);
    let mut last = 0usize;
    for marker in INVOKE_ORDER {
        let found = production
            .get(last..)
            .and_then(|rest| rest.find(marker))
            .map_or_else(
                || panic!("connector invoke order: {marker} is missing or out of order"),
                |offset| last + offset,
            );
        last = found;
    }
}

#[cfg(test)]
#[path = "transport_execute_tests.rs"]
mod tests;
