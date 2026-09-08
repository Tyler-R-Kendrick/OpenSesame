//! Offline operator migration only. No browser, agent or network route calls this API.
use crate::{append_outbox_tx, Db};
use opensesame_domain::{OrganizationId, PrincipalId};

impl Db {
    /// Bind an explicitly reviewed set of quarantined ciphertext revisions.
    /// The operator supplies an evidence digest after verifying principal/org ownership.
    ///
    /// # Errors
    /// Rejects unknown organizations, stale/wrong-owner rows, collisions and invalid evidence.
    pub async fn rebind_legacy_sync_blobs(
        &self,
        owner: &PrincipalId,
        organization: &OrganizationId,
        revisions: &[(String, u64)],
        evidence_digest: &str,
    ) -> anyhow::Result<usize> {
        anyhow::ensure!(
            !revisions.is_empty() && revisions.len() <= 64,
            "select 1 to 64 explicit revisions"
        );
        anyhow::ensure!(
            evidence_digest.len() == 64 && evidence_digest.bytes().all(|b| b.is_ascii_hexdigit()),
            "invalid ownership evidence digest"
        );
        let owner = owner.to_string();
        let organization = organization.to_string();
        let mut transaction = self.pool.begin().await?;
        let exists: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM organizations WHERE id = ?")
            .bind(&organization)
            .fetch_one(&mut *transaction)
            .await?;
        anyhow::ensure!(exists == 1, "organization must already exist");
        let ingestion_epoch: i64 = sqlx::query_scalar("UPDATE sync_ingestion_clock SET epoch = epoch + 1 WHERE singleton = 1 AND epoch < 9223372036854775807 RETURNING epoch")
            .fetch_one(&mut *transaction).await?;
        for (id, epoch) in revisions {
            anyhow::ensure!(!id.is_empty() && id.len() <= 128, "invalid blob id");
            let changed = sqlx::query("UPDATE encrypted_sync_blobs SET organization_id = ?, ingestion_epoch = ? WHERE organization_id = '' AND owner_id = ? AND id = ? AND epoch = ?")
                .bind(&organization).bind(ingestion_epoch).bind(&owner).bind(id).bind(i64::try_from(*epoch)?)
                .execute(&mut *transaction).await?.rows_affected();
            anyhow::ensure!(
                changed == 1,
                "selected legacy revision is unavailable; no rows rebound"
            );
        }
        append_outbox_tx(
            &mut transaction,
            "sync.legacy.rebound",
            &serde_json::json!({
                "owner_id":owner,"organization_id":organization,"revisions":revisions,
                "ownership_evidence_digest":evidence_digest,
            })
            .to_string(),
        )
        .await?;
        transaction.commit().await?;
        Ok(revisions.len())
    }
}
