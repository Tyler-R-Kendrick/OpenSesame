//! Certificate policies, profiles and CA signing configuration.
//!
//! Split out of the single `impl Db` block in `lib.rs`, which had grown to
//! 215 methods across 5,292 lines. Rust spreads a type's inherent impl over
//! any number of modules in the same crate, so this is a pure move: no
//! signature, visibility or call site changes.

use super::{
    now_rfc3339, stored_certificate_policy, stored_certificate_profile, validate_json_document, Db,
    StoredCertificatePolicy, StoredCertificateProfile,
};

impl Db {
    /// Persist a certificate policy.
    ///
    /// # Errors
    ///
    /// Returns an error when `rules_json` is not JSON or the insert violates a
    /// database constraint.
    pub async fn insert_certificate_policy(
        &self,
        policy: &StoredCertificatePolicy,
    ) -> anyhow::Result<()> {
        validate_json_document(&policy.rules_json, "certificate policy rules")?;
        self.ensure_organization_row(&policy.organization_id, &policy.created_at)
            .await?;
        sqlx::query(
            "INSERT INTO certificate_policies (id, organization_id, name, description, preset, max_validity_seconds, rules_json, version, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&policy.id)
        .bind(&policy.organization_id)
        .bind(&policy.name)
        .bind(&policy.description)
        .bind(&policy.preset)
        .bind(policy.max_validity_seconds)
        .bind(&policy.rules_json)
        .bind(policy.version)
        .bind(&policy.created_at)
        .bind(&policy.updated_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// # Errors
    ///
    /// Returns an error when the lookup fails.
    pub async fn get_certificate_policy(
        &self,
        organization_id: &str,
        policy_id: &str,
    ) -> anyhow::Result<Option<StoredCertificatePolicy>> {
        let row =
            sqlx::query("SELECT * FROM certificate_policies WHERE organization_id = ? AND id = ?")
                .bind(organization_id)
                .bind(policy_id)
                .fetch_optional(&self.pool)
                .await?;
        Ok(row.as_ref().map(stored_certificate_policy))
    }

    /// Compare-and-swap update; `policy.version` is the version the caller read.
    ///
    /// # Errors
    ///
    /// Returns an error when `rules_json` is not JSON or the update fails.
    pub async fn update_certificate_policy(
        &self,
        policy: &StoredCertificatePolicy,
    ) -> anyhow::Result<bool> {
        validate_json_document(&policy.rules_json, "certificate policy rules")?;
        let result = sqlx::query(
            "UPDATE certificate_policies SET name = ?, description = ?, preset = ?, max_validity_seconds = ?, rules_json = ?, version = version + 1, updated_at = ? \
             WHERE organization_id = ? AND id = ? AND version = ?",
        )
        .bind(&policy.name)
        .bind(&policy.description)
        .bind(&policy.preset)
        .bind(policy.max_validity_seconds)
        .bind(&policy.rules_json)
        .bind(now_rfc3339())
        .bind(&policy.organization_id)
        .bind(&policy.id)
        .bind(policy.version)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    /// # Errors
    ///
    /// Returns an error when the deletion fails or a profile still references
    /// the policy.
    pub async fn delete_certificate_policy(
        &self,
        organization_id: &str,
        policy_id: &str,
    ) -> anyhow::Result<bool> {
        let result =
            sqlx::query("DELETE FROM certificate_policies WHERE organization_id = ? AND id = ?")
                .bind(organization_id)
                .bind(policy_id)
                .execute(&self.pool)
                .await?;
        Ok(result.rows_affected() == 1)
    }

    // —— certificate profiles ——————————————————————————————————————

    /// # Errors
    ///
    /// Returns an error when `defaults_json` is not JSON or the insert fails.
    pub async fn insert_certificate_profile(
        &self,
        profile: &StoredCertificateProfile,
    ) -> anyhow::Result<()> {
        validate_json_document(&profile.defaults_json, "certificate profile defaults")?;
        self.ensure_organization_row(&profile.organization_id, &profile.created_at)
            .await?;
        sqlx::query(
            "INSERT INTO certificate_profiles (id, organization_id, name, issuer_type, certificate_authority_id, policy_id, defaults_json, external_template, version, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&profile.id)
        .bind(&profile.organization_id)
        .bind(&profile.name)
        .bind(&profile.issuer_type)
        .bind(&profile.certificate_authority_id)
        .bind(&profile.policy_id)
        .bind(&profile.defaults_json)
        .bind(&profile.external_template)
        .bind(profile.version)
        .bind(&profile.created_at)
        .bind(&profile.updated_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// # Errors
    ///
    /// Returns an error when the lookup fails.
    pub async fn get_certificate_profile(
        &self,
        organization_id: &str,
        profile_id: &str,
    ) -> anyhow::Result<Option<StoredCertificateProfile>> {
        let row =
            sqlx::query("SELECT * FROM certificate_profiles WHERE organization_id = ? AND id = ?")
                .bind(organization_id)
                .bind(profile_id)
                .fetch_optional(&self.pool)
                .await?;
        Ok(row.as_ref().map(stored_certificate_profile))
    }

    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn list_certificate_profiles(
        &self,
        organization_id: &str,
    ) -> anyhow::Result<Vec<StoredCertificateProfile>> {
        let rows = sqlx::query(
            "SELECT * FROM certificate_profiles WHERE organization_id = ? ORDER BY name, id",
        )
        .bind(organization_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.iter().map(stored_certificate_profile).collect())
    }

    /// # Errors
    ///
    /// Returns an error when `defaults_json` is not JSON or the update fails.
    pub async fn update_certificate_profile(
        &self,
        profile: &StoredCertificateProfile,
    ) -> anyhow::Result<bool> {
        validate_json_document(&profile.defaults_json, "certificate profile defaults")?;
        let result = sqlx::query(
            "UPDATE certificate_profiles SET name = ?, issuer_type = ?, certificate_authority_id = ?, policy_id = ?, defaults_json = ?, external_template = ?, version = version + 1, updated_at = ? \
             WHERE organization_id = ? AND id = ? AND version = ?",
        )
        .bind(&profile.name)
        .bind(&profile.issuer_type)
        .bind(&profile.certificate_authority_id)
        .bind(&profile.policy_id)
        .bind(&profile.defaults_json)
        .bind(&profile.external_template)
        .bind(now_rfc3339())
        .bind(&profile.organization_id)
        .bind(&profile.id)
        .bind(profile.version)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    /// # Errors
    ///
    /// Returns an error when the deletion fails.
    pub async fn delete_certificate_profile(
        &self,
        organization_id: &str,
        profile_id: &str,
    ) -> anyhow::Result<bool> {
        let result =
            sqlx::query("DELETE FROM certificate_profiles WHERE organization_id = ? AND id = ?")
                .bind(organization_id)
                .bind(profile_id)
                .execute(&self.pool)
                .await?;
        Ok(result.rows_affected() == 1)
    }

    // —— certificate authority hierarchy ————————————————————————————

    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn list_certificate_policies(
        &self,
        organization_id: &str,
    ) -> anyhow::Result<Vec<StoredCertificatePolicy>> {
        let rows = sqlx::query(
            "SELECT * FROM certificate_policies WHERE organization_id = ? ORDER BY name, id",
        )
        .bind(organization_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.iter().map(stored_certificate_policy).collect())
    }
}
