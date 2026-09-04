//! Enrolment configuration and PKI application membership.
//!
//! Split out of the single `impl Db` block in `lib.rs`, which had grown to
//! 215 methods across 5,292 lines. Rust spreads a type's inherent impl over
//! any number of modules in the same crate, so this is a pure move: no
//! signature, visibility or call site changes.

use super::{
    now_rfc3339, sealed_parts, stored_enrollment_config, stored_pki_application,
    stored_pki_application_member, validate_json_document, validate_optional_sealed_material, Db,
    StoredEnrollmentConfig, StoredPkiApplication, StoredPkiApplicationMember,
};

impl Db {
    /// # Errors
    ///
    /// Returns an error when the insert violates a database constraint.
    pub async fn insert_pki_application(
        &self,
        application: &StoredPkiApplication,
    ) -> anyhow::Result<()> {
        self.ensure_organization_row(&application.organization_id, &application.created_at)
            .await?;
        sqlx::query(
            "INSERT INTO pki_applications (id, organization_id, slug, display_name, description, version, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&application.id)
        .bind(&application.organization_id)
        .bind(&application.slug)
        .bind(&application.display_name)
        .bind(&application.description)
        .bind(application.version)
        .bind(&application.created_at)
        .bind(&application.updated_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// # Errors
    ///
    /// Returns an error when the lookup fails.
    pub async fn get_pki_application(
        &self,
        organization_id: &str,
        application_id: &str,
    ) -> anyhow::Result<Option<StoredPkiApplication>> {
        let row =
            sqlx::query("SELECT * FROM pki_applications WHERE organization_id = ? AND id = ?")
                .bind(organization_id)
                .bind(application_id)
                .fetch_optional(&self.pool)
                .await?;
        Ok(row.as_ref().map(stored_pki_application))
    }

    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn list_pki_applications(
        &self,
        organization_id: &str,
    ) -> anyhow::Result<Vec<StoredPkiApplication>> {
        let rows = sqlx::query(
            "SELECT * FROM pki_applications WHERE organization_id = ? ORDER BY slug, id",
        )
        .bind(organization_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.iter().map(stored_pki_application).collect())
    }

    /// # Errors
    ///
    /// Returns an error when the update fails.
    pub async fn update_pki_application(
        &self,
        application: &StoredPkiApplication,
    ) -> anyhow::Result<bool> {
        let result = sqlx::query(
            "UPDATE pki_applications SET slug = ?, display_name = ?, description = ?, version = version + 1, updated_at = ? \
             WHERE organization_id = ? AND id = ? AND version = ?",
        )
        .bind(&application.slug)
        .bind(&application.display_name)
        .bind(&application.description)
        .bind(now_rfc3339())
        .bind(&application.organization_id)
        .bind(&application.id)
        .bind(application.version)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    /// # Errors
    ///
    /// Returns an error when the deletion fails.
    pub async fn delete_pki_application(
        &self,
        organization_id: &str,
        application_id: &str,
    ) -> anyhow::Result<bool> {
        let result =
            sqlx::query("DELETE FROM pki_applications WHERE organization_id = ? AND id = ?")
                .bind(organization_id)
                .bind(application_id)
                .execute(&self.pool)
                .await?;
        Ok(result.rows_affected() == 1)
    }

    /// Insert or re-grade one application membership.
    ///
    /// # Errors
    ///
    /// Returns an error when the application is absent from the organization or
    /// the upsert fails.
    pub async fn upsert_application_member(
        &self,
        member: &StoredPkiApplicationMember,
    ) -> anyhow::Result<()> {
        sqlx::query(
            "INSERT INTO pki_application_members (id, organization_id, application_id, subject, role, version, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?) \
             ON CONFLICT(organization_id, application_id, subject) \
             DO UPDATE SET role = excluded.role, version = pki_application_members.version + 1, updated_at = excluded.updated_at",
        )
        .bind(&member.id)
        .bind(&member.organization_id)
        .bind(&member.application_id)
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
    pub async fn list_application_members(
        &self,
        organization_id: &str,
        application_id: &str,
    ) -> anyhow::Result<Vec<StoredPkiApplicationMember>> {
        let rows = sqlx::query(
            "SELECT * FROM pki_application_members WHERE organization_id = ? AND application_id = ? ORDER BY subject",
        )
        .bind(organization_id)
        .bind(application_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.iter().map(stored_pki_application_member).collect())
    }

    /// # Errors
    ///
    /// Returns an error when the deletion fails.
    pub async fn remove_application_member(
        &self,
        organization_id: &str,
        application_id: &str,
        subject: &str,
    ) -> anyhow::Result<bool> {
        let result = sqlx::query(
            "DELETE FROM pki_application_members WHERE organization_id = ? AND application_id = ? AND subject = ?",
        )
        .bind(organization_id)
        .bind(application_id)
        .bind(subject)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    /// # Errors
    ///
    /// Returns an error when `config_json` is not JSON, the sealed secret is
    /// partially populated, or the insert fails.
    pub async fn insert_enrollment_config(
        &self,
        config: &StoredEnrollmentConfig,
    ) -> anyhow::Result<()> {
        validate_json_document(&config.config_json, "enrollment configuration")?;
        validate_optional_sealed_material(config.sealed_secret.as_ref())?;
        let (key_id, ciphertext, nonce, aad_digest) = sealed_parts(config.sealed_secret.as_ref());
        sqlx::query(
            "INSERT INTO enrollment_configs (id, organization_id, application_id, profile_id, method, enabled, config_json, auto_renew_enabled, renew_before_seconds, sealed_secret_key_id, sealed_secret_ciphertext, sealed_secret_nonce, sealed_secret_aad_digest, version, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&config.id)
        .bind(&config.organization_id)
        .bind(&config.application_id)
        .bind(&config.profile_id)
        .bind(&config.method)
        .bind(i64::from(config.enabled))
        .bind(&config.config_json)
        .bind(i64::from(config.auto_renew_enabled))
        .bind(config.renew_before_seconds)
        .bind(key_id)
        .bind(ciphertext)
        .bind(nonce)
        .bind(aad_digest)
        .bind(config.version)
        .bind(&config.created_at)
        .bind(&config.updated_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// # Errors
    ///
    /// Returns an error when the lookup fails.
    pub async fn get_enrollment_config(
        &self,
        organization_id: &str,
        enrollment_id: &str,
    ) -> anyhow::Result<Option<StoredEnrollmentConfig>> {
        let row =
            sqlx::query("SELECT * FROM enrollment_configs WHERE organization_id = ? AND id = ?")
                .bind(organization_id)
                .bind(enrollment_id)
                .fetch_optional(&self.pool)
                .await?;
        Ok(row.as_ref().map(stored_enrollment_config))
    }

    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn list_enrollment_configs(
        &self,
        organization_id: &str,
        application_id: &str,
    ) -> anyhow::Result<Vec<StoredEnrollmentConfig>> {
        let rows = sqlx::query(
            "SELECT * FROM enrollment_configs WHERE organization_id = ? AND application_id = ? ORDER BY method, id",
        )
        .bind(organization_id)
        .bind(application_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.iter().map(stored_enrollment_config).collect())
    }

    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn get_enrollment_by_profile_method(
        &self,
        organization_id: &str,
        profile_id: &str,
        method: &str,
    ) -> anyhow::Result<Option<StoredEnrollmentConfig>> {
        let row = sqlx::query(
            "SELECT * FROM enrollment_configs WHERE organization_id = ? AND profile_id = ? AND method = ? AND enabled = 1",
        )
        .bind(organization_id)
        .bind(profile_id)
        .bind(method)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.as_ref().map(stored_enrollment_config))
    }

    /// # Errors
    ///
    /// Returns an error when validation or the update fails.
    pub async fn update_enrollment_config(
        &self,
        config: &StoredEnrollmentConfig,
    ) -> anyhow::Result<bool> {
        validate_json_document(&config.config_json, "enrollment configuration")?;
        validate_optional_sealed_material(config.sealed_secret.as_ref())?;
        let (key_id, ciphertext, nonce, aad_digest) = sealed_parts(config.sealed_secret.as_ref());
        let result = sqlx::query(
            "UPDATE enrollment_configs SET enabled = ?, config_json = ?, auto_renew_enabled = ?, renew_before_seconds = ?, sealed_secret_key_id = ?, sealed_secret_ciphertext = ?, sealed_secret_nonce = ?, sealed_secret_aad_digest = ?, version = version + 1, updated_at = ? \
             WHERE organization_id = ? AND id = ? AND version = ?",
        )
        .bind(i64::from(config.enabled))
        .bind(&config.config_json)
        .bind(i64::from(config.auto_renew_enabled))
        .bind(config.renew_before_seconds)
        .bind(key_id)
        .bind(ciphertext)
        .bind(nonce)
        .bind(aad_digest)
        .bind(now_rfc3339())
        .bind(&config.organization_id)
        .bind(&config.id)
        .bind(config.version)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    /// # Errors
    ///
    /// Returns an error when the deletion fails.
    pub async fn delete_enrollment_config(
        &self,
        organization_id: &str,
        enrollment_id: &str,
    ) -> anyhow::Result<bool> {
        let result =
            sqlx::query("DELETE FROM enrollment_configs WHERE organization_id = ? AND id = ?")
                .bind(organization_id)
                .bind(enrollment_id)
                .execute(&self.pool)
                .await?;
        Ok(result.rows_affected() == 1)
    }

    // —— managed certificate inventory ——————————————————————————————
}
