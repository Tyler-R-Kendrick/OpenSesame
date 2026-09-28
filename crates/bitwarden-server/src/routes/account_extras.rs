//! The rest of an account (ADR 0148 §6): its name and avatar, its address,
//! deleting it, its devices, its equivalent domains — and honest answers
//! for what this server does not do (mail, log in with a device, breach
//! reports on an address).

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, post, put};
use axum::{Json, Router};
use opensesame_storage::bitwarden::{
    member_status, member_type, BitwardenAccountSettings, BitwardenCredentials, BitwardenUser,
};
use serde_json::{json, Value};

use super::accounts::prove_password;
use super::credentials::{self, text, Names};
use super::folders::list_json;
use super::identity::normalize_email;
use super::touch;
use crate::auth::Authed;
use crate::error::{ApiError, ApiResult};
use crate::kdf::KdfConfig;
use crate::tokens::new_security_stamp;
use crate::wire::account::{date, profile as profile_json};
use crate::wire::cipher::normalize;
use crate::BitwardenServer;

const NAME_LIMIT: usize = 50;

pub(super) fn routes() -> Router<BitwardenServer> {
    Router::new()
        .route(
            "/accounts/profile",
            put(update_profile).post(update_profile),
        )
        .route("/accounts/avatar", put(avatar).post(avatar))
        .route("/accounts", axum::routing::delete(delete_account))
        .route("/accounts/delete", post(delete_account))
        .route("/accounts/email-token", post(email_token))
        .route("/accounts/email", post(change_email))
        .route("/accounts/verify-email", post(nothing))
        .route("/accounts/password-hint", post(no_mail))
        .route("/accounts/delete-recover", post(no_mail))
        .route(
            "/settings/domains",
            get(domains).put(set_domains).post(set_domains),
        )
        .route("/devices", get(devices))
        .route("/devices/identifier/{identifier}", get(device))
        .route(
            "/devices/identifier/{identifier}/token",
            put(nothing).post(nothing),
        )
        .route(
            "/devices/identifier/{identifier}/clear-token",
            put(nothing).post(nothing),
        )
        .route("/devices/{id}/deactivate", post(forget_device))
        .route("/devices/{id}", axum::routing::delete(forget_device))
        .route("/devices/lost-trust", post(nothing))
        .route("/devices/untrust", post(nothing))
        .route("/auth-requests", get(empty).post(no_device_login))
        .route("/auth-requests/", post(no_device_login))
        .route("/auth-requests/pending", get(empty))
        .route("/webauthn", get(empty))
        .route("/hibp/breach", get(no_breach_reports))
}

/// The profile clients read, with the account's organizations and avatar.
pub(crate) async fn profile_body(
    server: &BitwardenServer,
    user: &BitwardenUser,
) -> ApiResult<Value> {
    let two_factor = super::two_factor::enabled(server, &user.id).await?;
    let organizations = super::organizations::for_profile(server, &user.id).await?;
    let settings = server.db.bitwarden_account_settings(&user.id).await?;
    let mut out = profile_json(user, two_factor, &organizations);
    out["avatarColor"] = json!(settings.avatar_color);
    Ok(out)
}

/// `domains` as a sync and `/settings/domains` carry it.
pub(crate) async fn domains_body(server: &BitwardenServer, user_id: &str) -> ApiResult<Value> {
    let settings = server.db.bitwarden_account_settings(user_id).await?;
    let parse = |raw: Option<String>| {
        raw.and_then(|r| serde_json::from_str::<Value>(&r).ok())
            .unwrap_or_else(|| json!([]))
    };
    Ok(json!({
        "equivalentDomains": parse(settings.equivalent_domains),
        "globalEquivalentDomains": [],
        "object": "domains",
    }))
}

async fn reread(server: &BitwardenServer, id: &str) -> ApiResult<BitwardenUser> {
    server
        .db
        .bitwarden_user_by_id(id)
        .await?
        .ok_or_else(ApiError::unauthorized)
}

