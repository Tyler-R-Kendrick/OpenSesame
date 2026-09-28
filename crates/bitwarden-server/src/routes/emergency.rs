//! Emergency access (ADR 0148 §6): a trusted contact who may view the
//! grantor's vault, or take the account over, once a waiting period passes
//! that the grantor can cut short or refuse.
//!
//! The steps are Bitwarden's: invite → accept → the grantor confirms,
//! wrapping their user key under the contact's public key on their own
//! device → the contact initiates recovery → the grantor approves or
//! rejects, or the wait runs out → the contact views or takes over. This
//! server sends no mail, so an invitation to an existing account is accepted
//! at once and one to an unknown address is claimed when it registers. The
//! wait is settled when a record is read: nothing runs on a timer.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{Duration, Utc};
use opensesame_storage::bitwarden::{
    emergency_status as status, BitwardenCredentials, BitwardenEmergencyAccess, BitwardenUser,
};
use serde_json::{json, Value};

use super::credentials::{self, text, Names};
use super::folders::list_json;
use super::identity::normalize_email;
use super::touch;
use crate::auth::Authed;
use crate::error::{ApiError, ApiResult};
use crate::kdf::KdfConfig;
use crate::tokens::new_security_stamp;
use crate::wire::cipher::normalize;
use crate::BitwardenServer;

pub(crate) const VIEW: i64 = 0;
pub(crate) const TAKEOVER: i64 = 1;
/// Bitwarden offers waits of one to ninety days.
const MAX_WAIT_DAYS: i64 = 90;

pub(super) fn routes() -> Router<BitwardenServer> {
    Router::new()
        .route("/emergency-access/trusted", get(trusted))
        .route("/emergency-access/granted", get(granted))
        .route("/emergency-access/invite", post(invite))
        .route(
            "/emergency-access/{id}",
            get(get_one).put(update).post(update).delete(remove),
        )
        .route("/emergency-access/{id}/delete", post(remove))
        .route(
            "/emergency-access/{id}/reinvite",
            post(super::emergency_steps::reinvite),
        )
        .route(
            "/emergency-access/{id}/accept",
            post(super::emergency_steps::accept),
        )
        .route(
            "/emergency-access/{id}/confirm",
            post(super::emergency_steps::confirm),
        )
        .route(
            "/emergency-access/{id}/initiate",
            post(super::emergency_steps::initiate),
        )
        .route(
            "/emergency-access/{id}/approve",
            post(super::emergency_steps::approve),
        )
        .route(
            "/emergency-access/{id}/reject",
            post(super::emergency_steps::reject),
        )
        .route(
            "/emergency-access/{id}/view",
            post(super::emergency_use::view),
        )
        .route(
            "/emergency-access/{id}/takeover",
            post(super::emergency_use::takeover),
        )
        .route(
            "/emergency-access/{id}/password",
            post(super::emergency_use::password),
        )
        .route(
            "/emergency-access/{id}/policies",
            get(super::emergency_use::policies),
        )
        .route(
            "/emergency-access/{id}/{cipher}/attachment/{attachment}",
            get(super::emergency_use::attachment),
        )
}

pub(super) fn not_valid() -> ApiError {
    ApiError::bad_request("Emergency access not valid.")
}

/// A record, with a recovery whose wait has run out approved.
pub(crate) async fn settled(
    server: &BitwardenServer,
    id: &str,
) -> ApiResult<BitwardenEmergencyAccess> {
    let access = server
        .db
        .bitwarden_emergency_access(id)
        .await?
        .ok_or_else(ApiError::not_found)?;
    let due = access
        .recovery_initiated_at
        .map(|at| at + Duration::days(access.wait_time_days));
    if access.status != status::RECOVERY_INITIATED || due.is_none_or(|due| due > Utc::now()) {
        return Ok(access);
    }
    let approved = BitwardenEmergencyAccess {
        status: status::RECOVERY_APPROVED,
        revision_at: Utc::now(),
        ..access.clone()
    };
    server
        .db
        .bitwarden_emergency_transition(&approved, status::RECOVERY_INITIATED)
        .await?;
    Ok(server
        .db
        .bitwarden_emergency_access(id)
        .await?
        .unwrap_or(approved))
}

