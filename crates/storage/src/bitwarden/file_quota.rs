//! Charge stored ciphertext bytes, or the reservation while a file is pending.
//! Call the quota checks only after taking the transaction's write lock.

use sqlx::SqliteConnection;

/// A file reservation or upload would exceed its owner's storage quota.
#[derive(Debug)]
pub struct FileQuotaExceeded;

impl std::fmt::Display for FileQuotaExceeded {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("Not enough storage available.")
    }
}

impl std::error::Error for FileQuotaExceeded {}

pub(super) const USER_STORAGE_USED: &str =
    "SELECT COALESCE((SELECT SUM(COALESCE(length(b.data), a.size)) \
     FROM bitwarden_attachments a LEFT JOIN bitwarden_blobs b ON b.id = a.id \
     WHERE a.user_id = ?), 0) \
     + COALESCE((SELECT SUM(COALESCE(length(b.data), s.file_size)) \
     FROM bitwarden_sends s LEFT JOIN bitwarden_blobs b ON b.id = s.file_id \
     WHERE s.user_id = ?), 0)";

pub(super) const ORG_STORAGE_USED: &str =
    "SELECT COALESCE(SUM(COALESCE(length(b.data), a.size)), 0) \
     FROM bitwarden_attachments a LEFT JOIN bitwarden_blobs b ON b.id = a.id \
     WHERE a.cipher_id IN (SELECT id FROM bitwarden_ciphers WHERE organization_id = ?)";

fn check(used: i64, quota: i64) -> anyhow::Result<()> {
    if used > quota {
        return Err(FileQuotaExceeded.into());
    }
    Ok(())
}

pub(super) async fn check_user(
    connection: &mut SqliteConnection,
    user_id: &str,
    quota: i64,
) -> anyhow::Result<()> {
    let used = sqlx::query_scalar(USER_STORAGE_USED)
        .bind(user_id)
        .bind(user_id)
        .fetch_one(connection)
        .await?;
    check(used, quota)
}

pub(super) async fn check_cipher(
    connection: &mut SqliteConnection,
    cipher_id: &str,
    quota: i64,
) -> anyhow::Result<()> {
    let (user_id, org_id): (Option<String>, Option<String>) =
        sqlx::query_as("SELECT user_id, organization_id FROM bitwarden_ciphers WHERE id = ?")
            .bind(cipher_id)
            .fetch_one(&mut *connection)
            .await?;
    if let Some(user_id) = user_id {
        check_user(connection, &user_id, quota).await
    } else if let Some(org_id) = org_id {
        let used = sqlx::query_scalar(ORG_STORAGE_USED)
            .bind(org_id)
            .fetch_one(connection)
            .await?;
        check(used, quota)
    } else {
        anyhow::bail!("Attachment has no storage owner")
    }
}
