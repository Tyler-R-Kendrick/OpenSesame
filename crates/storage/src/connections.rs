//! `ConnectionRef` record persistence.
//!
//! Split out of the single `impl Db` block in `lib.rs`, which had grown to
//! 215 methods across 5,292 lines. Rust spreads a type's inherent impl over
//! any number of modules in the same crate, so this is a pure move: no
//! signature, visibility or call site changes.

use super::{
    now_rfc3339, stored_certificate_authority, stored_signing_access_record,
    validate_json_document, ConnectionId, ConnectionRecord, Db, OrganizationId, Row,
    StoredCertificateAuthority, StoredSigningAccessRecord, Utc,
};

impl Db {
    /// Validate and atomically persist a provider connection.
    ///
    /// # Errors
    ///
    /// Returns an error when public configuration is unsafe, serialization
    /// fails, or the transaction cannot be committed.
    pub async fn insert_connection(&self, connection: &ConnectionRecord) -> anyhow::Result<()> {
        connection
            .assert_public_config_safe()
            .map_err(anyhow::Error::msg)?;
        let mut transaction = self.pool.begin().await?;
        // Organization membership is established by Identity before Host mints
        // the session. Materialize that trusted tenant locally so the provider
        // connection can satisfy Host's foreign-key boundary.
        sqlx::query("INSERT OR IGNORE INTO organizations (id, name, created_at) VALUES (?, ?, ?)")
            .bind(connection.organization_id.to_string())
            .bind(connection.organization_id.to_string())
            .bind(Utc::now().to_rfc3339())
            .execute(&mut *transaction)
            .await?;
        sqlx::query(
            "INSERT INTO provider_connections (id, organization_id, project_id, provider_id, display_name, body_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(connection.id.to_string())
        .bind(connection.organization_id.to_string())
        .bind(connection.project_id.map(|id| id.to_string()))
        .bind(&connection.provider_id)
        .bind(&connection.display_name)
        .bind(serde_json::to_string(connection)?)
        .bind(connection.created_at.to_rfc3339())
        .bind(connection.updated_at.to_rfc3339())
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;
        Ok(())
    }

    /// Validate and update an organization-scoped provider connection.
    ///
    /// # Errors
    ///
    /// Returns an error when public configuration is unsafe, serialization
    /// fails, or the database update fails.
    pub async fn update_connection(&self, connection: &ConnectionRecord) -> anyhow::Result<bool> {
        connection
            .assert_public_config_safe()
            .map_err(anyhow::Error::msg)?;
        let result = sqlx::query(
            "UPDATE provider_connections SET provider_id = ?, display_name = ?, body_json = ?, updated_at = ? WHERE id = ? AND organization_id = ?",
        )
        .bind(&connection.provider_id)
        .bind(&connection.display_name)
        .bind(serde_json::to_string(connection)?)
        .bind(connection.updated_at.to_rfc3339())
        .bind(connection.id.to_string())
        .bind(connection.organization_id.to_string())
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    /// Read one organization-scoped provider connection.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails or stored JSON is invalid.
    pub async fn get_connection(
        &self,
        organization_id: &OrganizationId,
        id: &ConnectionId,
    ) -> anyhow::Result<Option<ConnectionRecord>> {
        let row = sqlx::query(
            "SELECT body_json FROM provider_connections WHERE id = ? AND organization_id = ?",
        )
        .bind(id.to_string())
        .bind(organization_id.to_string())
        .fetch_optional(&self.pool)
        .await?;
        row.map(|row| serde_json::from_str(&row.get::<String, _>("body_json")))
            .transpose()
            .map_err(Into::into)
    }

    /// List provider connections belonging to one organization.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails or any stored connection is invalid.
    pub async fn list_connections(
        &self,
        organization_id: &OrganizationId,
    ) -> anyhow::Result<Vec<ConnectionRecord>> {
        let rows = sqlx::query(
            "SELECT body_json FROM provider_connections WHERE organization_id = ? ORDER BY created_at, id",
        )
        .bind(organization_id.to_string())
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(|row| serde_json::from_str(&row.get::<String, _>("body_json")).map_err(Into::into))
            .collect()
    }

    /// Delete one organization-scoped provider connection.
    ///
    /// # Errors
    ///
    /// Returns an error when the database deletion fails.
    pub async fn delete_connection(
        &self,
        organization_id: &OrganizationId,
        id: &ConnectionId,
    ) -> anyhow::Result<bool> {
        let result =
            sqlx::query("DELETE FROM provider_connections WHERE id = ? AND organization_id = ?")
                .bind(id.to_string())
                .bind(organization_id.to_string())
                .execute(&self.pool)
                .await?;
        Ok(result.rows_affected() == 1)
    }

    /// Link a child authority to a same-organization parent.
    ///
    /// # Errors
    ///
    /// Returns an error when the parent is absent, belongs to another
    /// organization, or would link the authority to itself.
    pub async fn insert_ca_link(
        &self,
        organization_id: &str,
        child_id: &str,
        parent_id: &str,
    ) -> anyhow::Result<bool> {
        if child_id == parent_id {
            anyhow::bail!("a certificate authority cannot be its own parent");
        }
        let parent = sqlx::query(
            "SELECT 1 AS present FROM certificate_authorities WHERE organization_id = ? AND id = ?",
        )
        .bind(organization_id)
        .bind(parent_id)
        .fetch_optional(&self.pool)
        .await?;
        if parent.is_none() {
            anyhow::bail!("parent certificate authority is not in this organization");
        }
        let result = sqlx::query(
            "UPDATE certificate_authorities SET parent_id = ?, kind = 'intermediate', version = version + 1, updated_at = ? \
             WHERE organization_id = ? AND id = ?",
        )
        .bind(parent_id)
        .bind(now_rfc3339())
        .bind(organization_id)
        .bind(child_id)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn get_ca_children(
        &self,
        organization_id: &str,
        authority_id: &str,
    ) -> anyhow::Result<Vec<StoredCertificateAuthority>> {
        let rows = sqlx::query(
            "SELECT * FROM certificate_authorities WHERE organization_id = ? AND parent_id = ? ORDER BY created_at, id",
        )
        .bind(organization_id)
        .bind(authority_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.iter().map(stored_certificate_authority).collect())
    }

    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn get_ca_parent(
        &self,
        organization_id: &str,
        authority_id: &str,
    ) -> anyhow::Result<Option<StoredCertificateAuthority>> {
        let row = sqlx::query(
            "SELECT parent.* FROM certificate_authorities AS child \
             JOIN certificate_authorities AS parent \
               ON parent.organization_id = child.organization_id AND parent.id = child.parent_id \
             WHERE child.organization_id = ? AND child.id = ?",
        )
        .bind(organization_id)
        .bind(authority_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.as_ref().map(stored_certificate_authority))
    }

    /// Record the CSR an externally signed intermediate is waiting on.
    ///
    /// # Errors
    ///
    /// Returns an error when the update fails.
    pub async fn set_ca_pending_csr(
        &self,
        organization_id: &str,
        authority_id: &str,
        csr_pem: &str,
    ) -> anyhow::Result<bool> {
        let result = sqlx::query(
            "UPDATE certificate_authorities SET pending_csr_pem = ?, version = version + 1, updated_at = ? \
             WHERE organization_id = ? AND id = ?",
        )
        .bind(csr_pem)
        .bind(now_rfc3339())
        .bind(organization_id)
        .bind(authority_id)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    /// Clear the pending CSR and publish the signed chain metadata.
    ///
    /// # Errors
    ///
    /// Returns an error when the metadata is not JSON or the update fails.
    pub async fn complete_ca_import(
        &self,
        organization_id: &str,
        authority_id: &str,
        expected_version: i64,
        public_metadata_json: &str,
    ) -> anyhow::Result<bool> {
        validate_json_document(public_metadata_json, "certificate authority metadata")?;
        let result = sqlx::query(
            "UPDATE certificate_authorities SET public_metadata_json = ?, pending_csr_pem = NULL, status = 'active', version = version + 1, updated_at = ? \
             WHERE organization_id = ? AND id = ? AND version = ?",
        )
        .bind(public_metadata_json)
        .bind(now_rfc3339())
        .bind(organization_id)
        .bind(authority_id)
        .bind(expected_version)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    // —— PKI applications and membership ————————————————————————————

    /// Link a renewed certificate to its predecessor in both directions.
    ///
    /// # Errors
    ///
    /// Returns an error when either certificate is missing from the
    /// organization or the transaction fails.
    pub async fn insert_renewal_link(
        &self,
        organization_id: &str,
        predecessor_id: &str,
        successor_id: &str,
    ) -> anyhow::Result<()> {
        if predecessor_id == successor_id {
            anyhow::bail!("a certificate cannot renew itself");
        }
        let now = now_rfc3339();
        let mut transaction = self.pool.begin().await?;
        let forward = sqlx::query(
            "UPDATE issued_certificates SET renewed_by_id = ?, version = version + 1, updated_at = ? \
             WHERE organization_id = ? AND id = ?",
        )
        .bind(successor_id)
        .bind(&now)
        .bind(organization_id)
        .bind(predecessor_id)
        .execute(&mut *transaction)
        .await?;
        let backward = sqlx::query(
            "UPDATE issued_certificates SET renewed_from_id = ?, version = version + 1, updated_at = ? \
             WHERE organization_id = ? AND id = ?",
        )
        .bind(predecessor_id)
        .bind(&now)
        .bind(organization_id)
        .bind(successor_id)
        .execute(&mut *transaction)
        .await?;
        if forward.rows_affected() != 1 || backward.rows_affected() != 1 {
            transaction.rollback().await?;
            anyhow::bail!("renewal link requires both certificates in this organization");
        }
        transaction.commit().await?;
        Ok(())
    }

    // —— revocation and CRL state ——————————————————————————————————

    /// Access records that are still usable for a signer right now.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn list_active_records(
        &self,
        organization_id: &str,
        signer_id: &str,
    ) -> anyhow::Result<Vec<StoredSigningAccessRecord>> {
        let rows = sqlx::query(
            "SELECT * FROM signing_access_records \
             WHERE organization_id = ? AND signer_id = ? AND status = 'active' \
               AND (window_expires_at IS NULL OR julianday(window_expires_at) > julianday(?)) \
             ORDER BY created_at, id",
        )
        .bind(organization_id)
        .bind(signer_id)
        .bind(now_rfc3339())
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.iter().map(stored_signing_access_record).collect())
    }
}
