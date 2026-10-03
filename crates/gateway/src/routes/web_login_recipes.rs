//! The recipes a web-login run replays, and the keys that sign them (ADR 0076
//! §4, ADR 0159).
//!
//! No recipe was ever written before this, so every real web-login job parked
//! with "no verified recipe for this origin". These routes are the writer and
//! the verifier:
//!
//! - `GET /api/v1/web-login/recipes` — the organization's recipes, each with
//!   what the Host has verified about it and whether a run may replay it now,
//!   attended and unattended.
//! - `GET|PUT|DELETE /api/v1/web-login/recipes/{origin}` — one recipe, by its
//!   percent-encoded origin. `PUT` takes the recipe document
//!   ([`opensesame_rotation_web::recipe_doc`]) and `If-Match` (the version it
//!   was made against, `"0"` for a new one); the version is the `ETag`.
//!   **Trust is never in the request.** The Host verifies the document's
//!   signature against the organization's pinned keys in the same transaction
//!   as the write and derives the trust from that; an unsigned document is
//!   stored `candidate`, which no run replays, and a signature that does not
//!   verify is refused, never stored.
//! - `POST /api/v1/web-login/recipes/{origin}/canary` — ask for one attended
//!   run of a verified recipe, driven from the caller's own browser. A
//!   completed run is the recipe's canary; an unattended run needs one
//!   (ADR 0076 §4).
//! - `GET|POST /api/v1/web-login/signers`, `DELETE …/signers/{key_id}` — the
//!   Ed25519 public keys the organization trusts to sign recipes. Pinning a
//!   key takes the policy's step-up (an agent framework often runs under an
//!   administrator's own token, and a key it could pin would sign the recipes
//!   that govern it); revoking is the safe direction and takes none. A
//!   revocation takes effect on the next run, not the next write.
//!
//! Every route is for a native session of an owner or admin, or the operator,
//! and never for an agent capability or a browser grant: an agent must not
//! write the recipes that govern it (ADR 0076 §1, ADR 0159). The guards
//! refuse both before dispatch, and the handlers refuse them again.
//!
//! A recipe is selectors and one URL — no value, no account, no session — so
//! nothing here is a secret. Every change commits an outbox audit event with
//! the row, carrying digests and ids, never the document.

mod canary;
mod recipes;
mod signers;

use axum::{
    body::{Body, Bytes},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::{delete, get, post},
    Json, Router,
};
use opensesame_domain::OrganizationId;
use opensesame_rotation_web::recipe_doc::canonical_origin;
use opensesame_storage::web_login_runs::recipes::StoredRecipeRecord;
use serde_json::{json, Value};

use crate::app_state::AppState;
use crate::middleware::auth::{
    require_operator, require_session, resolve_caller_organization, Caller,
};
use crate::session_claims::CredentialKind;

pub(crate) const EVENT_RECIPE_PUT: &str = "web_login.recipe.put";
pub(crate) const EVENT_RECIPE_DELETED: &str = "web_login.recipe.deleted";
pub(crate) const EVENT_SIGNER_PINNED: &str = "web_login.signer.pinned";
pub(crate) const EVENT_SIGNER_REVOKED: &str = "web_login.signer.revoked";

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/v1/web-login/recipes", get(recipes::list))
        .route(
            "/api/v1/web-login/recipes/{origin}",
            get(recipes::get_one)
                .put(recipes::put)
                .delete(recipes::remove),
        )
        .route(
            "/api/v1/web-login/recipes/{origin}/canary",
            post(canary::start),
        )
        .route(
            "/api/v1/web-login/signers",
            get(signers::list).post(signers::pin),
        )
        .route(
            "/api/v1/web-login/signers/{key_id}",
            delete(signers::revoke),
        )
}

fn error(status: StatusCode, error: &str, hint: &str) -> Response {
    (status, Json(json!({"error": error, "hint": hint}))).into_response()
}

fn internal(context: &'static str, failure: &anyhow::Error) -> Response {
    // The failure names a store or parse step, never a recipe.
    tracing::error!(error = %failure, context, "web-login recipe route failed");
    error(StatusCode::INTERNAL_SERVER_ERROR, "internal_error", context)
}

/// An owner/admin or the operator, as a native session: never an agent
/// capability and never a browser grant, whatever role either carries.
#[allow(clippy::result_large_err)] // axum::Response is intentionally the Err payload
fn admin_caller(st: &AppState, headers: &HeaderMap) -> Result<Caller, Response> {
    let who = if let Ok((_, claims)) = require_session(st, headers) {
        if claims.credential_kind != CredentialKind::NativeSession {
            return Err(error(
                StatusCode::FORBIDDEN,
                "forbidden",
                "only a native session or the operator may write recipes, never an agent or a browser grant",
            ));
        }
        Caller::Session {
            subject: crate::middleware::auth::session_subject(&claims),
            organization_id: claims.organization_id,
            role: claims.organization_role,
        }
    } else {
        require_operator(st, headers)?;
        Caller::Operator
    };
    if !who.can_configure_integrations() {
        return Err(error(
            StatusCode::FORBIDDEN,
            "forbidden",
            "owner or admin role required to manage web-login recipes and their signers",
        ));
    }
    Ok(who)
}