/// `PUT /accounts/profile`: `{name}`.
async fn update_profile(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let name = text(&normalize(body), "name").map(|n| n.trim().to_owned());
    if name
        .as_ref()
        .is_some_and(|n| n.chars().count() > NAME_LIMIT)
    {
        return Err(ApiError::bad_request(format!(
            "The name may be at most {NAME_LIMIT} characters."
        )));
    }
    server
        .db
        .bitwarden_set_name(&user.id, name.as_deref().filter(|n| !n.is_empty()))
        .await?;
    let user = reread(&server, &user.id).await?;
    Ok(Json(profile_body(&server, &user).await?))
}

/// `PUT /accounts/avatar`: `{avatarColor}`, `#rrggbb` or null.
async fn avatar(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let color = text(&normalize(body), "avatarColor");
    let valid = color.as_deref().is_none_or(|c| {
        c.len() == 7 && c.starts_with('#') && c[1..].bytes().all(|b| b.is_ascii_hexdigit())
    });
    if !valid {
        return Err(ApiError::bad_request("The avatar colour must be #rrggbb."));
    }
    let mut settings = server.db.bitwarden_account_settings(&user.id).await?;
    settings.avatar_color = color;
    server
        .db
        .bitwarden_put_account_settings(&user.id, &settings)
        .await?;
    touch(&server, &user.id).await?;
    Ok(Json(profile_body(&server, &user).await?))
}

/// `DELETE /accounts`: after the master password, unless the account is the
/// only owner of an organization — deleting it would leave nobody who can.
async fn delete_account(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Json(body): Json<Value>,
) -> ApiResult<StatusCode> {
    prove_password(&server, &user, &normalize(body)).await?;
    for (member, org) in server.db.bitwarden_memberships(&user.id).await? {
        if member.member_type != member_type::OWNER || member.status != member_status::CONFIRMED {
            continue;
        }
        let members = server.db.bitwarden_org_members(&org.id).await?;
        if super::organizations::last_owner(&members, &member.id) {
            return Err(ApiError::bad_request(
                "Cannot delete this user because it is the sole owner of at least one \
                 organization. Please delete these organizations or upgrade another user.",
            ));
        }
    }
    server.db.bitwarden_delete_user(&user.id).await?;
    super::signed_out(&server, &user.id);
    tracing::info!("bitwarden-compat account deleted by its owner");
    Ok(StatusCode::OK)
}

fn new_address(body: &serde_json::Map<String, Value>) -> ApiResult<String> {
    let email = normalize_email(&text(body, "newEmail").unwrap_or_default());
    if email.contains('@') && email.len() <= 256 {
        Ok(email)
    } else {
        Err(ApiError::bad_request("A valid new email is required."))
    }
}

/// `POST /accounts/email-token`: this server sends no mail, so there is no
/// token to send; it proves the password and that the address is free.
async fn email_token(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Json(body): Json<Value>,
) -> ApiResult<StatusCode> {
    let body = normalize(body);
    prove_password(&server, &user, &body).await?;
    let email = new_address(&body)?;
    if server.db.bitwarden_user_by_email(&email).await?.is_some() {
        return Err(ApiError::bad_request("Email already taken."));
    }
    Ok(StatusCode::OK)
}

/// `POST /accounts/email`: move to a new address. The address is the KDF
/// salt, so the client sends master-password material derived under it.
async fn change_email(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Json(body): Json<Value>,
) -> ApiResult<StatusCode> {
    let body = normalize(body);
    prove_password(&server, &user, &body).await?;
    let email = new_address(&body)?;
    let names = Names {
        authentication: "authenticationData",
        unlock: "unlockData",
        flat_hash: "newMasterPasswordHash",
        flat_key: "key",
    };
    let current = KdfConfig::from_stored(user.kdf);
    let new = credentials::read(&body, &names, &email, server.config.kdf, Some(current))?;
    let replacement = BitwardenCredentials {
        master_password_hash: server.hash_secret(&new.auth_hash).await?,
        kdf: new.kdf.to_stored(),
        user_key: new.wrapped_key,
        security_stamp: new_security_stamp(),
    };
    if !server
        .db
        .bitwarden_change_email(&user.id, &email, &replacement)
        .await?
    {
        return Err(ApiError::bad_request("Email already taken."));
    }
    super::signed_out(&server, &user.id);
    tracing::info!("bitwarden-compat account changed its address");
    Ok(StatusCode::OK)
}

