//! Attachment claims and bytes are admitted under the SQLite writer lock.

use sqlx::Row as _;

/// An attachment write or ownership transfer exceeds its owner's storage quota.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BitwardenStorageQuotaExceeded;

impl std::fmt::Display for BitwardenStorageQuotaExceeded {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("Not enough storage available.")
    }
}

impl std::error::Error for BitwardenStorageQuotaExceeded {}

pub(super) fn admit(used: i64, additional: i64, quota: i64) -> anyhow::Result<()> {
    if additional > 0 && (used > quota || additional > quota.saturating_sub(used)) {
        return Err(BitwardenStorageQuotaExceeded.into());
    }
    Ok(())
}

pub(super) async fn owner_used(
    connection: &mut sqlx::SqliteConnection,
    user_id: Option<&str>,
    org_id: Option<&str>,
) -> anyhow::Result<i64> {
    let attachments: i64 = sqlx::query_scalar(
        "SELECT COALESCE(SUM(MAX(a.size, COALESCE(length(b.data), 0), 0)), 0) \
         FROM bitwarden_attachments a JOIN bitwarden_ciphers c ON c.id = a.cipher_id \
         LEFT JOIN bitwarden_blobs b ON b.id = a.id \
         WHERE (? IS NOT NULL AND c.user_id = ?) OR \
         (? IS NOT NULL AND c.organization_id = ?)",
    )
    .bind(user_id)
    .bind(user_id)
    .bind(org_id)
    .bind(org_id)
    .fetch_one(&mut *connection)
    .await?;
    let sends: i64 = sqlx::query_scalar(
        "SELECT COALESCE(SUM(file_size), 0) FROM bitwarden_sends WHERE user_id = ?",
    )
    .bind(user_id)
    .fetch_one(&mut *connection)
    .await?;
    Ok(attachments
        .checked_add(sends)
        .ok_or(BitwardenStorageQuotaExceeded)?)
}

pub(super) async fn cipher_used(
    connection: &mut sqlx::SqliteConnection,
    cipher_id: &str,
) -> anyhow::Result<i64> {
    Ok(sqlx::query_scalar(
        "SELECT COALESCE(SUM(MAX(a.size, COALESCE(length(b.data), 0), 0)), 0) \
         FROM bitwarden_attachments a LEFT JOIN bitwarden_blobs b ON b.id = a.id \
         WHERE a.cipher_id = ?",
    )
    .bind(cipher_id)
    .fetch_one(connection)
    .await?)
}

pub(super) async fn admit_cipher_growth(
    connection: &mut sqlx::SqliteConnection,
    cipher_id: &str,
    additional: i64,
    quota: i64,
) -> anyhow::Result<()> {
    let owner = sqlx::query("SELECT user_id, organization_id FROM bitwarden_ciphers WHERE id = ?")
        .bind(cipher_id)
        .fetch_one(&mut *connection)
        .await?;
    let user: Option<String> = owner.get("user_id");
    let org: Option<String> = owner.get("organization_id");
    let used = owner_used(connection, user.as_deref(), org.as_deref()).await?;
    admit(used, additional, quota)
}