/// The caller and the organization they act in.
#[allow(clippy::result_large_err)] // axum::Response is intentionally the Err payload
fn admin_in_organization(
    st: &AppState,
    headers: &HeaderMap,
) -> Result<(Caller, OrganizationId), Response> {
    let who = admin_caller(st, headers)?;
    let organization_id = resolve_caller_organization(st, &who, headers)?;
    Ok((who, organization_id))
}

/// The origin a path names, in the form a rotation target stores it.
#[allow(clippy::result_large_err)] // axum::Response is intentionally the Err payload
fn origin_of(raw: &str) -> Result<String, Response> {
    canonical_origin(raw).ok_or_else(|| {
        error(
            StatusCode::BAD_REQUEST,
            "invalid_origin",
            "the origin is a percent-encoded https origin with no path, query or credentials, like https%3A%2F%2Flogin.example",
        )
    })
}

/// The version `If-Match` names: exactly one strong entity tag of digits.
#[allow(clippy::result_large_err)] // axum::Response is intentionally the Err payload
fn expected_version(headers: &HeaderMap) -> Result<i64, Response> {
    let Some(raw) = headers.get(header::IF_MATCH) else {
        return Err(error(
            StatusCode::PRECONDITION_REQUIRED,
            "precondition_required",
            "If-Match: \"<version>\" from GET /api/v1/web-login/recipes/{origin} is required (\"0\" for a new recipe)",
        ));
    };
    raw.to_str()
        .ok()
        .map(str::trim)
        .and_then(|tag| tag.strip_prefix('"')?.strip_suffix('"'))
        .filter(|digits| !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()))
        .and_then(|digits| digits.parse::<i64>().ok())
        .ok_or_else(|| {
            error(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                "If-Match must be one strong entity tag naming a recipe version, like \"3\"",
            )
        })
}

/// Read at most `limit` bytes of a body.
#[allow(clippy::result_large_err)] // axum::Response is intentionally the Err payload
async fn read_body(headers: &HeaderMap, body: Body, limit: usize) -> Result<Bytes, Response> {
    let too_large = || {
        error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "payload_too_large",
            "the request body is larger than this route reads",
        )
    };
    let declared = headers
        .get(header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<usize>().ok());
    if declared.is_some_and(|length| length > limit) {
        return Err(too_large());
    }
    axum::body::to_bytes(body, limit).await.map_err(|failure| {
        if std::error::Error::source(&failure)
            .is_some_and(<dyn std::error::Error>::is::<http_body_util::LengthLimitError>)
        {
            too_large()
        } else {
            error(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                "the body could not be read",
            )
        }
    })
}

/// `json` with the recipe's version as its strong `ETag`, uncacheable.
fn with_version(status: StatusCode, version: i64, body: &Value) -> Response {
    let mut response = (status, Json(body)).into_response();
    let headers = response.headers_mut();
    if let Ok(etag) = HeaderValue::from_str(&format!("\"{version}\"")) {
        headers.insert(header::ETAG, etag);
    }
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

/// What the Host has verified about a stored recipe, and whether a run may
/// replay it right now — each answer decided by the runner's own rule.
async fn recipe_summary(st: &AppState, record: &StoredRecipeRecord) -> Value {
    use crate::web_login::recipe_trust::{verified_recipe, Attendance};
    let now = chrono::Utc::now();
    let runs = |attendance| async move {
        verified_recipe(
            &st.db,
            &record.organization_id,
            &record.origin,
            attendance,
            now,
        )
        .await
        .is_ok()
    };
    let canary = record.canary_result.as_ref().map(|result| {
        json!({
            "result": result,
            "at": record.canary_at,
            "source": record.canary_source,
            "run_id": record.canary_run_id,
        })
    });
    json!({
        "origin": record.origin,
        "recipe_id": record.recipe_id,
        "version": record.version,
        "trust": record.trust,
        "digest": record.digest,
        "signer_key_id": record.signer_key_id,
        "verified_at": record.verified_at,
        "canary": canary,
        "expires_at": record.expires_at,
        "updated_at": record.updated_at,
        "updated_by": record.updated_by,
        "runnable": {
            "attended": runs(Attendance::Attended).await,
            "unattended": runs(Attendance::Unattended).await,
        },
    })
}

#[cfg(test)]
#[path = "web_login_recipes_canary_tests.rs"]
mod canary_tests;
#[cfg(test)]
#[path = "web_login_recipes_example_tests.rs"]
mod example_tests;
#[cfg(test)]
#[path = "web_login_recipes_put_tests.rs"]
mod put_tests;
#[cfg(test)]
#[path = "web_login_recipes_tests.rs"]
mod tests;
