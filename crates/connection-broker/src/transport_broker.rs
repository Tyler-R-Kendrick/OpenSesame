//! The broker's own transport surface (ADR 0130, CONN-MODEL/CONN-EXECUTE).
//!
//! This is the production call site: the methods a gateway route reaches, and
//! the one implementation of [`ConnectionCredential`] that opens a real sealed
//! credential. Everything an agent can touch is a `ConnectionRef` and an
//! intent; nothing here returns credential material, a certificate's private
//! key, a path, or a trust anchor.
//!
//! Authorization comes first and is the broker's existing rule, unchanged: a
//! connection in another organization reads as *absent*
//! (`ConnectionBroker::row_in_org`), a revoked one is refused, and a
//! non-active one needs re-authorization. Only then does the transport record
//! matter, and only then does [`ConnectorTransportExecutor::invoke`] run its
//! own ordered fences.

use async_trait::async_trait;
use opensesame_domain::transport::{CapabilityOutcome, TransportError};
use opensesame_domain::OrganizationId;
use opensesame_invoke_through::InvokeResponse;
use secrecy::SecretString;

use crate::error::{BrokerError, Result};
use crate::model::ConnectionStatus;
use crate::store;
use crate::transport::execute::{
    ConnectionCredential, ConnectorContext, ConnectorInvocation, ConnectorInvokeError,
    ConnectorTransportExecutor,
};
use crate::transport::ConnectionTransport;
use crate::ConnectionBroker;

#[async_trait]
impl ConnectionCredential for ConnectionBroker {
    /// Opens the stored credential for one outbound connector request.
    ///
    /// Mirrors `rotation_verify::resolve_bearer`: the sealed blob is opened
    /// under the deployment key bound to *this* connection and *this*
    /// organization (`crypto::open_scoped`'s associated data), so a row moved
    /// between tenants does not decrypt. The value never leaves this
    /// `SecretString`, which the invoker zeroizes with the request.
    async fn open_bearer(&self, ctx: &ConnectorContext) -> std::result::Result<SecretString, TransportError> {
        let key = *self
            .sealing_key()
            .map_err(|_| TransportError::malformed("credential sealing unavailable"))?;
        let row = store::get_connection(&self.pool, &ctx.connection_id)
            .await
            .map_err(|_| TransportError::malformed("connection is unreadable"))?
            .filter(|row| row.organization_id == ctx.organization_id)
            .ok_or(TransportError::IdentityMissing)?;
        let credential = store::get_credential(&self.pool, &row.id)
            .await
            .map_err(|_| TransportError::malformed("credential is unreadable"))?
            .ok_or(TransportError::IdentityMissing)?;
        let tokens = Self::open_tokens(&key, &row, &credential)
            .map_err(|_| TransportError::malformed("credential could not be opened"))?;
        if tokens.access_token.is_empty() {
            return Err(TransportError::IdentityMissing);
        }
        Ok(SecretString::from(tokens.access_token))
    }
}

impl ConnectionBroker {
    /// A connection's transport record, or `None` when it has none and
    /// therefore behaves exactly as it did before mTLS existed.
    ///
    /// # Errors
    ///
    /// `ConnectionNotFound` for another organization's id; `Invalid` when the
    /// persisted record no longer parses (fail closed, never "unconfigured").
    pub async fn connection_transport(
        &self,
        organization_id: &OrganizationId,
        connection_id: &str,
    ) -> Result<Option<ConnectionTransport>> {
        self.row_in_org(organization_id, connection_id).await?;
        crate::transport::store::get(&self.pool, &organization_id.to_string(), connection_id).await
    }

    /// Set or clear a connection's transport record.
    ///
    /// This is a configuration mutation, not an agent capability: the caller is
    /// already an operator or the connection's owner by the time it reaches
    /// here. Writing it drops every pooled client for the connection, because
    /// a changed identity, trust profile or policy must not keep serving on a
    /// TLS connection authenticated under the old one.
    ///
    /// # Errors
    ///
    /// `ConnectionNotFound`, or `Invalid` when the record does not validate.
    pub async fn set_connection_transport(
        &self,
        organization_id: &OrganizationId,
        connection_id: &str,
        transport: Option<&ConnectionTransport>,
        executor: Option<&ConnectorTransportExecutor>,
    ) -> Result<()> {
        self.row_in_org(organization_id, connection_id).await?;
        crate::transport::store::set(
            &self.pool,
            &organization_id.to_string(),
            connection_id,
            transport,
        )
        .await?;
        if let Some(executor) = executor {
            executor
                .pool()
                .forget_connection(&organization_id.to_string(), connection_id);
        }
        Ok(())
    }

    /// Whether this connection can be executed as configured (CONN-CAPABILITY).
    ///
    /// A browser-targeted connection that needs a Host-held TLS identity is
    /// `Unsupported`, with the reason the PWA's `assertBrowserExecution` gate
    /// keys on. Nothing is exported and nothing is proxied to make it work
    /// (AT-BROWSER-KEY). A connection with no transport record is `Supported`:
    /// an unconfigured optional feature is not an error.
    ///
    /// # Errors
    ///
    /// `ConnectionNotFound` for another organization's id.
    pub async fn execution_capability(
        &self,
        organization_id: &OrganizationId,
        connection_id: &str,
    ) -> Result<CapabilityOutcome> {
        Ok(self
            .connection_transport(organization_id, connection_id)
            .await?
            .map_or(CapabilityOutcome::Supported, |transport| {
                transport.execution_capability()
            }))
    }

    /// Invoke an upstream through the connection's configured transport.
    ///
    /// # Errors
    ///
    /// `ConnectionNotFound` for another organization's id, `Invalid` for a
    /// revoked connection or a URL outside the connection's egress allowlist,
    /// `NeedsReauth` for a connection that is not active, and `Invalid`
    /// carrying a stable transport/egress reason code when the executor's own
    /// fences refuse.
    pub async fn invoke_over_transport(
        &self,
        organization_id: &OrganizationId,
        connection_id: &str,
        executor: &ConnectorTransportExecutor,
        invocation: ConnectorInvocation,
    ) -> Result<InvokeResponse> {
        // Authorization first: tenant, revocation, status, then the
        // connection's own approved destinations.
        let row = self.row_in_org(organization_id, connection_id).await?;
        if row.status == ConnectionStatus::Revoked {
            return Err(BrokerError::Invalid("connection is revoked".into()));
        }
        if row.status != ConnectionStatus::Active {
            return Err(BrokerError::NeedsReauth(format!(
                "connection status is {}",
                row.status.as_str()
            )));
        }
        row.egress
            .allows_url(&invocation.url)
            .map_err(|error| BrokerError::Invalid(error.to_string()))?;

        let transport = crate::transport::store::get(
            &self.pool,
            &row.organization_id,
            connection_id,
        )
        .await?
        .ok_or_else(|| {
            BrokerError::Invalid("connection has no transport requirement configured".into())
        })?;

        let ctx = ConnectorContext {
            organization_id: row.organization_id.clone(),
            connection_id: row.id.clone(),
            provider_id: row.provider_id.clone(),
        };
        executor
            .invoke(&ctx, &transport, self, invocation)
            .await
            .map_err(|error| invoke_error(&error))
    }
}

/// A connector refusal as a broker error. The message is a stable reason code
/// and nothing else: an upstream body, a certificate subject and a filesystem
/// path all stay out of it.
fn invoke_error(error: &ConnectorInvokeError) -> BrokerError {
    BrokerError::Invalid(format!("connector transport refused: {}", error.code()))
}
