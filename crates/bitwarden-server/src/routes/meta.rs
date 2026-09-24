//! Server metadata and the full-vault sync.

use axum::extract::{Query, State};
use axum::http::HeaderMap;
use axum::Json;
use base64::engine::general_purpose::{URL_SAFE, URL_SAFE_NO_PAD};
use base64::Engine as _;
use chrono::Utc;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::auth::Authed;
use crate::error::ApiResult;
use crate::routes::identity::normalize_email;
use crate::wire::account::{date, profile, sync_decryption};
use crate::wire::cipher::{cipher_json, folder_json};
use crate::BitwardenServer;

/// The Bitwarden server release whose client protocol this surface speaks,
/// validated against the official `bw` CLI of the same version (ADR 0140).
pub const COMPATIBLE_SERVER_VERSION: &str = "2026.9.0";

/// `GET /api/config`: unauthenticated, read before sign-in.
pub async fn config(State(server): State<BitwardenServer>) -> Json<Value> {
    let base = &server.config.public_url;
    Json(json!({
        "version": COMPATIBLE_SERVER_VERSION,
        "gitHash": "opensesame",
        "server": {
            "name": "OpenSesame",
            "url": "https://github.com/Tyler-R-Kendrick/OpenSesame",
        },
        "environment": {
            "cloudRegion": null,
            "vault": base,
            "api": format!("{base}/api"),
            "identity": format!("{base}/identity"),
            "notifications": format!("{base}/notifications"),
            "sso": "",
        },
        "featureStates": {},
        "push": { "pushTechnology": 0, "vapidPublicKey": null },
        "settings": {
            "disableUserRegistration": server.config.signups == crate::SignupPolicy::Closed,
        },
        "object": "config",
    }))
}

pub async fn alive() -> Json<String> {
    Json(date(Utc::now()))
}

/// `GET /api/devices/knowndevice`, read from the `X-Request-Email` (base64url)
/// and `X-Device-Identifier` headers.
pub async fn known_device(
    State(server): State<BitwardenServer>,
    headers: HeaderMap,
) -> ApiResult<Json<bool>> {
    let header = |name: &str| headers.get(name).and_then(|v| v.to_str().ok());
    let email = header("x-request-email")
        .and_then(|raw| {
            URL_SAFE_NO_PAD
                .decode(raw.trim_end_matches('='))
                .or_else(|_| URL_SAFE.decode(raw))
                .ok()
        })
        .and_then(|bytes| String::from_utf8(bytes).ok());
    let (Some(email), Some(identifier)) = (email, header("x-device-identifier")) else {
        return Ok(Json(false));
    };
    Ok(Json(
        server
            .db
            .bitwarden_device_known(&normalize_email(&email), identifier)
            .await?,
    ))
}

#[derive(Deserialize)]
pub struct SyncQuery {
    #[serde(default, rename = "excludeDomains")]
    exclude_domains: Option<bool>,
}

/// `GET /api/sync`: the whole personal vault, encrypted.
pub async fn sync(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Query(query): Query<SyncQuery>,
) -> ApiResult<Json<Value>> {
    let folders = server.db.bitwarden_folders(&user.id).await?;
    let ciphers = server.db.bitwarden_ciphers(&user.id).await?;
    let domains = if query.exclude_domains.unwrap_or(false) {
        Value::Null
    } else {
        json!({
            "equivalentDomains": [],
            "globalEquivalentDomains": [],
            "object": "domains",
        })
    };
    Ok(Json(json!({
        "profile": profile(&user),
        "folders": folders.iter().map(folder_json).collect::<Vec<_>>(),
        "collections": [],
        "policies": [],
        "ciphers": ciphers.iter().map(cipher_json).collect::<Vec<_>>(),
        "domains": domains,
        "sends": [],
        "userDecryption": sync_decryption(&user),
        "object": "sync",
    })))
}
