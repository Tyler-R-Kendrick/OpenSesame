//! What a mint leaves behind (ADR 0207): a value-blind receipt.
//!
//! The receipt — grant id, role, session name, source identity, duration,
//! expiry, STS's request id, and who asked for whom — is the connection's
//! `materialized` event, sealed at rest by the event path (ADR 0157).

use chrono::{DateTime, Utc};

use crate::aws_mint::KIND;
use crate::aws_sts::MintReceipt;
use crate::store::{self, ConnectionRow};
use crate::{ConnectionBroker, EventKind, Result};

impl ConnectionBroker {
    /// Write a mint's receipt event.
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
        tracing::info!(
            connection_id = %row.id, grant_id = %receipt.grant_id, request_id = %receipt.request_id,
            expires_at = %receipt.expires_at, "aws sts credential minted"
        );
        Ok(())
    }
}
