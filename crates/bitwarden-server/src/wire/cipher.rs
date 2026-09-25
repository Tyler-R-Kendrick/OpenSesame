//! Cipher and folder bodies.
//!
//! A cipher request is the client's `CipherRequestModel`. The server reads the
//! handful of members it manages (type, folder, favorite, revision guard) and
//! keeps the encrypted payload — name, notes, the type's own object, custom
//! fields, password history, the per-cipher key — exactly as sent.

use chrono::{DateTime, Utc};
use opensesame_storage::bitwarden::{BitwardenCipher, BitwardenFolder};
use serde_json::{json, Map, Value};

use super::account::date;
use crate::error::{ApiError, ApiResult};

/// Cipher types and the member that carries each one's payload.
const TYPES: &[(i64, &str)] = &[
    (1, "login"),
    (2, "secureNote"),
    (3, "card"),
    (4, "identity"),
    (5, "sshKey"),
];

/// Encrypted members kept verbatim beside the type's own payload.
const PAYLOAD: &[&str] = &[
    "name",
    "notes",
    "key",
    "reprompt",
    "fields",
    "passwordHistory",
];

const NAME_LIMIT: usize = 1_000;
const NOTES_LIMIT: usize = 10_000;

/// A validated cipher write.
#[derive(Debug)]
pub struct CipherInput {
    pub cipher_type: i64,
    pub folder_id: Option<String>,
    pub favorite: bool,
    pub data: Value,
    pub last_known_revision: Option<DateTime<Utc>>,
}

/// `2.iv|ct|mac`-shaped: a known type number, a dot, a body. The server
/// cannot open it; it only refuses what is plainly not ciphertext.
#[must_use]
pub fn is_enc_string(value: &str) -> bool {
    value
        .split_once('.')
        .is_some_and(|(kind, body)| kind.parse::<u8>().is_ok_and(|k| k <= 7) && !body.is_empty())
}

/// Clients send camelCase; ASP.NET binds case-insensitively, so do we.
fn camel_keys(body: Value) -> Map<String, Value> {
    let Value::Object(map) = body else {
        return Map::new();
    };
    map.into_iter()
        .map(|(key, value)| {
            let mut chars = key.chars();
            let camel = chars
                .next()
                .map(|first| first.to_ascii_lowercase().to_string() + chars.as_str())
                .unwrap_or_default();
            (camel, value)
        })
        .collect()
}

fn encrypted(map: &Map<String, Value>, key: &str, limit: usize, required: bool) -> ApiResult<()> {
    match map.get(key) {
        None | Some(Value::Null) if !required => Ok(()),
        Some(Value::String(value)) if is_enc_string(value) && value.len() <= limit => Ok(()),
        Some(Value::String(value)) if value.len() > limit => Err(ApiError::bad_request(format!(
            "The field {key} exceeds the maximum encrypted value length of {limit} characters."
        ))),
        _ => Err(ApiError::bad_request(format!(
            "The field {key} is not a valid encrypted string."
        ))),
    }
}

fn optional_string(map: &Map<String, Value>, key: &str) -> ApiResult<Option<String>> {
    match map.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) if value.is_empty() => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        Some(_) => Err(ApiError::bad_request(format!(
            "The field {key} must be a string."
        ))),
    }
}

/// Validate a `CipherRequestModel` from `user_id`.
///
/// # Errors
///
/// Returns a 400 [`ApiError`] for a missing or malformed member, a cipher
/// encrypted for somebody else, or an organization cipher.
pub fn parse_cipher(body: Value, user_id: &str) -> ApiResult<CipherInput> {
    let map = camel_keys(body);
    let cipher_type = map
        .get("type")
        .and_then(Value::as_i64)
        .ok_or_else(|| ApiError::bad_request("The Type field is required."))?;
    let (_, type_key) = TYPES
        .iter()
        .find(|(t, _)| *t == cipher_type)
        .ok_or_else(|| ApiError::bad_request("Invalid cipher type."))?;
    if optional_string(&map, "organizationId")?.is_some() {
        return Err(ApiError::bad_request(
            "Organizations are not supported by this server.",
        ));
    }
    if let Some(encrypted_for) = optional_string(&map, "encryptedFor")? {
        if encrypted_for != user_id {
            return Err(ApiError::bad_request(
                "The cipher was not encrypted for the current user. Please try again.",
            ));
        }
    }
    encrypted(&map, "name", NAME_LIMIT, true)?;
    encrypted(&map, "notes", NOTES_LIMIT, false)?;
    encrypted(&map, "key", NAME_LIMIT, false)?;
    let last_known_revision = optional_string(&map, "lastKnownRevisionDate")?
        .map(|raw| {
            DateTime::parse_from_rfc3339(&raw)
                .map(|at| at.with_timezone(&Utc))
                .map_err(|_| ApiError::bad_request("Invalid LastKnownRevisionDate."))
        })
        .transpose()?;

    let mut data = Map::new();
    for key in PAYLOAD.iter().chain(std::iter::once(type_key)) {
        if let Some(value) = map.get(*key).filter(|v| !v.is_null()) {
            data.insert((*key).to_owned(), value.clone());
        }
    }
    Ok(CipherInput {
        cipher_type,
        folder_id: optional_string(&map, "folderId")?,
        favorite: map
            .get("favorite")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        data: Value::Object(data),
        last_known_revision,
    })
}

