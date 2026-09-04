//! ACME account, order and challenge persistence.
//!
//! Split out of the single `impl Db` block in `lib.rs`, which had grown to
//! 215 methods across 5,292 lines. Rust spreads a type's inherent impl over
//! any number of modules in the same crate, so this is a pure move: no
//! signature, visibility or call site changes.

use super::{
    now_rfc3339, validate_json_document, Db, Row, SqliteRow, StoredAcmeAccount,
    StoredAcmeChallenge, StoredAcmeOrder,
};

impl Db {
    /// # Errors
    ///
    /// Returns an error when `contacts_json` is malformed or the insert fails.
    pub async fn insert_acme_account(&self, account: &StoredAcmeAccount) -> anyhow::Result<()> {
        validate_json_document(&account.contacts_json, "ACME account contacts")?;
        sqlx::query(
            "INSERT INTO acme_server_accounts (id, organization_id, profile_id, jwk_thumbprint, eab_kid, status, contacts_json, version, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&account.id)
        .bind(&account.organization_id)
        .bind(&account.profile_id)
        .bind(&account.jwk_thumbprint)
        .bind(&account.eab_kid)
        .bind(&account.status)
        .bind(&account.contacts_json)
        .bind(account.version)
        .bind(&account.created_at)
        .bind(&account.updated_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// # Errors
    ///
    /// Returns an error when the lookup fails.
    pub async fn get_acme_account(
        &self,
        organization_id: &str,
        account_id: &str,
    ) -> anyhow::Result<Option<StoredAcmeAccount>> {
        let row =
            sqlx::query("SELECT * FROM acme_server_accounts WHERE organization_id = ? AND id = ?")
                .bind(organization_id)
                .bind(account_id)
                .fetch_optional(&self.pool)
                .await?;
        Ok(row.as_ref().map(stored_acme_account))
    }

    /// # Errors
    ///
    /// Returns an error when the lookup fails.
    pub async fn get_acme_account_by_thumbprint(
        &self,
        organization_id: &str,
        profile_id: &str,
        jwk_thumbprint: &str,
    ) -> anyhow::Result<Option<StoredAcmeAccount>> {
        let row = sqlx::query(
            "SELECT * FROM acme_server_accounts WHERE organization_id = ? AND profile_id = ? AND jwk_thumbprint = ?",
        )
        .bind(organization_id)
        .bind(profile_id)
        .bind(jwk_thumbprint)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.as_ref().map(stored_acme_account))
    }

    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn list_acme_accounts(
        &self,
        organization_id: &str,
        profile_id: &str,
    ) -> anyhow::Result<Vec<StoredAcmeAccount>> {
        let rows = sqlx::query(
            "SELECT * FROM acme_server_accounts WHERE organization_id = ? AND profile_id = ? ORDER BY created_at, id",
        )
        .bind(organization_id)
        .bind(profile_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.iter().map(stored_acme_account).collect())
    }

    /// # Errors
    ///
    /// Returns an error when the update fails.
    pub async fn update_acme_account_status(
        &self,
        organization_id: &str,
        account_id: &str,
        status: &str,
    ) -> anyhow::Result<bool> {
        let result = sqlx::query(
            "UPDATE acme_server_accounts SET status = ?, version = version + 1, updated_at = ? \
             WHERE organization_id = ? AND id = ?",
        )
        .bind(status)
        .bind(now_rfc3339())
        .bind(organization_id)
        .bind(account_id)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    /// # Errors
    ///
    /// Returns an error when `identifiers_json` is malformed or the insert
    /// fails.
    pub async fn insert_acme_order(&self, order: &StoredAcmeOrder) -> anyhow::Result<()> {
        validate_json_document(&order.identifiers_json, "ACME order identifiers")?;
        sqlx::query(
            "INSERT INTO acme_orders (id, organization_id, account_id, status, identifiers_json, expires_at, finalize_csr_pem, certificate_id, version, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&order.id)
        .bind(&order.organization_id)
        .bind(&order.account_id)
        .bind(&order.status)
        .bind(&order.identifiers_json)
        .bind(&order.expires_at)
        .bind(&order.finalize_csr_pem)
        .bind(&order.certificate_id)
        .bind(order.version)
        .bind(&order.created_at)
        .bind(&order.updated_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// # Errors
    ///
    /// Returns an error when the lookup fails.
    pub async fn get_acme_order(
        &self,
        organization_id: &str,
        order_id: &str,
    ) -> anyhow::Result<Option<StoredAcmeOrder>> {
        let row = sqlx::query("SELECT * FROM acme_orders WHERE organization_id = ? AND id = ?")
            .bind(organization_id)
            .bind(order_id)
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.as_ref().map(stored_acme_order))
    }

    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn list_acme_orders(
        &self,
        organization_id: &str,
        account_id: &str,
    ) -> anyhow::Result<Vec<StoredAcmeOrder>> {
        let rows = sqlx::query(
            "SELECT * FROM acme_orders WHERE organization_id = ? AND account_id = ? ORDER BY created_at, id",
        )
        .bind(organization_id)
        .bind(account_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.iter().map(stored_acme_order).collect())
    }

    /// Compare-and-set an order's RFC 8555 state.
    ///
    /// # Errors
    ///
    /// Returns an error when the order is absent or not in `from_status`.
    pub async fn transition_acme_order(
        &self,
        organization_id: &str,
        order_id: &str,
        from_status: &str,
        to_status: &str,
    ) -> anyhow::Result<()> {
        let result = sqlx::query(
            "UPDATE acme_orders SET status = ?, version = version + 1, updated_at = ? \
             WHERE organization_id = ? AND id = ? AND status = ?",
        )
        .bind(to_status)
        .bind(now_rfc3339())
        .bind(organization_id)
        .bind(order_id)
        .bind(from_status)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() != 1 {
            anyhow::bail!("ACME order is not in the expected state");
        }
        Ok(())
    }

    /// # Errors
    ///
    /// Returns an error when the insert fails.
    pub async fn insert_acme_challenge(
        &self,
        challenge: &StoredAcmeChallenge,
    ) -> anyhow::Result<()> {
        sqlx::query(
            "INSERT INTO acme_challenges (id, organization_id, order_id, authz_id, type, token, status, version, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&challenge.id)
        .bind(&challenge.organization_id)
        .bind(&challenge.order_id)
        .bind(&challenge.authz_id)
        .bind(&challenge.challenge_type)
        .bind(&challenge.token)
        .bind(&challenge.status)
        .bind(challenge.version)
        .bind(&challenge.created_at)
        .bind(&challenge.updated_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// # Errors
    ///
    /// Returns an error when the lookup fails.
    pub async fn get_acme_challenge(
        &self,
        organization_id: &str,
        challenge_id: &str,
    ) -> anyhow::Result<Option<StoredAcmeChallenge>> {
        let row = sqlx::query("SELECT * FROM acme_challenges WHERE organization_id = ? AND id = ?")
            .bind(organization_id)
            .bind(challenge_id)
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.as_ref().map(stored_acme_challenge))
    }

    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn list_acme_challenges(
        &self,
        organization_id: &str,
        order_id: &str,
    ) -> anyhow::Result<Vec<StoredAcmeChallenge>> {
        let rows = sqlx::query(
            "SELECT * FROM acme_challenges WHERE organization_id = ? AND order_id = ? ORDER BY authz_id, type",
        )
        .bind(organization_id)
        .bind(order_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.iter().map(stored_acme_challenge).collect())
    }

    /// # Errors
    ///
    /// Returns an error when the update fails.
    pub async fn update_acme_challenge_status(
        &self,
        organization_id: &str,
        challenge_id: &str,
        status: &str,
    ) -> anyhow::Result<bool> {
        let result = sqlx::query(
            "UPDATE acme_challenges SET status = ?, version = version + 1, updated_at = ? \
             WHERE organization_id = ? AND id = ?",
        )
        .bind(status)
        .bind(now_rfc3339())
        .bind(organization_id)
        .bind(challenge_id)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    /// Mint a fresh single-use ACME replay nonce.
    ///
    /// # Errors
    ///
    /// Returns an error when the insert fails.
    pub async fn mint_acme_nonce(&self, organization_id: &str) -> anyhow::Result<String> {
        let nonce = uuid::Uuid::new_v4().simple().to_string();
        let now = now_rfc3339();
        self.ensure_organization_row(organization_id, &now).await?;
        sqlx::query(
            "INSERT INTO acme_nonces (id, organization_id, nonce, issued_at, version, created_at, updated_at) \
             VALUES (?, ?, ?, ?, 1, ?, ?)",
        )
        .bind(uuid::Uuid::new_v4().to_string())
        .bind(organization_id)
        .bind(&nonce)
        .bind(&now)
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await?;
        Ok(nonce)
    }

    /// Burn a nonce. The delete is the claim, so exactly one racing caller wins.
    ///
    /// # Errors
    ///
    /// Returns an error when the nonce is unknown or was already consumed.
    pub async fn consume_acme_nonce(
        &self,
        organization_id: &str,
        nonce: &str,
    ) -> anyhow::Result<()> {
        let result = sqlx::query("DELETE FROM acme_nonces WHERE organization_id = ? AND nonce = ?")
            .bind(organization_id)
            .bind(nonce)
            .execute(&self.pool)
            .await?;
        if result.rows_affected() != 1 {
            anyhow::bail!("ACME nonce is unknown or already consumed");
        }
        Ok(())
    }

    // —— EST and SCEP configuration ————————————————————————————————
}

// Row mappers for this module's tables. They lived at the crate root while
// every `impl Db` method did; `acme.rs` is their only caller, so they belong
// here and stay private to it.
fn stored_acme_account(row: &SqliteRow) -> StoredAcmeAccount {
    StoredAcmeAccount {
        id: row.get("id"),
        organization_id: row.get("organization_id"),
        profile_id: row.get("profile_id"),
        jwk_thumbprint: row.get("jwk_thumbprint"),
        eab_kid: row.get("eab_kid"),
        status: row.get("status"),
        contacts_json: row.get("contacts_json"),
        version: row.get("version"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }
}

fn stored_acme_order(row: &SqliteRow) -> StoredAcmeOrder {
    StoredAcmeOrder {
        id: row.get("id"),
        organization_id: row.get("organization_id"),
        account_id: row.get("account_id"),
        status: row.get("status"),
        identifiers_json: row.get("identifiers_json"),
        expires_at: row.get("expires_at"),
        finalize_csr_pem: row.get("finalize_csr_pem"),
        certificate_id: row.get("certificate_id"),
        version: row.get("version"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }
}

fn stored_acme_challenge(row: &SqliteRow) -> StoredAcmeChallenge {
    StoredAcmeChallenge {
        id: row.get("id"),
        organization_id: row.get("organization_id"),
        order_id: row.get("order_id"),
        authz_id: row.get("authz_id"),
        challenge_type: row.get("type"),
        token: row.get("token"),
        status: row.get("status"),
        version: row.get("version"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }
}
