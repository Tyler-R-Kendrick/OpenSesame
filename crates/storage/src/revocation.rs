//! Certificate revocation entries and CRL state.
//!
//! Split out of the single `impl Db` block in `lib.rs`, which had grown to
//! 215 methods across 5,292 lines. Rust spreads a type's inherent impl over
//! any number of modules in the same crate, so this is a pure move: no
//! signature, visibility or call site changes.

use super::{
    now_rfc3339, sealed_parts, stored_certificate_revocation, stored_crl_state,
    validate_json_document, validate_optional_sealed_material, Db, StoredCertificateRevocation,
    StoredCrlState,
};

impl Db {
    /// Record a revocation and flip the certificate in the same transaction.
    ///
    /// # Errors
    ///
    /// Returns an error when the certificate is absent from the organization or
    /// the transaction fails.
    pub async fn insert_certificate_revocation(
        &self,
        revocation: &StoredCertificateRevocation,
    ) -> anyhow::Result<()> {
        let mut transaction = self.pool.begin().await?;
        sqlx::query(
            "INSERT INTO certificate_revocations (id, organization_id, certificate_id, ca_id, serial, reason_code, revoked_at, crl_number, version, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&revocation.id)
        .bind(&revocation.organization_id)
        .bind(&revocation.certificate_id)
        .bind(&revocation.ca_id)
        .bind(&revocation.serial)
        .bind(revocation.reason_code)
        .bind(&revocation.revoked_at)
        .bind(revocation.crl_number)
        .bind(revocation.version)
        .bind(&revocation.created_at)
        .bind(&revocation.updated_at)
        .execute(&mut *transaction)
        .await?;
        let updated = sqlx::query(
            "UPDATE issued_certificates SET status = 'revoked', revocation_reason = ?, revoked_at = ?, version = version + 1, updated_at = ? \
             WHERE organization_id = ? AND id = ?",
        )
        .bind(revocation.reason_code)
        .bind(&revocation.revoked_at)
        .bind(now_rfc3339())
        .bind(&revocation.organization_id)
        .bind(&revocation.certificate_id)
        .execute(&mut *transaction)
        .await?;
        if updated.rows_affected() != 1 {
            transaction.rollback().await?;
            anyhow::bail!("revocation target is not in this organization");
        }
        transaction.commit().await?;
        Ok(())
    }

    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn list_revocations_for_ca(
        &self,
        organization_id: &str,
        ca_id: &str,
    ) -> anyhow::Result<Vec<StoredCertificateRevocation>> {
        let rows = sqlx::query(
            "SELECT * FROM certificate_revocations WHERE organization_id = ? AND ca_id = ? ORDER BY revoked_at, serial",
        )
        .bind(organization_id)
        .bind(ca_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.iter().map(stored_certificate_revocation).collect())
    }

    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn get_crl_state(
        &self,
        organization_id: &str,
        ca_id: &str,
    ) -> anyhow::Result<Option<StoredCrlState>> {
        let row = sqlx::query("SELECT * FROM crl_state WHERE organization_id = ? AND ca_id = ?")
            .bind(organization_id)
            .bind(ca_id)
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.as_ref().map(stored_crl_state))
    }

    /// Publish the newest signed CRL for an authority.
    ///
    /// # Errors
    ///
    /// Returns an error when the sealed DER group is partially populated or the
    /// upsert fails.
    pub async fn upsert_crl_state(&self, state: &StoredCrlState) -> anyhow::Result<()> {
        validate_optional_sealed_material(state.sealed_der.as_ref())?;
        if let Some(mirrors) = &state.mirror_urls_json {
            validate_json_document(mirrors, "CRL mirror list")?;
        }
        let (key_id, ciphertext, nonce, aad_digest) = sealed_parts(state.sealed_der.as_ref());
        sqlx::query(
            "INSERT INTO crl_state (id, organization_id, ca_id, crl_number, this_update, next_update, sealed_der_key_id, sealed_der_ciphertext, sealed_der_nonce, sealed_der_aad_digest, mirror_urls_json, version, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) \
             ON CONFLICT(organization_id, ca_id) DO UPDATE SET \
               crl_number = excluded.crl_number, this_update = excluded.this_update, next_update = excluded.next_update, \
               sealed_der_key_id = excluded.sealed_der_key_id, sealed_der_ciphertext = excluded.sealed_der_ciphertext, \
               sealed_der_nonce = excluded.sealed_der_nonce, sealed_der_aad_digest = excluded.sealed_der_aad_digest, \
               mirror_urls_json = excluded.mirror_urls_json, version = crl_state.version + 1, updated_at = excluded.updated_at",
        )
        .bind(&state.id)
        .bind(&state.organization_id)
        .bind(&state.ca_id)
        .bind(state.crl_number)
        .bind(&state.this_update)
        .bind(&state.next_update)
        .bind(key_id)
        .bind(ciphertext)
        .bind(nonce)
        .bind(aad_digest)
        .bind(&state.mirror_urls_json)
        .bind(state.version)
        .bind(&state.created_at)
        .bind(&state.updated_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    // —— network discovery ————————————————————————————————————————
}