/// `CipherDetailsResponseModel` for a personal cipher.
#[must_use]
pub fn cipher_json(cipher: &BitwardenCipher) -> Value {
    let stored: Value = serde_json::from_str(&cipher.data).unwrap_or_else(|_| json!({}));
    let field = |key: &str| stored.get(key).cloned().unwrap_or(Value::Null);
    let mut body = json!({
        "id": cipher.id,
        "organizationId": null,
        "folderId": cipher.folder_id,
        "type": cipher.cipher_type,
        "name": field("name"),
        "notes": field("notes"),
        "key": field("key"),
        "reprompt": stored.get("reprompt").cloned().unwrap_or(json!(0)),
        "fields": field("fields"),
        "passwordHistory": field("passwordHistory"),
        "attachments": null,
        "favorite": cipher.favorite,
        "edit": true,
        "viewPassword": true,
        "permissions": { "delete": true, "restore": true },
        "organizationUseTotp": false,
        "collectionIds": [],
        "revisionDate": date(cipher.revision_at),
        "creationDate": date(cipher.created_at),
        "deletedDate": cipher.deleted_at.map(date),
        "archivedDate": cipher.archived_at.map(date),
        "object": "cipherDetails",
    });
    if let Some(target) = body.as_object_mut() {
        for (_, key) in TYPES {
            target.insert((*key).to_owned(), field(key));
        }
    }
    body
}

/// `FolderResponseModel`.
#[must_use]
pub fn folder_json(folder: &BitwardenFolder) -> Value {
    json!({
        "id": folder.id,
        "name": folder.name,
        "revisionDate": date(folder.revision_at),
        "object": "folder",
    })
}

/// The `name` of a folder request.
///
/// # Errors
///
/// Returns a 400 [`ApiError`] when the name is missing or not ciphertext.
pub fn folder_name(body: Value) -> ApiResult<String> {
    let map = camel_keys(body);
    encrypted(&map, "name", NAME_LIMIT, true)?;
    Ok(map
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned())
}

/// Lower-camel member names, as ASP.NET binds them.
#[must_use]
pub fn normalize(body: Value) -> Map<String, Value> {
    camel_keys(body)
}

#[cfg(test)]
mod tests {
    use super::*;

    const NAME: &str = "2.AAAAAAAAAAAAAAAAAAAAAA==|AAAAAAAAAAAAAAAAAAAAAA==|AAAA";

    #[test]
    fn only_the_payload_is_kept_and_the_type_selects_its_object() {
        let input = parse_cipher(
            json!({"Type": 1, "Name": NAME, "Login": {"username": NAME}, "Card": {"number": NAME},
                   "favorite": true, "folderId": "f", "encryptedFor": "u", "junk": 1}),
            "u",
        )
        .unwrap();
        assert_eq!(input.cipher_type, 1);
        assert!(input.favorite);
        assert_eq!(input.folder_id.as_deref(), Some("f"));
        assert_eq!(
            input.data,
            json!({"name": NAME, "login": {"username": NAME}})
        );
    }

    #[test]
    fn refusals_carry_bitwarden_wording() {
        let refuse = |body: Value| parse_cipher(body, "u").unwrap_err().status().as_u16();
        assert_eq!(refuse(json!({"name": NAME})), 400);
        assert_eq!(refuse(json!({"type": 9, "name": NAME})), 400);
        assert_eq!(refuse(json!({"type": 1, "name": "plaintext"})), 400);
        assert_eq!(
            refuse(json!({"type": 1, "name": NAME, "encryptedFor": "v"})),
            400
        );
        assert_eq!(
            refuse(json!({"type": 1, "name": NAME, "organizationId": "o"})),
            400
        );
        let long = format!("2.{}", "A".repeat(NAME_LIMIT));
        assert_eq!(refuse(json!({"type": 1, "name": long})), 400);
    }

    #[test]
    fn enc_string_shape() {
        assert!(is_enc_string(NAME));
        assert!(is_enc_string("7.cose"));
        assert!(!is_enc_string("8.x"));
        assert!(!is_enc_string("2."));
        assert!(!is_enc_string("hello"));
    }
}
