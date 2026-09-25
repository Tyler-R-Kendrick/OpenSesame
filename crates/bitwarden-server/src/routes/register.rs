//! Account creation, in the current two-step form and the legacy one-step form.
//!
//! This server sends no mail, so it behaves as a self-hosted Bitwarden server
//! with email verification off: `send-verification-email` answers with the
//! verification token itself and the client goes straight to `finish`. The
//! operator's signup policy is what gates both forms.

use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use chrono::Utc;
use opensesame_storage::bitwarden::BitwardenUser;
use serde_json::{Map, Value};

use super::credentials::{self, text, Names};
use crate::error::{ApiError, ApiResult};
use crate::routes::identity::normalize_email;
use crate::tokens::new_security_stamp;
use crate::wire::cipher::{is_enc_string, normalize};
use crate::BitwardenServer;

fn admitted_email(server: &BitwardenServer, body: &Map<String, Value>) -> ApiResult<String> {
    let email = normalize_email(&credentials::require(body, "email")?);
    // Exactly one `@`: a domain allow-list reads the part after the last one,
    // so `x@evil.example@corp.example` must never reach it.
    let well_formed = email.matches('@').count() == 1
        && email
            .split_once('@')
            .is_some_and(|(local, domain)| !local.is_empty() && domain.contains('.'));
    if !well_formed {
        return Err(ApiError::bad_request(
            "The Email field is not a valid e-mail address.",
        ));
    }
    if !server.config.signups.allows(&email) {
        return Err(ApiError::bad_request(
            "Registration has been disabled by the system administrator.",
        ));
    }
    Ok(email)
}

/// `POST /identity/accounts/register/send-verification-email`.
pub async fn send_verification_email(
    State(server): State<BitwardenServer>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let body = normalize(body);
    let email = admitted_email(&server, &body)?;
    Ok(Json(Value::String(
        server.tokens.mint_registration(&email)?,
    )))
}

/// `POST /identity/accounts/register/finish`.
pub async fn register_finish(
    State(server): State<BitwardenServer>,
    Json(body): Json<Value>,
) -> ApiResult<StatusCode> {
    let body = normalize(body);
    let email = admitted_email(&server, &body)?;
    let token = credentials::require(&body, "emailVerificationToken")?;
    if !server.tokens.verify_registration(&token, &email) {
        return Err(ApiError::bad_request("Invalid email verification token."));
    }
    let names = Names {
        authentication: "masterPasswordAuthentication",
        unlock: "masterPasswordUnlock",
        flat_hash: "masterPasswordHash",
        flat_key: "userSymmetricKey",
    };
    create(&server, &body, &email, &names, "userAsymmetricKeys").await
}

/// `POST /identity/accounts/register`, the one-step form older clients use.
pub async fn register_legacy(
    State(server): State<BitwardenServer>,
    Json(body): Json<Value>,
) -> ApiResult<StatusCode> {
    let body = normalize(body);
    let email = admitted_email(&server, &body)?;
    let names = Names {
        authentication: "masterPasswordAuthentication",
        unlock: "masterPasswordUnlock",
        flat_hash: "masterPasswordHash",
        flat_key: if body.contains_key("key") {
            "key"
        } else {
            "userSymmetricKey"
        },
    };
    let keys = if body.contains_key("keys") {
        "keys"
    } else {
        "userAsymmetricKeys"
    };
    create(&server, &body, &email, &names, keys).await
}

async fn create(
    server: &BitwardenServer,
    body: &Map<String, Value>,
    email: &str,
    names: &Names,
    keys_member: &str,
) -> ApiResult<StatusCode> {
    let new = credentials::read(body, names, email, server.config.kdf, None)?;
    let keys = normalize(body.get(keys_member).cloned().unwrap_or(Value::Null));
    let public_key = text(&keys, "publicKey");
    let private_key = text(&keys, "encryptedPrivateKey");
    if private_key
        .as_deref()
        .is_some_and(|key| !is_enc_string(key))
    {
        return Err(ApiError::bad_request(
            "The private key is not a valid encrypted string.",
        ));
    }
    let created = Utc::now();
    let user = BitwardenUser {
        id: uuid::Uuid::new_v4().to_string(),
        email: email.to_owned(),
        name: text(body, "name"),
        master_password_hash: server.hash_secret(&new.auth_hash).await?,
        master_password_hint: text(body, "masterPasswordHint"),
        kdf: new.kdf.to_stored(),
        user_key: new.wrapped_key,
        user_key_id: None,
        public_key: public_key.filter(|_| private_key.is_some()),
        private_key,
        security_stamp: new_security_stamp(),
        culture: "en-US".into(),
        created_at: created,
        revision_at: created,
    };
    if !server.db.bitwarden_create_user(&user).await? {
        return Err(ApiError::bad_request(format!(
            "Email '{email}' is already taken."
        )));
    }
    tracing::info!(kdf = user.kdf.kdf_type, "bitwarden-compat account created");
    Ok(StatusCode::OK)
}
