//! What a mint leaves behind (ADR 0217): a value-blind receipt and a deadline.
//!
//! The receipt — grant id, role, session name, source identity, duration,
//! expiry, STS's request id, and who asked for whom — is the connection's
//! `materialized` event, sealed at rest by the event path (ADR 0157). The
//! deadline goes to the mint register's plain columns, which the lifecycle
//! scanner reads without opening a seal, so the credential's expiry is
//! published on the `lifecycle.*` feed (ADR 0074).

use chrono::{DateTime, Utc};
use opensesame_domain::OrganizationId;

use crate::aws_mint::KIND;
use crate::aws_sts::register::{self, MintDeadline};
use crate::aws_sts::MintReceipt;
use crate::store::{self, ConnectionRow};
use crate::{ConnectionBroker, EventKind, Result};

impl ConnectionBroker {
    /// Write a mint's receipt event and register its deadline.
    pub(crate) async fn record_aws_mint(
        &self,
        row: &ConnectionRow,
        receipt: &MintReceipt,
        subject: &str,
        actor: &str,
        expires_at: DateTime<Utc>,
        issued_at: DateTime<Utc>,
    ) -> Result<()> {
        let detail = serde_json::json!({
            "kind": KIND, "receipt": receipt, "sub": subject, "act": actor,
        });
        store::append_event(
            &self.pool,
            &row.id,
            EventKind::Materialized,
            Some(&detail.to_string()),
        )
        .await?;
        register::record_mint(
            &self.pool,
            &MintDeadline {
                grant_id: receipt.grant_id.clone(),
                connection_id: row.id.clone(),
                organization_id: row.organization_id.clone(),
                expires_at,
            },
            issued_at,
        )
        .await?;
        tracing::info!(
            connection_id = %row.id, grant_id = %receipt.grant_id, request_id = %receipt.request_id,
            expires_at = %receipt.expires_at, "aws sts credential minted"
        );
        Ok(())
    }

    /// Minted AWS credentials in one organization for one lifecycle pass: up
    /// to `limit` live at `now`, soonest first, and up to `limit` lapsed after
    /// `since`, most recently lapsed first ([`register::mints_to_scan`]).
    ///
    /// # Errors
    ///
    /// Storage failures.
    pub async fn aws_sts_mint_deadlines(
        &self,
        organization_id: &OrganizationId,
        now: DateTime<Utc>,
        since: DateTime<Utc>,
        limit: i64,
    ) -> Result<Vec<MintDeadline>> {
        register::mints_to_scan(&self.pool, &organization_id.to_string(), now, since, limit).await
    }
}
