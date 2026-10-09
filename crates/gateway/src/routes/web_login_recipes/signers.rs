//! `GET|POST /api/v1/web-login/signers`, `DELETE …/signers/{key_id}`.

use axum::{
    body::Body,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use chrono::Utc;
use opensesame_rotation_web::recipe_doc::{key_id_of, parse_public_key_hex};
use opensesame_storage::web_login_runs::recipes::RecipeAudit;
use opensesame_storage::web_login_runs::signers::{
    SignerPin, SignerPinOutcome, SignerRevokeOutcome, StoredRecipeSigner,
};
use serde::Deserialize;
use serde_json::{json, Value};

use super::{
    admin_in_organization, error, internal, read_body, EVENT_SIGNER_PINNED, EVENT_SIGNER_REVOKED,
};
use crate::app_state::AppState;
use crate::routes::agent_hooks::step_up;

/// Largest pin request: a key and a short label.
const MAX_PIN_BYTES: usize = 4 * 1024;

const MAX_LABEL_CHARS: usize = 80;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PinBody {
    /// The Ed25519 public key, 64 hex characters. Its id is derived from it.
    public_key: String,
    label: String,
}

fn signer_json(signer: &StoredRecipeSigner) -> Value {
    json!({
        "key_id": signer.key_id,
        "algorithm": "ed25519",
        "public_key": signer.public_key,
        "label": signer.label,
        "pinned_by": signer.pinned_by,
        "pinned_at": signer.pinned_at,
        "revoked_at": signer.revoked_at,
        "revoked_by": signer.revoked_by,
    })
}

/// `GET /api/v1/web-login/signers`.
pub(super) async fn list(State(st): State<AppState>, headers: HeaderMap) -> Response {
    let (_, organization_id) = match admin_in_organization(&st, &headers) {
        Ok(found) => found,
        Err(response) => return response,
    };
    match st
        .db
        .list_web_login_recipe_signers(&organization_id.to_string())
        .await
    {
        Ok(signers) => {
            let signers: Vec<Value> = signers.iter().map(signer_json).collect();
            Json(json!({ "signers": signers })).into_response()
        }
        Err(failure) => internal("list web-login recipe signers", &failure),
    }
}

fn invalid(hint: &str) -> Response {
    error(StatusCode::BAD_REQUEST, "invalid_signer", hint)
}

/// `POST /api/v1/web-login/signers` — pin a public key. Takes the policy's
/// step-up: a key an agent framework could pin would sign the recipes that
/// govern it.
pub(super) async fn pin(State(st): State<AppState>, headers: HeaderMap, body: Body) -> Response {
    let (who, organization_id) = match admin_in_organization(&st, &headers) {
        Ok(found) => found,
        Err(response) => return response,
    };
    if let Err(response) =
        step_up::require_step_up(&st, &headers, &who, "pin a web-login recipe signer")
    {
        return response;
    }
    let bytes = match read_body(&headers, body, MAX_PIN_BYTES).await {
        Ok(bytes) => bytes,
        Err(response) => return response,
    };
    let Ok(request) = serde_json::from_slice::<PinBody>(&bytes) else {
        return invalid("the body is {\"public_key\": \"<64 hex>\", \"label\": \"…\"}");
    };
    let label = request.label.trim();
    if label.is_empty()
        || label.chars().count() > MAX_LABEL_CHARS
        || label.chars().any(char::is_control)
    {
        return invalid("label is 1 to 80 characters, without control characters");
    }
    let key = match parse_public_key_hex(&request.public_key) {
        Ok(key) => key,
        Err(refused) => return invalid(&refused.to_string()),
    };
    let key_id = key_id_of(&key);
    let organization = organization_id.to_string();
    let pinned_at = Utc::now().to_rfc3339();
    let payload = json!({
        "organization_id": organization,
        "key_id": key_id,
        "pinned_by": who.actor_subject(),
    })
    .to_string();
    let outcome = st
        .db
        .pin_web_login_recipe_signer(
            &SignerPin {
                organization_id: &organization,
                key_id: &key_id,
                public_key: &hex::encode(key.as_bytes()),
                label,
                pinned_by: who.actor_subject(),
                pinned_at: &pinned_at,
            },
            &RecipeAudit {
                event_type: EVENT_SIGNER_PINNED,
                payload_json: &payload,
            },
        )
        .await;
    match outcome {
        Ok(SignerPinOutcome::Pinned(signer)) => (
            StatusCode::CREATED,
            Json(json!({ "signer": signer_json(&signer) })),
        )
            .into_response(),
        Ok(SignerPinOutcome::Exists(signer)) => (
            StatusCode::CONFLICT,
            Json(json!({
                "error": "signer_exists",
                "hint": "that key is already pinned for this organization, or was revoked and can never be pinned again",
                "signer": signer_json(&signer),
            })),
        )
            .into_response(),
        Ok(SignerPinOutcome::LimitReached) => error(
            StatusCode::CONFLICT,
            "signer_limit",
            "the organization holds as many recipe signers as it may; revoked keys count",
        ),
        Err(failure) => internal("pin web-login recipe signer", &failure),
    }
}

fn is_key_id(text: &str) -> bool {
    text.strip_prefix("rsk_").is_some_and(|rest| {
        rest.len() == 32
            && rest
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}

/// `DELETE /api/v1/web-login/signers/{key_id}` — revoke, for good. Recipes the
/// key signed stop being replayable at their next run.
pub(super) async fn revoke(
    State(st): State<AppState>,
    Path(key_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let (who, organization_id) = match admin_in_organization(&st, &headers) {
        Ok(found) => found,
        Err(response) => return response,
    };
    if !is_key_id(&key_id) {
        return invalid("a key id is rsk_ and 32 lowercase hex characters");
    }
    let organization = organization_id.to_string();
    let payload = json!({
        "organization_id": organization,
        "key_id": key_id,
        "revoked_by": who.actor_subject(),
    })
    .to_string();
    let outcome = st
        .db
        .revoke_web_login_recipe_signer(
            &organization,
            &key_id,
            who.actor_subject(),
            &Utc::now().to_rfc3339(),
            &RecipeAudit {
                event_type: EVENT_SIGNER_REVOKED,
                payload_json: &payload,
            },
        )
        .await;
    match outcome {
        Ok(SignerRevokeOutcome::Revoked(signer)) => {
            Json(json!({ "signer": signer_json(&signer) })).into_response()
        }
        Ok(SignerRevokeOutcome::NotFound) => error(
            StatusCode::NOT_FOUND,
            "not_found",
            "no such signer is pinned for this organization",
        ),
        Ok(SignerRevokeOutcome::AlreadyRevoked(signer)) => (
            StatusCode::CONFLICT,
            Json(json!({
                "error": "already_revoked",
                "hint": "that key was already revoked",
                "signer": signer_json(&signer),
            })),
        )
            .into_response(),
        Err(failure) => internal("revoke web-login recipe signer", &failure),
    }
}
