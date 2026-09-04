//! EST and SCEP enrolment configuration and challenge persistence.
//!
//! Split out of the single `impl Db` block in `lib.rs`, which had grown to
//! 215 methods across 5,292 lines. Rust spreads a type's inherent impl over
//! any number of modules in the same crate, so this is a pure move: no
//! signature, visibility or call site changes.

use super::{
    now_rfc3339, sealed_parts, validate_optional_sealed_material, Db, Row,
    SealedCertificateMaterial, SqliteRow, StoredEstConfig, StoredScepChallenge, StoredScepConfig,
};

impl Db {
    /// # Errors
    ///
    /// Returns an error when the sealed passphrase group is partially populated
    /// or the insert fails.
    pub async fn insert_est_config(&self, config: &StoredEstConfig) -> anyhow::Result<()> {
        validate_optional_sealed_material(config.sealed_passphrase.as_ref())?;
        let (key_id, ciphertext, nonce, aad_digest) =
            sealed_parts(config.sealed_passphrase.as_ref());
        sqlx::query(
            "INSERT INTO est_configs (id, organization_id, profile_id, sealed_passphrase_key_id, sealed_passphrase_ciphertext, sealed_passphrase_nonce, sealed_passphrase_aad_digest, bootstrap_chain_pem, require_bootstrap, version, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&config.id)
        .bind(&config.organization_id)
        .bind(&config.profile_id)
        .bind(key_id)
        .bind(ciphertext)
        .bind(nonce)
        .bind(aad_digest)
        .bind(&config.bootstrap_chain_pem)
        .bind(i64::from(config.require_bootstrap))
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
    pub async fn get_est_config(
        &self,
        organization_id: &str,
        profile_id: &str,
    ) -> anyhow::Result<Option<StoredEstConfig>> {
        let row =
            sqlx::query("SELECT * FROM est_configs WHERE organization_id = ? AND profile_id = ?")
                .bind(organization_id)
                .bind(profile_id)
                .fetch_optional(&self.pool)
                .await?;
        Ok(row.as_ref().map(stored_est_config))
    }

    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn list_est_configs(
        &self,
        organization_id: &str,
    ) -> anyhow::Result<Vec<StoredEstConfig>> {
        let rows = sqlx::query(
            "SELECT * FROM est_configs WHERE organization_id = ? ORDER BY profile_id, id",
        )
        .bind(organization_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.iter().map(stored_est_config).collect())
    }

    /// # Errors
    ///
    /// Returns an error when validation or the update fails.
    pub async fn update_est_config(&self, config: &StoredEstConfig) -> anyhow::Result<bool> {
        validate_optional_sealed_material(config.sealed_passphrase.as_ref())?;
        let (key_id, ciphertext, nonce, aad_digest) =
            sealed_parts(config.sealed_passphrase.as_ref());
        let result = sqlx::query(
            "UPDATE est_configs SET sealed_passphrase_key_id = ?, sealed_passphrase_ciphertext = ?, sealed_passphrase_nonce = ?, sealed_passphrase_aad_digest = ?, bootstrap_chain_pem = ?, require_bootstrap = ?, version = version + 1, updated_at = ? \
             WHERE organization_id = ? AND id = ? AND version = ?",
        )
        .bind(key_id)
        .bind(ciphertext)
        .bind(nonce)
        .bind(aad_digest)
        .bind(&config.bootstrap_chain_pem)
        .bind(i64::from(config.require_bootstrap))
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
    pub async fn delete_est_config(
        &self,
        organization_id: &str,
        config_id: &str,
    ) -> anyhow::Result<bool> {
        let result = sqlx::query("DELETE FROM est_configs WHERE organization_id = ? AND id = ?")
            .bind(organization_id)
            .bind(config_id)
            .execute(&self.pool)
            .await?;
        Ok(result.rows_affected() == 1)
    }

    /// # Errors
    ///
    /// Returns an error when the sealed challenge group is partially populated
    /// or the insert fails.
    pub async fn insert_scep_config(&self, config: &StoredScepConfig) -> anyhow::Result<()> {
        validate_optional_sealed_material(config.sealed_static_secret.as_ref())?;
        let (key_id, ciphertext, nonce, aad_digest) =
            sealed_parts(config.sealed_static_secret.as_ref());
        sqlx::query(
            "INSERT INTO scep_configs (id, organization_id, profile_id, challenge_mode, sealed_static_secret_key_id, sealed_static_secret_ciphertext, sealed_static_secret_nonce, sealed_static_secret_aad_digest, ra_signs_with_ca, include_ca_cert, allow_cert_renewal, version, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&config.id)
        .bind(&config.organization_id)
        .bind(&config.profile_id)
        .bind(&config.challenge_mode)
        .bind(key_id)
        .bind(ciphertext)
        .bind(nonce)
        .bind(aad_digest)
        .bind(i64::from(config.ra_signs_with_ca))
        .bind(i64::from(config.include_ca_cert))
        .bind(i64::from(config.allow_cert_renewal))
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
    pub async fn get_scep_config(
        &self,
        organization_id: &str,
        profile_id: &str,
    ) -> anyhow::Result<Option<StoredScepConfig>> {
        let row =
            sqlx::query("SELECT * FROM scep_configs WHERE organization_id = ? AND profile_id = ?")
                .bind(organization_id)
                .bind(profile_id)
                .fetch_optional(&self.pool)
                .await?;
        Ok(row.as_ref().map(stored_scep_config))
    }

    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn list_scep_configs(
        &self,
        organization_id: &str,
    ) -> anyhow::Result<Vec<StoredScepConfig>> {
        let rows = sqlx::query(
            "SELECT * FROM scep_configs WHERE organization_id = ? ORDER BY profile_id, id",
        )
        .bind(organization_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.iter().map(stored_scep_config).collect())
    }

    /// # Errors
    ///
    /// Returns an error when validation or the update fails.
    pub async fn update_scep_config(&self, config: &StoredScepConfig) -> anyhow::Result<bool> {
        validate_optional_sealed_material(config.sealed_static_secret.as_ref())?;
        let (key_id, ciphertext, nonce, aad_digest) =
            sealed_parts(config.sealed_static_secret.as_ref());
        let result = sqlx::query(
            "UPDATE scep_configs SET challenge_mode = ?, sealed_static_secret_key_id = ?, sealed_static_secret_ciphertext = ?, sealed_static_secret_nonce = ?, sealed_static_secret_aad_digest = ?, ra_signs_with_ca = ?, include_ca_cert = ?, allow_cert_renewal = ?, version = version + 1, updated_at = ? \
             WHERE organization_id = ? AND id = ? AND version = ?",
        )
        .bind(&config.challenge_mode)
        .bind(key_id)
        .bind(ciphertext)
        .bind(nonce)
        .bind(aad_digest)
        .bind(i64::from(config.ra_signs_with_ca))
        .bind(i64::from(config.include_ca_cert))
        .bind(i64::from(config.allow_cert_renewal))
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
    pub async fn delete_scep_config(
        &self,
        organization_id: &str,
        config_id: &str,
    ) -> anyhow::Result<bool> {
        let result = sqlx::query("DELETE FROM scep_configs WHERE organization_id = ? AND id = ?")
            .bind(organization_id)
            .bind(config_id)
            .execute(&self.pool)
            .await?;
        Ok(result.rows_affected() == 1)
    }

    /// Record a one-time SCEP challenge by hash and return its row id. The
    /// plaintext challenge is never persisted.
    ///
    /// # Errors
    ///
    /// Returns an error when the insert fails.
    pub async fn mint_scep_challenge(
        &self,
        organization_id: &str,
        config_id: &str,
        challenge_hash: &str,
        expires_at: &str,
    ) -> anyhow::Result<String> {
        let id = uuid::Uuid::new_v4().to_string();
        let now = now_rfc3339();
        sqlx::query(
            "INSERT INTO scep_challenges (id, organization_id, config_id, challenge_hash, expires_at, consumed_at, version, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, NULL, 1, ?, ?)",
        )
        .bind(&id)
        .bind(organization_id)
        .bind(config_id)
        .bind(challenge_hash)
        .bind(expires_at)
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await?;
        Ok(id)
    }

    /// Burn a SCEP challenge. The conditional update is the claim, so exactly
    /// one racing enrollment wins and a replay is rejected.
    ///
    /// # Errors
    ///
    /// Returns an error when the challenge is unknown, expired, or already
    /// consumed.
    pub async fn consume_scep_challenge(
        &self,
        organization_id: &str,
        config_id: &str,
        challenge_hash: &str,
    ) -> anyhow::Result<()> {
        let now = now_rfc3339();
        let result = sqlx::query(
            "UPDATE scep_challenges SET consumed_at = ?, version = version + 1, updated_at = ? \
             WHERE organization_id = ? AND config_id = ? AND challenge_hash = ? \
               AND consumed_at IS NULL AND julianday(expires_at) > julianday(?)",
        )
        .bind(&now)
        .bind(&now)
        .bind(organization_id)
        .bind(config_id)
        .bind(challenge_hash)
        .bind(&now)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() != 1 {
            anyhow::bail!("SCEP challenge is unknown, expired, or already consumed");
        }
        Ok(())
    }

    /// # Errors
    ///
    /// Returns an error when the lookup fails.
    pub async fn get_scep_challenge(
        &self,
        organization_id: &str,
        challenge_id: &str,
    ) -> anyhow::Result<Option<StoredScepChallenge>> {
        let row = sqlx::query("SELECT * FROM scep_challenges WHERE organization_id = ? AND id = ?")
            .bind(organization_id)
            .bind(challenge_id)
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.as_ref().map(stored_scep_challenge))
    }
}

// Row mappers for this module's tables -- private to their only caller.
fn stored_est_config(row: &SqliteRow) -> StoredEstConfig {
    StoredEstConfig {
        id: row.get("id"),
        organization_id: row.get("organization_id"),
        profile_id: row.get("profile_id"),
        sealed_passphrase: optional_sealed_material!(row, "sealed_passphrase"),
        bootstrap_chain_pem: row.get("bootstrap_chain_pem"),
        require_bootstrap: row.get::<i64, _>("require_bootstrap") != 0,
        version: row.get("version"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }
}

fn stored_scep_config(row: &SqliteRow) -> StoredScepConfig {
    StoredScepConfig {
        id: row.get("id"),
        organization_id: row.get("organization_id"),
        profile_id: row.get("profile_id"),
        challenge_mode: row.get("challenge_mode"),
        sealed_static_secret: optional_sealed_material!(row, "sealed_static_secret"),
        ra_signs_with_ca: row.get::<i64, _>("ra_signs_with_ca") != 0,
        include_ca_cert: row.get::<i64, _>("include_ca_cert") != 0,
        allow_cert_renewal: row.get::<i64, _>("allow_cert_renewal") != 0,
        version: row.get("version"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }
}

fn stored_scep_challenge(row: &SqliteRow) -> StoredScepChallenge {
    StoredScepChallenge {
        id: row.get("id"),
        organization_id: row.get("organization_id"),
        config_id: row.get("config_id"),
        challenge_hash: row.get("challenge_hash"),
        expires_at: row.get("expires_at"),
        consumed_at: row.get("consumed_at"),
        version: row.get("version"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }
}
