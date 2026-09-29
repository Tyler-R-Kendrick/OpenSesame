//! `/api/two-factor` and `/api/accounts/api-key` (ADR 0148): the sign-in
//! methods a person manages from the web vault's security settings.
//!
//! Every change re-proves the master password, as Bitwarden's server asks;
//! setting up an authenticator also proves a code from it, so nobody turns on
//! a second step they cannot pass.

use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use chrono::Utc;
use opensesame_storage::bitwarden::BitwardenTwoFactor;
use serde_json::{json, Map, Value};

use super::accounts::prove_password;
use super::credentials::text;
use super::identity::normalize_email;
use super::second_step;
use crate::auth::Authed;
use crate::error::{ApiError, ApiResult};
use crate::second_factor::{
    code_step, is_authenticator_key, new_api_key, new_authenticator_key, new_recovery_code,
    normalize_key, AUTHENTICATOR,
};
use crate::wire::account::date;
use crate::wire::cipher::normalize;
use crate::BitwardenServer;

const SETUP_AUDIENCE: &str = "opensesame.bitwarden.two-factor-setup";
const SETUP_TTL_SECONDS: i64 = 15 * 60;

fn provider_json(provider: i64, enabled: bool) -> Value {
    json!({ "enabled": enabled, "type": provider, "object": "twoFactorProvider" })
}

/// Whether the account has any two-step provider turned on.
pub(crate) async fn enabled(server: &BitwardenServer, user_id: &str) -> ApiResult<bool> {
    Ok(server
        .db
        .bitwarden_two_factors(user_id)
        .await?
        .iter()
        .any(|f| f.enabled))
}

/// `GET /two-factor`, and the password-proving `POST` the web vault uses.
pub async fn list(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
) -> ApiResult<Json<Value>> {
    let data: Vec<Value> = server
        .db
        .bitwarden_two_factors(&user.id)
        .await?
        .iter()
        .filter(|f| f.enabled)
        .map(|f| provider_json(f.provider, true))
        .collect();
    Ok(Json(
        json!({ "data": data, "object": "list", "continuationToken": null }),
    ))
}

pub async fn list_proved(
    State(server): State<BitwardenServer>,
    authed: Authed,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    prove_password(&server, &authed.user, &normalize(body)).await?;
    list(State(server), authed).await
}

fn authenticator_json(
    server: &BitwardenServer,
    user_id: &str,
    enabled: bool,
    key: &str,
) -> ApiResult<Value> {
    let token = server.tokens.mint_purpose(
        &format!("{user_id}:{key}"),
        SETUP_AUDIENCE,
        SETUP_TTL_SECONDS,
    )?;
    Ok(json!({
        "enabled": enabled,
        "key": key,
        "userVerificationToken": token,
        "object": "twoFactorAuthenticator",
    }))
}

/// `POST /two-factor/get-authenticator`: the key in use, or a fresh one to
/// set up.
pub async fn get_authenticator(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    prove_password(&server, &user, &normalize(body)).await?;
    let current = server
        .db
        .bitwarden_two_factors(&user.id)
        .await?
        .into_iter()
        .find(|f| f.provider == AUTHENTICATOR && f.enabled);
    let (enabled, key) = match current {
        Some(factor) => (true, factor.data),
        None => (false, new_authenticator_key()),
    };
    Ok(Json(authenticator_json(&server, &user.id, enabled, &key)?))
}

/// The master password, or the setup token `get-authenticator` issued for
/// this very key.
async fn prove_setup(
    server: &BitwardenServer,
    user: &opensesame_storage::bitwarden::BitwardenUser,
    body: &Map<String, Value>,
    key: &str,
) -> ApiResult<()> {
    if text(body, "masterPasswordHash").is_some() {
        return prove_password(server, user, body).await;
    }
    let subject = format!("{}:{key}", user.id);
    match text(body, "userVerificationToken") {
        Some(token)
            if server
                .tokens
                .verify_purpose(&token, SETUP_AUDIENCE, &subject) =>
        {
            Ok(())
        }
        _ => Err(ApiError::invalid_password()),
    }
}

