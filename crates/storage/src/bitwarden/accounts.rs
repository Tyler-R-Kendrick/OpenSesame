//! Accounts behind the Bitwarden-compatible server (ADR 0141).
//!
//! The server stores what a Bitwarden server stores and nothing more: the
//! client-wrapped user key, the client-encrypted private key, the KDF settings
//! the client chose, and a server-side hash of the client's master-password
//! hash. None of it opens a vault.

use chrono::{DateTime, Utc};
use sqlx::sqlite::SqliteRow;

use crate::{Db, Row};

/// The KDF a client derives its master key with, as the wire enum carries it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BitwardenKdf {
    pub kdf_type: i64,
    pub iterations: i64,
    pub memory: Option<i64>,
    pub parallelism: Option<i64>,
}

/// One Bitwarden account. `master_password_hash` is a PHC string produced by
/// the server's password-hash registry, never the client's own hash.
#[derive(Clone, Debug)]
pub struct BitwardenUser {
    pub id: String,
    pub email: String,
    pub name: Option<String>,
    pub master_password_hash: String,
    pub master_password_hint: Option<String>,
    pub kdf: BitwardenKdf,
    pub user_key: String,
    /// The client-computed id of the user key, recorded so every client
    /// agrees on which key is current.
    pub user_key_id: Option<String>,
    pub public_key: Option<String>,
    pub private_key: Option<String>,
    pub security_stamp: String,
    pub culture: String,
    pub created_at: DateTime<Utc>,
    pub revision_at: DateTime<Utc>,
}

/// Everything a password or KDF change replaces at once.
#[derive(Clone, Debug)]
pub struct BitwardenCredentials {
    pub master_password_hash: String,
    pub kdf: BitwardenKdf,
    pub user_key: String,
    pub security_stamp: String,
}

