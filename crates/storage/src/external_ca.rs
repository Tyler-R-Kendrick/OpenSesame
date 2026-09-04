//! HSM connectors and external CA configuration.
//!
//! Split out of the single `impl Db` block in `lib.rs`, which had grown to
//! 215 methods across 5,292 lines. Rust spreads a type's inherent impl over
//! any number of modules in the same crate, so this is a pure move: no
//! signature, visibility or call site changes.

use super::{
    now_rfc3339, sealed_parts, stored_external_ca_config, stored_hsm_connector,
    validate_json_document, validate_optional_sealed_material, Db, StoredExternalCaConfig,
    StoredHsmConnector,
};

impl Db {
    /// # Errors
    ///
    /// Returns an error when the sealed PIN group is partially populated or the
    /// insert fails.
    pub async fn insert_hsm_connector(&self, connector: &StoredHsmConnector) -> anyhow::Result<()> {
        validate_optional_sealed_material(connector.sealed_pin.as_ref())?;
        self.ensure_organization_row(&connector.organization_id, &connector.created_at)
            .await?;
        let (key_id, ciphertext, nonce, aad_digest) = sealed_parts(connector.sealed_pin.as_ref());
        sqlx::query(
            "INSERT INTO hsm_connectors (id, organization_id, label, sealed_pin_key_id, sealed_pin_ciphertext, sealed_pin_nonce, sealed_pin_aad_digest, module_hint, key_label_prefix, gateway_ref, status, version, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&connector.id)
        .bind(&connector.organization_id)
        .bind(&connector.label)
        .bind(key_id)
        .bind(ciphertext)
        .bind(nonce)
        .bind(aad_digest)
        .bind(&connector.module_hint)
        .bind(&connector.key_label_prefix)
        .bind(&connector.gateway_ref)
        .bind(&connector.status)
        .bind(connector.version)
        .bind(&connector.created_at)
        .bind(&connector.updated_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// # Errors
    ///
    /// Returns an error when the lookup fails.
    pub async fn get_hsm_connector(
        &self,
        organization_id: &str,
        connector_id: &str,
    ) -> anyhow::Result<Option<StoredHsmConnector>> {
        let row = sqlx::query("SELECT * FROM hsm_connectors WHERE organization_id = ? AND id = ?")
            .bind(organization_id)
            .bind(connector_id)
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.as_ref().map(stored_hsm_connector))
    }

    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn list_hsm_connectors(
        &self,
        organization_id: &str,
    ) -> anyhow::Result<Vec<StoredHsmConnector>> {
        let rows = sqlx::query(
            "SELECT * FROM hsm_connectors WHERE organization_id = ? ORDER BY label, id",
        )
        .bind(organization_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.iter().map(stored_hsm_connector).collect())
    }

    /// # Errors
    ///
    /// Returns an error when validation or the update fails.
    pub async fn update_hsm_connector(
        &self,
        connector: &StoredHsmConnector,
    ) -> anyhow::Result<bool> {
        validate_optional_sealed_material(connector.sealed_pin.as_ref())?;
        let (key_id, ciphertext, nonce, aad_digest) = sealed_parts(connector.sealed_pin.as_ref());
        let result = sqlx::query(
            "UPDATE hsm_connectors SET label = ?, sealed_pin_key_id = ?, sealed_pin_ciphertext = ?, sealed_pin_nonce = ?, sealed_pin_aad_digest = ?, module_hint = ?, key_label_prefix = ?, gateway_ref = ?, status = ?, version = version + 1, updated_at = ? \
             WHERE organization_id = ? AND id = ? AND version = ?",
        )
        .bind(&connector.label)
        .bind(key_id)
        .bind(ciphertext)
        .bind(nonce)
        .bind(aad_digest)
        .bind(&connector.module_hint)
        .bind(&connector.key_label_prefix)
        .bind(&connector.gateway_ref)
        .bind(&connector.status)
        .bind(now_rfc3339())
        .bind(&connector.organization_id)
        .bind(&connector.id)
        .bind(connector.version)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    /// # Errors
    ///
    /// Returns an error when the deletion fails.
    pub async fn delete_hsm_connector(
        &self,
        organization_id: &str,
        connector_id: &str,
    ) -> anyhow::Result<bool> {
        let result = sqlx::query("DELETE FROM hsm_connectors WHERE organization_id = ? AND id = ?")
            .bind(organization_id)
            .bind(connector_id)
            .execute(&self.pool)
            .await?;
        Ok(result.rows_affected() == 1)
    }

    // —— external certificate authorities ——————————————————————————

    /// # Errors
    ///
    /// Returns an error when `config_json` is malformed or the insert fails.
    pub async fn insert_external_ca_config(
        &self,
        config: &StoredExternalCaConfig,
    ) -> anyhow::Result<()> {
        validate_json_document(&config.config_json, "external CA configuration")?;
        self.ensure_organization_row(&config.organization_id, &config.created_at)
            .await?;
        sqlx::query(
            "INSERT INTO external_ca_configs (id, organization_id, kind, connection_id, config_json, trust_class, auto_renew, renew_before_seconds, version, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&config.id)
        .bind(&config.organization_id)
        .bind(&config.kind)
        .bind(&config.connection_id)
        .bind(&config.config_json)
        .bind(&config.trust_class)
        .bind(i64::from(config.auto_renew))
        .bind(config.renew_before_seconds)
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
    pub async fn get_external_ca_config(
        &self,
        organization_id: &str,
        config_id: &str,
    ) -> anyhow::Result<Option<StoredExternalCaConfig>> {
        let row =
            sqlx::query("SELECT * FROM external_ca_configs WHERE organization_id = ? AND id = ?")
                .bind(organization_id)
                .bind(config_id)
                .fetch_optional(&self.pool)
                .await?;
        Ok(row.as_ref().map(stored_external_ca_config))
    }

    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn list_external_ca_configs(
        &self,
        organization_id: &str,
    ) -> anyhow::Result<Vec<StoredExternalCaConfig>> {
        let rows = sqlx::query(
            "SELECT * FROM external_ca_configs WHERE organization_id = ? ORDER BY kind, id",
        )
        .bind(organization_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.iter().map(stored_external_ca_config).collect())
    }

    /// # Errors
    ///
    /// Returns an error when validation or the update fails.
    pub async fn update_external_ca_config(
        &self,
        config: &StoredExternalCaConfig,
    ) -> anyhow::Result<bool> {
        validate_json_document(&config.config_json, "external CA configuration")?;
        let result = sqlx::query(
            "UPDATE external_ca_configs SET connection_id = ?, config_json = ?, trust_class = ?, auto_renew = ?, renew_before_seconds = ?, version = version + 1, updated_at = ? \
             WHERE organization_id = ? AND id = ? AND version = ?",
        )
        .bind(&config.connection_id)
        .bind(&config.config_json)
        .bind(&config.trust_class)
        .bind(i64::from(config.auto_renew))
        .bind(config.renew_before_seconds)
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
    pub async fn delete_external_ca_config(
        &self,
        organization_id: &str,
        config_id: &str,
    ) -> anyhow::Result<bool> {
        let result =
            sqlx::query("DELETE FROM external_ca_configs WHERE organization_id = ? AND id = ?")
                .bind(organization_id)
                .bind(config_id)
                .execute(&self.pool)
                .await?;
        Ok(result.rows_affected() == 1)
    }

    // —— ACME server state ————————————————————————————————————————
}
