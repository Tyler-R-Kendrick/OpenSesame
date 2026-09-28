//! A live account's files (ADR 0148): each attachment's ciphertext fetched
//! through a fresh download link into the import's scratch folder, and text
//! Sends copied as they are.
//!
//! What cannot move honestly stays behind, counted: a file Send's bytes can
//! only be fetched by spending one of its accesses, and a Send's password is
//! held by the old server in a form of its own.

use std::path::Path;

use chrono::{DateTime, Utc};
use opensesame_provider_bitwarden::Client;
use opensesame_storage::bitwarden::{BitwardenAttachment, BitwardenSend, BitwardenUser};
use serde_json::{json, Value};

use super::{leave, ArrivingAttachment, ArrivingSend, FileSource, LeftBehind};
use crate::wire::cipher::is_enc_string;

/// The largest file the importer will fetch.
const MAX_DOWNLOAD: usize = 500 * 1024 * 1024;

fn member<'v>(value: &'v Value, key: &str) -> Option<&'v Value> {
    let mut chars = key.chars();
    let upper = chars
        .next()
        .map(|c| c.to_ascii_uppercase().to_string() + chars.as_str())
        .unwrap_or_default();
    value
        .get(key)
        .or_else(|| value.get(upper))
        .filter(|v| !v.is_null())
}

fn text(value: &Value, key: &str) -> Option<String> {
    member(value, key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

fn date(value: &Value, key: &str) -> Option<DateTime<Utc>> {
    text(value, key)
        .and_then(|raw| DateTime::parse_from_rfc3339(&raw).ok())
        .map(|at| at.with_timezone(&Utc))
}

/// Every attachment on the account's own ciphers, downloaded into `scratch`.
pub(super) async fn attachments(
    api: &Client,
    token: &str,
    sync: &Value,
    user: &BitwardenUser,
    scratch: &Path,
    left: &mut LeftBehind,
) -> Vec<ArrivingAttachment> {
    let ciphers = member(sync, "ciphers")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut arriving = Vec::new();
    for cipher in ciphers
        .iter()
        .filter(|c| text(c, "organizationId").is_none())
    {
        let Some(cipher_id) = text(cipher, "id") else {
            continue;
        };
        let listed = member(cipher, "attachments")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        for attachment in listed {
            match fetch(api, token, &cipher_id, &attachment, user, scratch).await {
                Some(one) => arriving.push(one),
                None => leave(left, "attachments that could not be downloaded", 1),
            }
        }
    }
    arriving
}

async fn fetch(
    api: &Client,
    token: &str,
    cipher_id: &str,
    attachment: &Value,
    user: &BitwardenUser,
    scratch: &Path,
) -> Option<ArrivingAttachment> {
    let id = text(attachment, "id")?;
    let file_name = text(attachment, "fileName").filter(|n| is_enc_string(n))?;
    // The link in a sync may have lapsed; ask for a fresh one.
    let fresh = api
        .get_json(&format!("/ciphers/{cipher_id}/attachment/{id}"), token)
        .await
        .ok()?;
    let url = text(&fresh, "url").or_else(|| text(attachment, "url"))?;
    let bytes = api.download(&url, MAX_DOWNLOAD).await.ok()?;
    let path = scratch.join(&id);
    std::fs::write(&path, &bytes).ok()?;
    Some(ArrivingAttachment {
        attachment: BitwardenAttachment {
            id,
            cipher_id: cipher_id.to_owned(),
            user_id: user.id.clone(),
            file_name,
            key: text(attachment, "key"),
            size: i64::try_from(bytes.len()).unwrap_or(i64::MAX),
            uploaded: true,
            created_at: Utc::now(),
        },
        source: FileSource::Disk(path),
    })
}

/// The account's text Sends without a password; the rest are counted.
pub(super) fn sends(
    sync: &Value,
    user: &BitwardenUser,
    left: &mut LeftBehind,
) -> Vec<ArrivingSend> {
    let listed = member(sync, "sends")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let now = Utc::now();
    let mut arriving = Vec::new();
    for send in &listed {
        if member(send, "password").is_some() {
            leave(left, "Sends with a password", 1);
            continue;
        }
        if member(send, "type").and_then(Value::as_i64) != Some(0) {
            leave(left, "file Sends", 1);
            continue;
        }
        let (Some(id), Some(name), Some(key), Some(deletion)) = (
            text(send, "id"),
            text(send, "name").filter(|n| is_enc_string(n)),
            text(send, "key").filter(|k| is_enc_string(k)),
            date(send, "deletionDate"),
        ) else {
            leave(left, "unreadable Sends", 1);
            continue;
        };
        if deletion <= now {
            continue;
        }
        let body = member(send, "text").cloned().unwrap_or(Value::Null);
        let data = json!({
            "name": name,
            "notes": text(send, "notes"),
            "text": {
                "text": text(&body, "text"),
                "hidden": member(&body, "hidden").and_then(Value::as_bool).unwrap_or(false),
            },
        });
        let revised = date(send, "revisionDate").unwrap_or(now);
        arriving.push(ArrivingSend {
            send: BitwardenSend {
                id,
                user_id: user.id.clone(),
                send_type: 0,
                data: data.to_string(),
                key,
                password_hash: None,
                max_access_count: member(send, "maxAccessCount").and_then(Value::as_i64),
                access_count: member(send, "accessCount")
                    .and_then(Value::as_i64)
                    .unwrap_or(0),
                disabled: member(send, "disabled")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                hide_email: member(send, "hideEmail")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                file_id: None,
                file_size: None,
                uploaded: true,
                created_at: revised,
                revision_at: revised,
                expiration_at: date(send, "expirationDate"),
                deletion_at: deletion,
            },
            file: None,
        });
    }
    arriving
}