async fn nothing(_: Authed) -> StatusCode {
    StatusCode::OK
}

async fn empty(_: Authed) -> Json<Value> {
    Json(list_json(&[]))
}

/// Password hints and deletion links go by mail, which this server does
/// not send; answering "sent" would be a lie.
async fn no_mail() -> ApiError {
    ApiError::bad_request("This server sends no mail, so it cannot send that.")
}

async fn no_device_login() -> ApiError {
    ApiError::bad_request("Log in with device is not offered by this server.")
}

/// A breach report on an address would disclose it to a third party; the
/// Host checks passwords by k-anonymity instead (ADR 0080 §5).
async fn no_breach_reports(_: Authed) -> ApiError {
    ApiError::bad_request("Breach reports by address are not offered by this server.")
}

/// `GET /settings/domains`.
async fn domains(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
) -> ApiResult<Json<Value>> {
    Ok(Json(domains_body(&server, &user.id).await?))
}

/// `PUT /settings/domains`: `{equivalentDomains: [[domain…]…],
/// excludedGlobalEquivalentDomains: [type…]}`.
async fn set_domains(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let body = normalize(body);
    let groups = body.get("equivalentDomains").cloned().unwrap_or(json!([]));
    let well_formed = groups.as_array().is_some_and(|groups| {
        groups.len() <= 100
            && groups.iter().all(|group| {
                group.as_array().is_some_and(|domains| {
                    domains.len() <= 100
                        && domains
                            .iter()
                            .all(|d| d.as_str().is_some_and(|d| !d.is_empty() && d.len() <= 253))
                })
            })
    });
    if !well_formed {
        return Err(ApiError::bad_request("Invalid equivalent domains."));
    }
    let excluded = body
        .get("excludedGlobalEquivalentDomains")
        .cloned()
        .unwrap_or(json!([]));
    let settings = BitwardenAccountSettings {
        equivalent_domains: Some(groups.to_string()),
        excluded_global_domains: Some(excluded.to_string()),
        ..server.db.bitwarden_account_settings(&user.id).await?
    };
    server
        .db
        .bitwarden_put_account_settings(&user.id, &settings)
        .await?;
    touch(&server, &user.id).await?;
    Ok(Json(domains_body(&server, &user.id).await?))
}

fn device_json(device: &opensesame_storage::bitwarden::BitwardenDeviceSummary) -> Value {
    json!({
        "id": device.id,
        "name": device.name,
        "type": device.device_type,
        "identifier": device.identifier,
        "creationDate": date(device.created_at),
        "revisionDate": date(device.updated_at),
        "isTrusted": false,
        "encryptedUserKey": null,
        "encryptedPublicKey": null,
        "devicePendingAuthRequest": null,
        "object": "device",
    })
}

/// `GET /devices`.
async fn devices(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
) -> ApiResult<Json<Value>> {
    let list: Vec<Value> = server
        .db
        .bitwarden_devices(&user.id)
        .await?
        .iter()
        .map(device_json)
        .collect();
    Ok(Json(list_json(&list)))
}

/// `GET /devices/identifier/{identifier}`.
async fn device(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Path(identifier): Path<String>,
) -> ApiResult<Json<Value>> {
    server
        .db
        .bitwarden_devices(&user.id)
        .await?
        .iter()
        .find(|d| d.identifier == identifier)
        .map(|d| Json(device_json(d)))
        .ok_or_else(ApiError::not_found)
}

/// `POST /devices/{id}/deactivate`: sign that device out for good.
async fn forget_device(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    if server.db.bitwarden_forget_device(&user.id, &id).await? {
        Ok(StatusCode::OK)
    } else {
        Err(ApiError::not_found())
    }
}
