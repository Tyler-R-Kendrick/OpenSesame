//! Storage for STS bindings: one sealed blob per connection, nothing about it
//! readable without the deployment's key.

use chrono::{DateTime, SecondsFormat, Utc};
use sqlx::{Row, SqlitePool};

use crate::crypto::{self, SealedBlob};
use crate::Result;

/// One fixed shape for every stored time, so text order is time order.
pub(crate) fn stamp(time: DateTime<Utc>) -> String {
    time.to_rfc3339_opts(SecondsFormat::Secs, true)
}

/// The associated-data scope a binding is sealed under.
pub const BINDING_SCOPE: &str = "aws_sts_binding";

/// Create the table when absent.
///
/// # Errors
///
/// Returns an error when the schema cannot be created.
pub async fn ensure_schema(pool: &SqlitePool) -> Result<()> {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS aws_sts_bindings (
            connection_id TEXT PRIMARY KEY REFERENCES connections(id) ON DELETE CASCADE,
            organization_id TEXT NOT NULL,
            ciphertext BLOB NOT NULL,
            nonce BLOB NOT NULL,
            aad_digest TEXT NOT NULL,
            updated_at TEXT NOT NULL
         )",
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// Seal and write a binding, replacing any earlier one.
///
/// # Errors
///
/// Returns an error when sealing or storage fails.
pub async fn put_binding(
    pool: &SqlitePool,
    key: &[u8; 32],
    connection_id: &str,
    organization_id: &str,
    plaintext: &[u8],
) -> Result<()> {
    ensure_schema(pool).await?;
    let sealed = crypto::seal_scoped(
        key,
        BINDING_SCOPE,
        connection_id,
        organization_id,
        plaintext,
    )?;
    sqlx::query(
        "INSERT INTO aws_sts_bindings (connection_id, organization_id, ciphertext, nonce, aad_digest, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?) \
         ON CONFLICT(connection_id) DO UPDATE SET organization_id = excluded.organization_id, \
         ciphertext = excluded.ciphertext, nonce = excluded.nonce, aad_digest = excluded.aad_digest, \
         updated_at = excluded.updated_at",
    )
    .bind(connection_id)
    .bind(organization_id)
    .bind(&sealed.ciphertext)
    .bind(&sealed.nonce)
    .bind(&sealed.aad_digest)
    .bind(stamp(Utc::now()))
    .execute(pool)
    .await?;
    Ok(())
}

/// A connection's sealed binding, when it has one. Reading it needs no key,
/// so a connection with no binding answers the same with or without one.
///
/// # Errors
///
/// Returns an error when storage fails.
pub async fn sealed_binding(
    pool: &SqlitePool,
    connection_id: &str,
    organization_id: &str,
) -> Result<Option<SealedBlob>> {
    ensure_schema(pool).await?;
    let row = sqlx::query(
        "SELECT ciphertext, nonce, aad_digest FROM aws_sts_bindings \
         WHERE connection_id = ? AND organization_id = ?",
    )
    .bind(connection_id)
    .bind(organization_id)
    .fetch_optional(pool)
    .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    Ok(Some(SealedBlob {
        ciphertext: row.try_get("ciphertext")?,
        nonce: row.try_get("nonce")?,
        aad_digest: row.try_get("aad_digest")?,
    }))
}

/// Open a sealed binding for the connection it was sealed to.
///
/// # Errors
///
/// When the seal does not open: another connection's binding, another key.
pub fn open_binding(
    key: &[u8; 32],
    connection_id: &str,
    organization_id: &str,
    blob: &SealedBlob,
) -> Result<Vec<u8>> {
    crypto::open_scoped(key, BINDING_SCOPE, connection_id, organization_id, blob)
}

/// Remove a binding. Answers whether one existed.
///
/// # Errors
///
/// Returns an error when storage fails.
pub async fn delete_binding(
    pool: &SqlitePool,
    connection_id: &str,
    organization_id: &str,
) -> Result<bool> {
    ensure_schema(pool).await?;
    let done =
        sqlx::query("DELETE FROM aws_sts_bindings WHERE connection_id = ? AND organization_id = ?")
            .bind(connection_id)
            .bind(organization_id)
            .execute(pool)
            .await?;
    Ok(done.rows_affected() > 0)
}