/// `PUT /two-factor/authenticator`: turn the authenticator on with a code
/// from it.
pub async fn enable_authenticator(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let body = normalize(body);
    let key = normalize_key(&text(&body, "key").unwrap_or_default());
    if !is_authenticator_key(&key) {
        return Err(ApiError::bad_request("Invalid key."));
    }
    prove_setup(&server, &user, &body, &key).await?;
    let step = code_step(
        &key,
        &text(&body, "token").unwrap_or_default(),
        Utc::now().timestamp(),
    )
    .ok_or_else(|| ApiError::bad_request("Invalid token."))?;
    server
        .db
        .bitwarden_put_two_factor(
            &user.id,
            &BitwardenTwoFactor {
                provider: AUTHENTICATOR,
                enabled: true,
                data: key.clone(),
                last_used_step: step,
            },
        )
        .await?;
    if server.db.bitwarden_recovery_code(&user.id).await?.is_none() {
        server
            .db
            .bitwarden_replace_recovery_code(&user.id, None, &new_recovery_code())
            .await?;
    }
    super::touch(&server, &user.id).await?;
    Ok(Json(authenticator_json(&server, &user.id, true, &key)?))
}

/// `PUT /two-factor/disable` and `DELETE /two-factor/authenticator`.
pub async fn disable(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let body = normalize(body);
    let provider = body
        .get("type")
        .and_then(Value::as_i64)
        .unwrap_or(AUTHENTICATOR);
    let key = normalize_key(&text(&body, "key").unwrap_or_default());
    prove_setup(&server, &user, &body, &key).await?;
    server
        .db
        .bitwarden_delete_two_factors(&user.id, Some(provider))
        .await?;
    super::policy_rules::after_two_factor_off(&server, &user.id).await?;
    super::touch(&server, &user.id).await?;
    Ok(Json(provider_json(provider, false)))
}

/// `POST /two-factor/get-recover`: the recovery code, made on first ask.
pub async fn get_recover(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    prove_password(&server, &user, &normalize(body)).await?;
    let code = if let Some(code) = server.db.bitwarden_recovery_code(&user.id).await? {
        code
    } else {
        let code = new_recovery_code();
        server
            .db
            .bitwarden_replace_recovery_code(&user.id, None, &code)
            .await?;
        code
    };
    Ok(Json(json!({ "code": code, "object": "twoFactorRecover" })))
}

/// `POST /two-factor/recover`, signed out: email, master password and the
/// recovery code turn two-step login off. One answer for every failure.
pub async fn recover(
    State(server): State<BitwardenServer>,
    Json(body): Json<Value>,
) -> ApiResult<StatusCode> {
    let body = normalize(body);
    let email = normalize_email(&text(&body, "email").unwrap_or_default());
    let secret = text(&body, "masterPasswordHash").unwrap_or_default();
    let code = text(&body, "recoveryCode").unwrap_or_default();
    let refused = || ApiError::bad_request("Invalid information. Try again.");
    if server.sign_in_failures.blocked(&email) {
        return Err(ApiError::too_many_requests());
    }
    let Some(user) = server.db.bitwarden_user_by_email(&email).await? else {
        server.decoy_check(&secret).await?;
        server.sign_in_failures.record_failure(&email);
        return Err(refused());
    };
    if !server
        .check_secret(&user.id, &user.master_password_hash, &secret)
        .await?
        || second_step::recover(&server, &user, &code).await.is_err()
    {
        server.sign_in_failures.record_failure(&email);
        return Err(refused());
    }
    server.sign_in_failures.clear(&email);
    super::touch(&server, &user.id).await?;
    Ok(StatusCode::OK)
}

fn api_key_json(key: &str) -> Value {
    json!({ "apiKey": key, "revisionDate": date(Utc::now()), "object": "apiKey" })
}

/// `POST /accounts/api-key`: the personal API key, made on first ask.
pub async fn api_key(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    prove_password(&server, &user, &normalize(body)).await?;
    let key = if let Some(key) = server.db.bitwarden_api_key(&user.id).await? {
        key
    } else {
        let key = new_api_key();
        server.db.bitwarden_set_api_key(&user.id, &key).await?;
        key
    };
    Ok(Json(api_key_json(&key)))
}

/// `POST /accounts/rotate-api-key`: a new key; the old one stops working.
pub async fn rotate_api_key(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    prove_password(&server, &user, &normalize(body)).await?;
    let key = new_api_key();
    server.db.bitwarden_set_api_key(&user.id, &key).await?;
    Ok(Json(api_key_json(&key)))
}