/// A record the account granted, or 404.
pub(super) async fn as_grantor(
    server: &BitwardenServer,
    user: &BitwardenUser,
    id: &str,
) -> ApiResult<BitwardenEmergencyAccess> {
    let access = settled(server, id).await?;
    if access.grantor_id == user.id {
        Ok(access)
    } else {
        Err(ApiError::not_found())
    }
}

/// A record naming the account as contact, or 404.
pub(crate) async fn as_grantee(
    server: &BitwardenServer,
    user: &BitwardenUser,
    id: &str,
) -> ApiResult<BitwardenEmergencyAccess> {
    let access = settled(server, id).await?;
    if access.grantee_id.as_deref() == Some(user.id.as_str()) {
        Ok(access)
    } else {
        Err(ApiError::not_found())
    }
}

pub(super) fn base_json(access: &BitwardenEmergencyAccess) -> Value {
    json!({
        "id": access.id,
        "status": access.status,
        "type": access.access_type,
        "waitTimeDays": access.wait_time_days,
        "creationDate": crate::wire::account::date(access.created_at),
        "object": "emergencyAccess",
    })
}

/// The record with the other party's name and address.
async fn details(
    server: &BitwardenServer,
    access: &BitwardenEmergencyAccess,
    other: Option<&str>,
    grantor_side: bool,
) -> ApiResult<Value> {
    let person = match other {
        Some(id) => server.db.bitwarden_user_by_id(id).await?,
        None => None,
    };
    let settings = match &person {
        Some(p) => server.db.bitwarden_account_settings(&p.id).await?,
        None => opensesame_storage::bitwarden::BitwardenAccountSettings::default(),
    };
    let mut out = base_json(access);
    let (id_key, object) = if grantor_side {
        ("granteeId", "emergencyAccessGranteeDetails")
    } else {
        ("grantorId", "emergencyAccessGrantorDetails")
    };
    out[id_key] = json!(other);
    out["email"] = json!(person
        .as_ref()
        .map_or(access.email.as_str(), |p| p.email.as_str()));
    out["name"] = json!(person.as_ref().and_then(|p| p.name.clone()));
    out["avatarColor"] = json!(settings.avatar_color);
    out["object"] = json!(object);
    Ok(out)
}

/// `GET /emergency-access/trusted`: the account's emergency contacts.
async fn trusted(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
) -> ApiResult<Json<Value>> {
    let mut out = Vec::new();
    for access in server
        .db
        .bitwarden_emergency_contacts(&user.id, true)
        .await?
    {
        let access = settled(&server, &access.id).await?;
        out.push(details(&server, &access, access.grantee_id.as_deref(), true).await?);
    }
    Ok(Json(list_json(&out)))
}

/// `GET /emergency-access/granted`: the accounts that named this one. An
/// invitation not yet accepted is not listed.
async fn granted(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
) -> ApiResult<Json<Value>> {
    let mut out = Vec::new();
    for access in server
        .db
        .bitwarden_emergency_contacts(&user.id, false)
        .await?
    {
        let access = settled(&server, &access.id).await?;
        out.push(details(&server, &access, Some(&access.grantor_id), false).await?);
    }
    Ok(Json(list_json(&out)))
}

/// `GET /emergency-access/{id}`: for its grantor.
async fn get_one(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let access = as_grantor(&server, &user, &id).await?;
    Ok(Json(
        details(&server, &access, access.grantee_id.as_deref(), true).await?,
    ))
}

fn access_type(body: &serde_json::Map<String, Value>) -> ApiResult<i64> {
    let raw = body.get("type").cloned().unwrap_or(Value::Null);
    match raw.as_i64().or_else(|| match raw.as_str() {
        Some("0" | "View") => Some(VIEW),
        Some("1" | "Takeover") => Some(TAKEOVER),
        _ => None,
    }) {
        Some(t @ (VIEW | TAKEOVER)) => Ok(t),
        _ => Err(ApiError::bad_request("Invalid emergency access type.")),
    }
}

