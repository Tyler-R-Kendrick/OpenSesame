//! Certificate authority records and the dashboard rollup over them.
//!
//! Split out of the single `impl Db` block in `lib.rs`, which had grown to
//! 215 methods across 5,292 lines. Rust spreads a type's inherent impl over
//! any number of modules in the same crate, so this is a pure move: no
//! signature, visibility or call site changes.

use super::{
    stored_certificate_authority, validate_sealed_material, Context, Db, Row,
    StoredCertificateAuthority, Utc,
};

impl Db {
    /// Insert a sealed certificate authority.
    ///
    /// # Errors
    ///
    /// Returns an error when validation, serialization, or persistence fails.
    pub async fn insert_certificate_authority(
        &self,
        authority: &StoredCertificateAuthority,
    ) -> anyhow::Result<()> {
        validate_sealed_material(&authority.sealed_material)?;
        if authority.is_default && authority.status != "active" {
            anyhow::bail!("only an active certificate authority may be default");
        }
        serde_json::from_str::<serde_json::Value>(&authority.public_metadata_json)
            .context("certificate authority public metadata is not valid JSON")?;
        let mut transaction = self.pool.begin().await?;
        sqlx::query("INSERT OR IGNORE INTO organizations (id, name, created_at) VALUES (?, ?, ?)")
            .bind(&authority.organization_id)
            .bind(&authority.organization_id)
            .bind(&authority.created_at)
            .execute(&mut *transaction)
            .await?;
        sqlx::query(
            "INSERT INTO certificate_authorities (id, organization_id, issuer_kind, issuer_connection_id, display_name, public_metadata_json, sealed_key_id, sealed_ciphertext, sealed_nonce, sealed_aad_digest, is_default, status, version, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&authority.id)
        .bind(&authority.organization_id)
        .bind(&authority.issuer_kind)
        .bind(&authority.issuer_connection_id)
        .bind(&authority.display_name)
        .bind(&authority.public_metadata_json)
        .bind(&authority.sealed_material.key_id)
        .bind(&authority.sealed_material.ciphertext)
        .bind(&authority.sealed_material.nonce)
        .bind(&authority.sealed_material.aad_digest)
        .bind(i64::from(authority.is_default))
        .bind(&authority.status)
        .bind(authority.version)
        .bind(&authority.created_at)
        .bind(&authority.updated_at)
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;
        Ok(())
    }

    /// # Errors
    ///
    /// Returns an error when the lookup fails.
    pub async fn get_certificate_authority(
        &self,
        organization_id: &str,
        authority_id: &str,
    ) -> anyhow::Result<Option<StoredCertificateAuthority>> {
        let row = sqlx::query(
            "SELECT * FROM certificate_authorities WHERE organization_id = ? AND id = ?",
        )
        .bind(organization_id)
        .bind(authority_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.as_ref().map(stored_certificate_authority))
    }

    /// # Errors
    ///
    /// Returns an error when the lookup fails.
    pub async fn get_default_certificate_authority(
        &self,
        organization_id: &str,
    ) -> anyhow::Result<Option<StoredCertificateAuthority>> {
        let row = sqlx::query(
            "SELECT * FROM certificate_authorities WHERE organization_id = ? AND is_default = 1",
        )
        .bind(organization_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.as_ref().map(stored_certificate_authority))
    }

    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn list_certificate_authorities(
        &self,
        organization_id: &str,
    ) -> anyhow::Result<Vec<StoredCertificateAuthority>> {
        let rows = sqlx::query(
            "SELECT * FROM certificate_authorities WHERE organization_id = ? ORDER BY is_default DESC, created_at, id",
        )
        .bind(organization_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.iter().map(stored_certificate_authority).collect())
    }

    /// Select one active default using compare-and-swap. This never falls back
    /// to another issuer when the selected row is absent, stale, or inactive.
    ///
    /// # Errors
    ///
    /// Returns an error when the transaction fails.
    pub async fn set_default_certificate_authority(
        &self,
        organization_id: &str,
        authority_id: &str,
        expected_version: i64,
    ) -> anyhow::Result<bool> {
        let mut transaction = self.pool.begin().await?;
        let target = sqlx::query(
            "SELECT version, status FROM certificate_authorities WHERE organization_id = ? AND id = ?",
        )
        .bind(organization_id)
        .bind(authority_id)
        .fetch_optional(&mut *transaction)
        .await?;
        let Some(target) = target else {
            return Ok(false);
        };
        if target.get::<i64, _>("version") != expected_version
            || target.get::<String, _>("status") != "active"
        {
            return Ok(false);
        }
        let now = Utc::now().to_rfc3339();
        sqlx::query(
            "UPDATE certificate_authorities SET is_default = 0, version = version + 1, updated_at = ? \
             WHERE organization_id = ? AND is_default = 1 AND id <> ?",
        )
        .bind(&now)
        .bind(organization_id)
        .bind(authority_id)
        .execute(&mut *transaction)
        .await?;
        let updated = sqlx::query(
            "UPDATE certificate_authorities SET is_default = 1, version = version + 1, updated_at = ? \
             WHERE organization_id = ? AND id = ? AND version = ? AND status = 'active'",
        )
        .bind(&now)
        .bind(organization_id)
        .bind(authority_id)
        .bind(expected_version)
        .execute(&mut *transaction)
        .await?;
        if updated.rows_affected() != 1 {
            transaction.rollback().await?;
            return Ok(false);
        }
        transaction.commit().await?;
        Ok(true)
    }

    /// # Errors
    ///
    /// Returns an error when the update fails.
    pub async fn update_certificate_authority_status(
        &self,
        organization_id: &str,
        authority_id: &str,
        expected_version: i64,
        status: &str,
    ) -> anyhow::Result<bool> {
        let result = sqlx::query(
            "UPDATE certificate_authorities SET status = ?, is_default = CASE WHEN ? = 'active' THEN is_default ELSE 0 END, version = version + 1, updated_at = ? \
             WHERE organization_id = ? AND id = ? AND version = ?",
        )
        .bind(status)
        .bind(status)
        .bind(Utc::now().to_rfc3339())
        .bind(organization_id)
        .bind(authority_id)
        .bind(expected_version)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }
}
