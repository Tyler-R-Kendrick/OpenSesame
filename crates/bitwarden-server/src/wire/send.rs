//! Send bodies (ADR 0148): the owner's `SendRequestModel` checked, and the
//! `SendResponseModel` built from what is stored. Every name, note, text and
//! file name is an `EncString`; the key is the Send key wrapped under the
//! owner's user key.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use chrono::{DateTime, Duration, Utc};
use opensesame_storage::bitwarden::BitwardenSend;
use serde_json::{json, Map, Value};

use super::account::date;
use super::cipher::{is_enc_string, normalize};
use super::files::size_name;
use crate::error::{ApiError, ApiResult};

fn text(map: &Map<String, Value>, key: &str) -> Option<String> {
    map.get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

pub const TEXT: i64 = 0;
pub const FILE: i64 = 1;
/// Bitwarden refuses a deletion date further out than this.
const MAX_LIFETIME_DAYS: i64 = 31;

/// The id a link carries: the Send's UUID bytes, base64url.
pub fn access_id(id: &str) -> String {
    uuid::Uuid::parse_str(id).map_or_else(
        |_| id.to_owned(),
        |uuid| URL_SAFE_NO_PAD.encode(uuid.as_bytes()),
    )
}

pub fn id_from_access(access: &str) -> Option<String> {
    let bytes = URL_SAFE_NO_PAD.decode(access).ok()?;
    uuid::Uuid::from_slice(&bytes)
        .ok()
        .map(|uuid| uuid.to_string())
}

pub fn stored(send: &BitwardenSend) -> Value {
    serde_json::from_str(&send.data).unwrap_or_else(|_| json!({}))
}

pub fn file_json(send: &BitwardenSend, data: &Value) -> Value {
    match (&send.file_id, send.send_type) {
        (Some(id), FILE) => {
            let size = send.file_size.unwrap_or(0);
            json!({
                "id": id,
                "fileName": data["file"]["fileName"],
                "size": size.to_string(),
                "sizeName": size_name(size),
            })
        }
        _ => Value::Null,
    }
}

/// `SendResponseModel`.
pub fn send_json(send: &BitwardenSend) -> Value {
    let data = stored(send);
    json!({
        "id": send.id,
        "accessId": access_id(&send.id),
        "type": send.send_type,
        "name": data["name"],
        "notes": data["notes"],
        "text": if send.send_type == TEXT { data["text"].clone() } else { Value::Null },
        "file": file_json(send, &data),
        "key": send.key,
        "maxAccessCount": send.max_access_count,
        "accessCount": send.access_count,
        // Clients only ask whether there is one; the hash is not theirs.
        "password": send.password_hash.as_ref().map(|_| "set"),
        "disabled": send.disabled,
        "hideEmail": send.hide_email,
        "revisionDate": date(send.revision_at),
        "expirationDate": send.expiration_at.map(date),
        "deletionDate": date(send.deletion_at),
        "object": "send",
    })
}

fn when(body: &Map<String, Value>, key: &str) -> ApiResult<Option<DateTime<Utc>>> {
    text(body, key)
        .map(|raw| {
            DateTime::parse_from_rfc3339(&raw)
                .map(|at| at.with_timezone(&Utc))
                .map_err(|_| ApiError::bad_request(format!("Invalid {key}.")))
        })
        .transpose()
}

fn encrypted(body: &Map<String, Value>, key: &str, required: bool) -> ApiResult<Option<Value>> {
    match body.get(key) {
        None | Some(Value::Null) if !required => Ok(None),
        Some(Value::String(value)) if is_enc_string(value) => Ok(Some(json!(value))),
        _ => Err(ApiError::bad_request(format!(
            "The {key} is not encrypted."
        ))),
    }
}

/// The fields every Send write carries, checked.
pub struct SendInput {
    pub send_type: i64,
    pub data: Value,
    pub key: String,
    pub max_access_count: Option<i64>,
    pub expiration_at: Option<DateTime<Utc>>,
    pub deletion_at: DateTime<Utc>,
    pub disabled: bool,
    pub hide_email: bool,
    pub password: Option<String>,
}

pub fn parse_send(body: &Map<String, Value>) -> ApiResult<SendInput> {
    let send_type = body.get("type").and_then(Value::as_i64).unwrap_or(TEXT);
    let deletion_at = when(body, "deletionDate")?
        .ok_or_else(|| ApiError::bad_request("The DeletionDate field is required."))?;
    if deletion_at > Utc::now() + Duration::days(MAX_LIFETIME_DAYS) {
        return Err(ApiError::bad_request(
            "You cannot have a Send with a deletion date that far into the future. Adjust the \
             Deletion Date to a value less than 31 days from now and try again.",
        ));
    }
    let expiration_at = when(body, "expirationDate")?;
    let mut data = json!({
        "name": encrypted(body, "name", true)?,
        "notes": encrypted(body, "notes", false)?,
    });
    let part = normalize(
        body.get(if send_type == TEXT { "text" } else { "file" })
            .cloned()
            .unwrap_or(Value::Null),
    );
    if send_type == TEXT {
        data["text"] = json!({
            "text": encrypted(&part, "text", false)?,
            "hidden": part.get("hidden").and_then(Value::as_bool).unwrap_or(false),
        });
    } else if send_type == FILE {
        data["file"] = json!({ "fileName": encrypted(&part, "fileName", true)? });
    } else {
        return Err(ApiError::bad_request("Invalid Send type."));
    }
    let key = text(body, "key")
        .filter(|k| is_enc_string(k))
        .ok_or_else(|| ApiError::bad_request("The key is not encrypted."))?;
    Ok(SendInput {
        send_type,
        data,
        key,
        max_access_count: body.get("maxAccessCount").and_then(Value::as_i64),
        expiration_at,
        deletion_at,
        disabled: body
            .get("disabled")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        hide_email: body
            .get("hideEmail")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        password: text(body, "password"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_access_id_round_trips_to_the_send_id() {
        let id = "8a3f1c52-7a44-4d2e-9a0f-2f7e5f0b9c11";
        let access = access_id(id);
        assert_eq!(access.len(), 22);
        assert_eq!(id_from_access(&access).as_deref(), Some(id));
        assert_eq!(id_from_access("not-base64!"), None);
    }
}
