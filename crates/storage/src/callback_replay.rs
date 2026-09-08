//! Durable, bounded callback admission. The primary key elects one receiver.
use super::Db;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CallbackClaim {
    New,
    Duplicate,
    Mismatch,
    Capacity,
}

impl Db {
    /// Claim only after signature, timestamp, route, and body validation.
    ///
    /// # Errors
    /// Returns storage errors without treating unavailable replay state as acceptance.
    pub async fn claim_callback_delivery(
        &self,
        connection: &str,
        delivery: &str,
        digest: &str,
        now: i64,
    ) -> anyhow::Result<CallbackClaim> {
        anyhow::ensure!(
            connection.len() <= 128 && delivery.len() <= 128 && digest.len() == 64,
            "invalid callback claim"
        );
        let expiry = now
            .checked_add(601)
            .ok_or_else(|| anyhow::anyhow!("invalid callback time"))?;
        let mut tx = self.pool.begin().await?;
        // Write first: SQLite serializes competing replicas before the insert/select.
        sqlx::query("DELETE FROM callback_edge_deliveries WHERE expires_at<=?")
            .bind(now)
            .execute(&mut *tx)
            .await?;
        let inserted = sqlx::query("INSERT INTO callback_edge_deliveries(connection_id,delivery_id,request_digest,expires_at)
            SELECT ?,?,?,? WHERE (SELECT COUNT(*) FROM callback_edge_deliveries)<100000
            ON CONFLICT(connection_id,delivery_id) DO NOTHING")
            .bind(connection).bind(delivery).bind(digest).bind(expiry).execute(&mut *tx).await?.rows_affected() == 1;
        let result = if inserted {
            CallbackClaim::New
        } else {
            let existing: Option<String> = sqlx::query_scalar("SELECT request_digest FROM callback_edge_deliveries WHERE connection_id=? AND delivery_id=?")
                .bind(connection).bind(delivery).fetch_optional(&mut *tx).await?;
            match existing {
                Some(value) if value == digest => CallbackClaim::Duplicate,
                Some(_) => CallbackClaim::Mismatch,
                None => CallbackClaim::Capacity,
            }
        };
        tx.commit().await?;
        Ok(result)
    }
}