fn wait_days(body: &serde_json::Map<String, Value>) -> ApiResult<i64> {
    body.get("waitTimeDays")
        .and_then(Value::as_i64)
        .filter(|d| (1..=MAX_WAIT_DAYS).contains(d))
        .ok_or_else(|| {
            ApiError::bad_request(format!(
                "The wait time must be between 1 and {MAX_WAIT_DAYS} days."
            ))
        })
}

/// `POST /emergency-access/invite`: `{email, type, waitTimeDays}`.
async fn invite(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Json(body): Json<Value>,
) -> ApiResult<StatusCode> {
    let body = normalize(body);
    let email = normalize_email(&text(&body, "email").unwrap_or_default());
    if !email.contains('@') {
        return Err(ApiError::bad_request("A valid email is required."));
    }
    if email == user.email {
        return Err(ApiError::bad_request(
            "You can not set yourself as an emergency contact.",
        ));
    }
    let contact = server.db.bitwarden_user_by_email(&email).await?;
    let now = Utc::now();
    let access = BitwardenEmergencyAccess {
        id: uuid::Uuid::new_v4().to_string(),
        grantor_id: user.id.clone(),
        status: if contact.is_some() {
            status::ACCEPTED
        } else {
            status::INVITED
        },
        grantee_id: contact.map(|c| c.id),
        email,
        key_encrypted: None,
        access_type: access_type(&body)?,
        wait_time_days: wait_days(&body)?,
        recovery_initiated_at: None,
        created_at: now,
        revision_at: now,
    };
    if !server.db.bitwarden_add_emergency_access(&access).await? {
        return Err(ApiError::bad_request(format!(
            "Grantee user already invited: {}",
            access.email
        )));
    }
    if let Some(id) = &access.grantee_id {
        touch(&server, id).await?;
    }
    Ok(StatusCode::OK)
}

/// `PUT /emergency-access/{id}`: `{type, waitTimeDays}`, by the grantor.
async fn update(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let current = as_grantor(&server, &user, &id).await?;
    let body = normalize(body);
    let next = BitwardenEmergencyAccess {
        access_type: access_type(&body)?,
        wait_time_days: wait_days(&body)?,
        revision_at: Utc::now(),
        ..current.clone()
    };
    if !server
        .db
        .bitwarden_emergency_transition(&next, current.status)
        .await?
    {
        return Err(not_valid());
    }
    Ok(Json(base_json(&next)))
}

/// `DELETE /emergency-access/{id}`: by either party.
async fn remove(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    let access = settled(&server, &id).await?;
    let party =
        access.grantor_id == user.id || access.grantee_id.as_deref() == Some(user.id.as_str());
    if !party {
        return Err(ApiError::not_found());
    }
    server.db.bitwarden_delete_emergency_access(&id).await?;
    for other in [Some(&access.grantor_id), access.grantee_id.as_ref()]
        .into_iter()
        .flatten()
    {
        touch(&server, other).await?;
    }
    Ok(StatusCode::OK)
}

/// New master-password material for a taken-over account, derived by the
/// contact under the grantor's address and KDF.
pub(crate) async fn takeover_credentials(
    server: &BitwardenServer,
    grantor: &BitwardenUser,
    body: &serde_json::Map<String, Value>,
) -> ApiResult<BitwardenCredentials> {
    let names = Names {
        authentication: "authenticationData",
        unlock: "unlockData",
        flat_hash: "newMasterPasswordHash",
        flat_key: "key",
    };
    let current = KdfConfig::from_stored(grantor.kdf);
    let new = credentials::read(
        body,
        &names,
        &grantor.email,
        server.config.kdf,
        Some(current),
    )?;
    Ok(BitwardenCredentials {
        master_password_hash: server.hash_secret(&new.auth_hash).await?,
        kdf: new.kdf.to_stored(),
        user_key: new.wrapped_key,
        security_stamp: new_security_stamp(),
    })
}