pub(crate) fn bitwarden_timestamp(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub(crate) fn parse_bitwarden_timestamp(raw: &str) -> anyhow::Result<DateTime<Utc>> {
    Ok(DateTime::parse_from_rfc3339(raw)?.with_timezone(&Utc))
}

const USER_COLUMNS: &str = "id, email, name, master_password_hash, master_password_hint, \
     kdf_type, kdf_iterations, kdf_memory, kdf_parallelism, user_key, user_key_id, public_key, \
     private_key, security_stamp, culture, created_at, revision_at";

fn user_from_row(row: &SqliteRow) -> anyhow::Result<BitwardenUser> {
    Ok(BitwardenUser {
        id: row.get("id"),
        email: row.get("email"),
        name: row.get("name"),
        master_password_hash: row.get("master_password_hash"),
        master_password_hint: row.get("master_password_hint"),
        kdf: BitwardenKdf {
            kdf_type: row.get("kdf_type"),
            iterations: row.get("kdf_iterations"),
            memory: row.get("kdf_memory"),
            parallelism: row.get("kdf_parallelism"),
        },
        user_key: row.get("user_key"),
        user_key_id: row.get("user_key_id"),
        public_key: row.get("public_key"),
        private_key: row.get("private_key"),
        security_stamp: row.get("security_stamp"),
        culture: row.get("culture"),
        created_at: parse_bitwarden_timestamp(&row.get::<String, _>("created_at"))?,
        revision_at: parse_bitwarden_timestamp(&row.get::<String, _>("revision_at"))?,
    })
}

impl Db {
    /// Create an account. Returns `false`, and writes nothing, when the email
    /// is already registered.
    ///
    /// # Errors
    ///
    /// Returns an error when the write fails for any other reason.
    pub async fn bitwarden_create_user(&self, user: &BitwardenUser) -> anyhow::Result<bool> {
        let created = bitwarden_timestamp(user.created_at);
        let done = sqlx::query(
            "INSERT INTO bitwarden_users (id, email, name, master_password_hash, \
             master_password_hint, kdf_type, kdf_iterations, kdf_memory, kdf_parallelism, \
             user_key, user_key_id, public_key, private_key, security_stamp, culture, created_at, \
             revision_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) \
             ON CONFLICT(email) DO NOTHING",
        )
        .bind(&user.id)
        .bind(&user.email)
        .bind(&user.name)
        .bind(&user.master_password_hash)
        .bind(&user.master_password_hint)
        .bind(user.kdf.kdf_type)
        .bind(user.kdf.iterations)
        .bind(user.kdf.memory)
        .bind(user.kdf.parallelism)
        .bind(&user.user_key)
        .bind(&user.user_key_id)
        .bind(&user.public_key)
        .bind(&user.private_key)
        .bind(&user.security_stamp)
        .bind(&user.culture)
        .bind(&created)
        .bind(bitwarden_timestamp(user.revision_at))
        .bind(&created)
        .execute(&self.pool)
        .await?;
        Ok(done.rows_affected() == 1)
    }

    /// Look an account up by its normalized email.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails or a stored row is malformed.
    pub async fn bitwarden_user_by_email(
        &self,
        email: &str,
    ) -> anyhow::Result<Option<BitwardenUser>> {
        let sql = format!("SELECT {USER_COLUMNS} FROM bitwarden_users WHERE email = ?");
        let row = sqlx::query(&sql)
            .bind(email)
            .fetch_optional(&self.pool)
            .await?;
        row.as_ref().map(user_from_row).transpose()
    }

    /// Look an account up by id.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails or a stored row is malformed.
    pub async fn bitwarden_user_by_id(&self, id: &str) -> anyhow::Result<Option<BitwardenUser>> {
        let sql = format!("SELECT {USER_COLUMNS} FROM bitwarden_users WHERE id = ?");
        let row = sqlx::query(&sql)
            .bind(id)
            .fetch_optional(&self.pool)
            .await?;
        row.as_ref().map(user_from_row).transpose()
    }

    /// Replace the master-password material after a password or KDF change.
    /// Every refresh token dies with the old security stamp.
    ///
    /// # Errors
    ///
    /// Returns an error when the transaction cannot be completed.
    pub async fn bitwarden_replace_credentials(
        &self,
        user_id: &str,
        credentials: &BitwardenCredentials,
    ) -> anyhow::Result<()> {
        let now = bitwarden_timestamp(Utc::now());
        let mut tx = self.pool.begin().await?;
        sqlx::query(
            "UPDATE bitwarden_users SET master_password_hash = ?, kdf_type = ?, \
             kdf_iterations = ?, kdf_memory = ?, kdf_parallelism = ?, user_key = ?, \
             security_stamp = ?, revision_at = ?, updated_at = ? WHERE id = ?",
        )
        .bind(&credentials.master_password_hash)
        .bind(credentials.kdf.kdf_type)
        .bind(credentials.kdf.iterations)
        .bind(credentials.kdf.memory)
        .bind(credentials.kdf.parallelism)
        .bind(&credentials.user_key)
        .bind(&credentials.security_stamp)
        .bind(&now)
        .bind(&now)
        .bind(user_id)
        .execute(&mut *tx)
        .await?;
        sqlx::query("UPDATE bitwarden_devices SET refresh_token_hash = NULL WHERE user_id = ?")
            .bind(user_id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(())
    }

    /// Store a re-hash of the same secret under the registry's current scheme,
    /// but only while the stored hash is still `expected` — the one the caller
    /// verified. A password change that landed in between wins; the re-hash
    /// is dropped. Returns whether the re-hash was stored. The security stamp
    /// is untouched: nothing a client holds changed.
    ///
    /// # Errors
    ///
    /// Returns an error when the write fails.
    pub async fn bitwarden_set_password_hash(
        &self,
        user_id: &str,
        expected: &str,
        master_password_hash: &str,
    ) -> anyhow::Result<bool> {
        let done = sqlx::query(
            "UPDATE bitwarden_users SET master_password_hash = ?, updated_at = ? \
             WHERE id = ? AND master_password_hash = ?",
        )
        .bind(master_password_hash)
        .bind(bitwarden_timestamp(Utc::now()))
        .bind(user_id)
        .bind(expected)
        .execute(&self.pool)
        .await?;
        Ok(done.rows_affected() == 1)
    }

    /// Set the master-password hint (`None` clears it).
    ///
    /// # Errors
    ///
    /// Returns an error when the write fails.
    pub async fn bitwarden_set_hint(
        &self,
        user_id: &str,
        hint: Option<&str>,
    ) -> anyhow::Result<()> {
        sqlx::query(
            "UPDATE bitwarden_users SET master_password_hint = ?, updated_at = ? WHERE id = ?",
        )
        .bind(hint)
        .bind(bitwarden_timestamp(Utc::now()))
        .bind(user_id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Set the account's key pair — a public key and a user-key-wrapped
    /// private key — on an account that has none. Returns `false`, and writes
    /// nothing, when a pair is already set.
    ///
    /// # Errors
    ///
    /// Returns an error when the write fails.
    pub async fn bitwarden_set_keys(
        &self,
        user_id: &str,
        public_key: &str,
        private_key: &str,
    ) -> anyhow::Result<bool> {
        let done = sqlx::query(
            "UPDATE bitwarden_users SET public_key = ?, private_key = ?, updated_at = ? \
             WHERE id = ? AND private_key IS NULL",
        )
        .bind(public_key)
        .bind(private_key)
        .bind(bitwarden_timestamp(Utc::now()))
        .bind(user_id)
        .execute(&self.pool)
        .await?;
        Ok(done.rows_affected() == 1)
    }

    /// Rotate the security stamp — every access token and refresh token the
    /// account holds stops working.
    ///
    /// # Errors
    ///
    /// Returns an error when the transaction cannot be completed.
    pub async fn bitwarden_rotate_security_stamp(
        &self,
        user_id: &str,
        security_stamp: &str,
    ) -> anyhow::Result<()> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("UPDATE bitwarden_users SET security_stamp = ?, updated_at = ? WHERE id = ?")
            .bind(security_stamp)
            .bind(bitwarden_timestamp(Utc::now()))
            .bind(user_id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("UPDATE bitwarden_devices SET refresh_token_hash = NULL WHERE user_id = ?")
            .bind(user_id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(())
    }

    /// Advance the account revision date that clients poll before syncing.
    ///
    /// # Errors
    ///
    /// Returns an error when the write fails.
    pub async fn bitwarden_touch_revision(
        &self,
        user_id: &str,
        at: DateTime<Utc>,
    ) -> anyhow::Result<()> {
        sqlx::query("UPDATE bitwarden_users SET revision_at = ? WHERE id = ?")
            .bind(bitwarden_timestamp(at))
            .bind(user_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Record the id a client computed for the account's user key.
    ///
    /// # Errors
    ///
    /// Returns an error when the write fails.
    pub async fn bitwarden_set_user_key_id(
        &self,
        user_id: &str,
        key_id: &str,
    ) -> anyhow::Result<()> {
        sqlx::query("UPDATE bitwarden_users SET user_key_id = ?, updated_at = ? WHERE id = ?")
            .bind(key_id)
            .bind(bitwarden_timestamp(Utc::now()))
            .bind(user_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }
}
