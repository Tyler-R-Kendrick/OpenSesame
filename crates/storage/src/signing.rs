//! Signer identities, membership, access records and signing events.
//!
//! Split out of the single `impl Db` block in `lib.rs`, which had grown to
//! 215 methods across 5,292 lines. Rust spreads a type's inherent impl over
//! any number of modules in the same crate, so this is a pure move: no
//! signature, visibility or call site changes.

use super::{
    now_rfc3339, sealed_parts, stored_ca_signing_config, stored_signer, stored_signer_member,
    validate_json_document, validate_optional_sealed_material, Db, Role, Row,
    StoredCaSigningConfig, StoredSigner, StoredSignerMember,
};

impl Db {
    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn get_signing_config(
        &self,
        organization_id: &str,
        authority_id: &str,
    ) -> anyhow::Result<Option<StoredCaSigningConfig>> {
        let row = sqlx::query(
            "SELECT * FROM certificate_authorities WHERE organization_id = ? AND id = ?",
        )
        .bind(organization_id)
        .bind(authority_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.as_ref().map(stored_ca_signing_config))
    }

    /// Compare-and-swap the per-authority signing configuration.
    ///
    /// # Errors
    ///
    /// Returns an error when the update fails.
    pub async fn update_signing_config(
        &self,
        config: &StoredCaSigningConfig,
    ) -> anyhow::Result<bool> {
        if let Some(mirrors) = &config.crl_mirrors_json {
            validate_json_document(mirrors, "certificate authority CRL mirrors")?;
        }
        let result = sqlx::query(
            "UPDATE certificate_authorities SET key_algorithm = ?, key_source = ?, hsm_connector_id = ?, hsm_key_label = ?, path_len = ?, crl_enabled = ?, crl_mirrors_json = ?, version = version + 1, updated_at = ? \
             WHERE organization_id = ? AND id = ? AND version = ?",
        )
        .bind(&config.key_algorithm)
        .bind(&config.key_source)
        .bind(&config.hsm_connector_id)
        .bind(&config.hsm_key_label)
        .bind(config.path_len)
        .bind(i64::from(config.crl_enabled))
        .bind(&config.crl_mirrors_json)
        .bind(now_rfc3339())
        .bind(&config.organization_id)
        .bind(&config.certificate_authority_id)
        .bind(config.version)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    /// # Errors
    ///
    /// Returns an error when the sealed key group is partially populated or the
    /// insert fails.
    pub async fn insert_signer(&self, signer: &StoredSigner) -> anyhow::Result<()> {
        validate_optional_sealed_material(signer.sealed_key.as_ref())?;
        self.ensure_organization_row(&signer.organization_id, &signer.created_at)
            .await?;
        let (key_id, ciphertext, nonce, aad_digest) = sealed_parts(signer.sealed_key.as_ref());
        sqlx::query(
            "INSERT INTO signers (id, organization_id, name, certificate_id, key_source, hsm_connector_id, hsm_key_label, status, auto_renew, renew_before_seconds, sealed_key_key_id, sealed_key_ciphertext, sealed_key_nonce, sealed_key_aad_digest, version, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&signer.id)
        .bind(&signer.organization_id)
        .bind(&signer.name)
        .bind(&signer.certificate_id)
        .bind(&signer.key_source)
        .bind(&signer.hsm_connector_id)
        .bind(&signer.hsm_key_label)
        .bind(&signer.status)
        .bind(i64::from(signer.auto_renew))
        .bind(signer.renew_before_seconds)
        .bind(key_id)
        .bind(ciphertext)
        .bind(nonce)
        .bind(aad_digest)
        .bind(signer.version)
        .bind(&signer.created_at)
        .bind(&signer.updated_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// # Errors
    ///
    /// Returns an error when the lookup fails.
    pub async fn get_signer(
        &self,
        organization_id: &str,
        signer_id: &str,
    ) -> anyhow::Result<Option<StoredSigner>> {
        let row = sqlx::query("SELECT * FROM signers WHERE organization_id = ? AND id = ?")
            .bind(organization_id)
            .bind(signer_id)
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.as_ref().map(stored_signer))
    }

    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn list_signers(&self, organization_id: &str) -> anyhow::Result<Vec<StoredSigner>> {
        let rows = sqlx::query("SELECT * FROM signers WHERE organization_id = ? ORDER BY name, id")
            .bind(organization_id)
            .fetch_all(&self.pool)
            .await?;
        Ok(rows.iter().map(stored_signer).collect())
    }

    /// # Errors
    ///
    /// Returns an error when validation or the update fails.
    pub async fn update_signer(&self, signer: &StoredSigner) -> anyhow::Result<bool> {
        validate_optional_sealed_material(signer.sealed_key.as_ref())?;
        let (key_id, ciphertext, nonce, aad_digest) = sealed_parts(signer.sealed_key.as_ref());
        let result = sqlx::query(
            "UPDATE signers SET name = ?, certificate_id = ?, key_source = ?, hsm_connector_id = ?, hsm_key_label = ?, status = ?, auto_renew = ?, renew_before_seconds = ?, sealed_key_key_id = ?, sealed_key_ciphertext = ?, sealed_key_nonce = ?, sealed_key_aad_digest = ?, version = version + 1, updated_at = ? \
             WHERE organization_id = ? AND id = ? AND version = ?",
        )
        .bind(&signer.name)
        .bind(&signer.certificate_id)
        .bind(&signer.key_source)
        .bind(&signer.hsm_connector_id)
        .bind(&signer.hsm_key_label)
        .bind(&signer.status)
        .bind(i64::from(signer.auto_renew))
        .bind(signer.renew_before_seconds)
        .bind(key_id)
        .bind(ciphertext)
        .bind(nonce)
        .bind(aad_digest)
        .bind(now_rfc3339())
        .bind(&signer.organization_id)
        .bind(&signer.id)
        .bind(signer.version)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    /// # Errors
    ///
    /// Returns an error when the deletion fails.
    pub async fn delete_signer(
        &self,
        organization_id: &str,
        signer_id: &str,
    ) -> anyhow::Result<bool> {
        let result = sqlx::query("DELETE FROM signers WHERE organization_id = ? AND id = ?")
            .bind(organization_id)
            .bind(signer_id)
            .execute(&self.pool)
            .await?;
        Ok(result.rows_affected() == 1)
    }

    /// # Errors
    ///
    /// Returns an error when the upsert fails.
    pub async fn upsert_signer_member(&self, member: &StoredSignerMember) -> anyhow::Result<()> {
        sqlx::query(
            "INSERT INTO signer_members (id, organization_id, signer_id, subject, role, version, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?) \
             ON CONFLICT(organization_id, signer_id, subject) \
             DO UPDATE SET role = excluded.role, version = signer_members.version + 1, updated_at = excluded.updated_at",
        )
        .bind(&member.id)
        .bind(&member.organization_id)
        .bind(&member.signer_id)
        .bind(&member.subject)
        .bind(&member.role)
        .bind(member.version)
        .bind(&member.created_at)
        .bind(&member.updated_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn list_signer_members(
        &self,
        organization_id: &str,
        signer_id: &str,
    ) -> anyhow::Result<Vec<StoredSignerMember>> {
        let rows = sqlx::query(
            "SELECT * FROM signer_members WHERE organization_id = ? AND signer_id = ? ORDER BY subject",
        )
        .bind(organization_id)
        .bind(signer_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.iter().map(stored_signer_member).collect())
    }

    /// # Errors
    ///
    /// Returns an error when the deletion fails.
    pub async fn remove_signer_member(
        &self,
        organization_id: &str,
        signer_id: &str,
        subject: &str,
    ) -> anyhow::Result<bool> {
        let result = sqlx::query(
            "DELETE FROM signer_members WHERE organization_id = ? AND signer_id = ? AND subject = ?",
        )
        .bind(organization_id)
        .bind(signer_id)
        .bind(subject)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    /// Resolve a subject's effective role on a signer.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn effective_signer_role(
        &self,
        organization_id: &str,
        signer_id: &str,
        subject: &str,
    ) -> anyhow::Result<Option<Role>> {
        let row = sqlx::query(
            "SELECT role FROM signer_members WHERE organization_id = ? AND signer_id = ? AND subject = ?",
        )
        .bind(organization_id)
        .bind(signer_id)
        .bind(subject)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.and_then(|row| Role::from_signer_str(&row.get::<String, _>("role"))))
    }

    // —— lifecycle alerting ————————————————————————————————————————
}
