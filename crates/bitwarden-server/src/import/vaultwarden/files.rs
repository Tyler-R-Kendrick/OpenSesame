//! A vaultwarden account's files (ADR 0148): attachments, kept under
//! `attachments/<cipher>/<id>` in vaultwarden's data folder, and Sends, whose
//! files sit under `sends/<send>/<file>`. Bytes are read when the account is
//! written; metadata is read here.

use std::collections::HashSet;
use std::path::Path;

use chrono::Utc;
use opensesame_storage::bitwarden::{BitwardenAttachment, BitwardenSend};
use serde_json::{json, Value};
use sqlx::sqlite::{SqlitePool, SqliteRow};

use super::rows::{blob, int, json_column, text, timestamp, Schema};
use crate::hashing::pbkdf2_sha256_record;
use crate::import::{leave, ArrivingAttachment, ArrivingSend, FileSource, LeftBehind};
use crate::wire::cipher::is_enc_string;

/// Whose ciphers' files are read: an account's own, or an organization's.
#[derive(Clone, Copy)]
pub(super) enum Owner<'a> {
    Account(&'a str),
    Organization(&'a str),
}

/// The attachments of `ciphers` — the owner's ciphers that arrived.
pub(super) async fn attachments(
    pool: &SqlitePool,
    schema: &Schema,
    data: &Path,
    owner: Owner<'_>,
    ciphers: &HashSet<String>,
    left: &mut LeftBehind,
) -> anyhow::Result<Vec<ArrivingAttachment>> {
    if !schema.tables.contains("attachments") {
        return Ok(Vec::new());
    }
    let (column, id, user_id) = match owner {
        Owner::Account(id) => ("user_uuid", id, Some(id.to_owned())),
        Owner::Organization(id) => ("organization_uuid", id, None),
    };
    // Only the exhaustive Owner enum selects the column; the owner ID is bound.
    // ast-grep-ignore: sql-format-injection
    let rows = sqlx::query(&format!(
        "SELECT a.id, a.cipher_uuid, a.file_name, a.file_size, a.akey FROM attachments a \
         JOIN ciphers c ON c.uuid = a.cipher_uuid WHERE c.{column} = ?"
    ))
    .bind(id)
    .fetch_all(pool)
    .await?;
    let mut arriving = Vec::new();
    for row in &rows {
        let (Some(id), Some(cipher_id), Some(file_name)) = (
            text(row, "id"),
            text(row, "cipher_uuid"),
            text(row, "file_name"),
        ) else {
            leave(left, "unreadable attachments", 1);
            continue;
        };
        if !ciphers.contains(&cipher_id) || !is_enc_string(&file_name) {
            leave(left, "unreadable attachments", 1);
            continue;
        }
        let path = data.join("attachments").join(&cipher_id).join(&id);
        arriving.push(ArrivingAttachment {
            attachment: BitwardenAttachment {
                id,
                cipher_id,
                user_id: user_id.clone(),
                file_name,
                key: text(row, "akey"),
                size: int(row, "file_size").unwrap_or(0),
                uploaded: true,
                created_at: Utc::now(),
            },
            source: FileSource::Disk(path),
        });
    }
    Ok(arriving)
}

/// The Send's password as a record the registry verifies: vaultwarden keeps
/// PBKDF2-SHA256 over the client's hash in raw columns, as for accounts.
fn password(row: &SqliteRow) -> Option<String> {
    let hash = blob(row, "password_hash");
    let salt = blob(row, "password_salt");
    let iterations = int(row, "password_iter").and_then(|n| u32::try_from(n).ok())?;
    (!hash.is_empty() && !salt.is_empty()).then(|| pbkdf2_sha256_record(iterations, &salt, &hash))
}

fn send_from(row: &SqliteRow, data: &Path, user_id: &str) -> Option<ArrivingSend> {
    let id = text(row, "uuid")?;
    let name = text(row, "name").filter(|n| is_enc_string(n))?;
    let key = text(row, "akey").filter(|k| is_enc_string(k))?;
    let send_type = int(row, "atype")?;
    let payload = json_column(row, "data");
    let deletion = timestamp(text(row, "deletion_date"))?;
    let mut stored = json!({ "name": name, "notes": text(row, "notes") });
    let (mut file_id, mut file_size, mut file) = (None, None, None);
    match send_type {
        0 => {
            let hidden = payload.get("hidden").and_then(Value::as_bool);
            stored["text"] =
                json!({ "text": payload.get("text"), "hidden": hidden.unwrap_or(false) });
        }
        1 => {
            let id_of_file = payload.get("id").and_then(Value::as_str)?.to_owned();
            stored["file"] = json!({ "fileName": payload.get("fileName") });
            file_size = payload
                .get("size")
                .and_then(|s| s.as_i64().or_else(|| s.as_str()?.parse().ok()));
            file = Some(FileSource::Disk(
                data.join("sends").join(&id).join(&id_of_file),
            ));
            file_id = Some(id_of_file);
        }
        _ => return None,
    }
    let created = timestamp(text(row, "creation_date")).unwrap_or_else(Utc::now);
    Some(ArrivingSend {
        send: BitwardenSend {
            id,
            user_id: user_id.to_owned(),
            send_type,
            data: stored.to_string(),
            key,
            password_hash: password(row),
            max_access_count: int(row, "max_access_count"),
            access_count: int(row, "access_count").unwrap_or(0),
            disabled: int(row, "disabled") == Some(1),
            hide_email: int(row, "hide_email") == Some(1),
            file_id,
            file_size,
            uploaded: true,
            created_at: created,
            revision_at: timestamp(text(row, "revision_date")).unwrap_or(created),
            expiration_at: timestamp(text(row, "expiration_date")),
            deletion_at: deletion,
        },
        file,
    })
}

/// The account's own Sends that have not passed their deletion date.
pub(super) async fn sends(
    pool: &SqlitePool,
    schema: &Schema,
    data: &Path,
    user_id: &str,
    left: &mut LeftBehind,
) -> anyhow::Result<Vec<ArrivingSend>> {
    if !schema.tables.contains("sends") {
        return Ok(Vec::new());
    }
    let rows = sqlx::query("SELECT * FROM sends WHERE user_uuid = ?")
        .bind(user_id)
        .fetch_all(pool)
        .await?;
    let now = Utc::now();
    let mut arriving = Vec::new();
    for row in &rows {
        match send_from(row, data, user_id) {
            Some(send) if send.send.deletion_at > now => arriving.push(send),
            Some(_) => {}
            None => leave(left, "unreadable Sends", 1),
        }
    }
    Ok(arriving)
}
