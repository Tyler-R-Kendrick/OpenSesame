//! `GET|PUT|DELETE /api/v1/web-login/recipes[/{origin}]`.

use axum::{
    body::Body,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use chrono::{DateTime, Utc};
use opensesame_rotation_web::recipe_doc::{
    parse_public_key_hex, RecipeDocument, RecipeError, MAX_RECIPE_BYTES,
};
use opensesame_storage::web_login_runs::recipes::{
    RecipeAudit, RecipeDeleteOutcome, RecipeVerification, RecipeWrite, RecipeWriteOutcome,
};
use serde_json::{json, Value};
use sha2::{Digest as _, Sha256};

use super::{
    admin_in_organization, error, expected_version, internal, origin_of, read_body, recipe_summary,
    with_version, EVENT_RECIPE_DELETED, EVENT_RECIPE_PUT,
};
use crate::app_state::AppState;
use crate::middleware::auth::Caller;

/// `GET /api/v1/web-login/recipes`.
pub(super) async fn list(State(st): State<AppState>, headers: HeaderMap) -> Response {
    let (_, organization_id) = match admin_in_organization(&st, &headers) {
        Ok(found) => found,
        Err(response) => return response,
    };
    let records = match st
        .db
        .list_web_login_recipes(&organization_id.to_string())
        .await
    {
        Ok(records) => records,
        Err(failure) => return internal("list web-login recipes", &failure),
    };
    let mut recipes = Vec::with_capacity(records.len());
    for record in &records {
        recipes.push(recipe_summary(&st, record).await);
    }
    Json(json!({ "recipes": recipes })).into_response()
}

/// `GET /api/v1/web-login/recipes/{origin}`.
pub(super) async fn get_one(
    State(st): State<AppState>,
    Path(raw): Path<String>,
    headers: HeaderMap,
) -> Response {
    let (_, organization_id) = match admin_in_organization(&st, &headers) {
        Ok(found) => found,
        Err(response) => return response,
    };
    let origin = match origin_of(&raw) {
        Ok(origin) => origin,
        Err(response) => return response,
    };
    let record = match st
        .db
        .web_login_recipe(&organization_id.to_string(), &origin)
        .await
    {
        Ok(Some(record)) => record,
        Ok(None) => {
            return error(
                StatusCode::NOT_FOUND,
                "not_found",
                "no recipe is stored for that origin",
            )
        }
        Err(failure) => return internal("read web-login recipe", &failure),
    };
    let document = record
        .document_json
        .as_deref()
        .and_then(|text| serde_json::from_str::<Value>(text).ok());
    let body = json!({
        "recipe": recipe_summary(&st, &record).await,
        "document": document,
    });
    with_version(StatusCode::OK, record.version, &body)
}

fn invalid(refused: &RecipeError) -> Response {
    error(
        StatusCode::BAD_REQUEST,
        "invalid_recipe",
        &refused.to_string(),
    )
}

fn unverifiable(code: &str, hint: &str) -> Response {
    error(StatusCode::UNPROCESSABLE_ENTITY, code, hint)
}

/// Check the document's signature against the organization's pinned keys.
///
/// `Ok(None)` for an unsigned document, which is stored as a candidate;
/// `Ok(Some(key_id))` when the signature checked; an error response for a
/// signature that cannot be verified — a claim that fails is refused, not
/// downgraded, so nobody believes a recipe is signed when it is not.
async fn verified_signer(
    st: &AppState,
    organization_id: &str,
    document: &RecipeDocument,
) -> Result<Option<String>, Response> {
    let Some(signature) = &document.signature else {
        if document.canary.is_some() {
            return Err(unverifiable(
                "canary_unsigned",
                "a canary claim counts only inside a verified signature; sign the recipe or drop the claim",
            ));
        }
        return Ok(None);
    };
    let signer = st
        .db
        .web_login_recipe_signer(organization_id, &signature.key_id)
        .await
        .map_err(|failure| internal("read web-login recipe signer", &failure))?;
    let Some(signer) = signer else {
        return Err(unverifiable(
            "unknown_signer",
            "the signing key is not pinned for this organization; pin it with POST /api/v1/web-login/signers first",
        ));
    };
    if signer.revoked_at.is_some() {
        return Err(unverifiable(
            "signer_revoked",
            "the signing key has been revoked for this organization",
        ));
    }
    let key = parse_public_key_hex(&signer.public_key)
        .map_err(|failure| internal("parse pinned signer", &anyhow::anyhow!("{failure}")))?;
    document
        .verify(&key)
        .map_err(|failure| unverifiable("invalid_signature", &failure.to_string()))?;
    Ok(Some(signer.key_id))
}

fn normalized(text: &str) -> Option<String> {
    DateTime::parse_from_rfc3339(text)
        .ok()
        .map(|at| at.with_timezone(&Utc).to_rfc3339())
}

fn put_audit(
    organization_id: &str,
    who: &Caller,
    document: &RecipeDocument,
    digest: &str,
    expected: i64,
    signer: Option<&str>,
) -> Value {
    json!({
        "organization_id": organization_id,
        "origin": document.origin,
        "recipe_id": document.recipe_id,
        "updated_by": who.actor_subject(),
        "previous_version": expected,
        "version": expected.saturating_add(1),
        "digest": digest,
        "verification": if signer.is_some() { "signature_verified" } else { "unsigned" },
        "signer_key_id": signer,
        "canary_attested": document.canary.is_some(),
    })
}

/// `PUT /api/v1/web-login/recipes/{origin}` — compare-and-set write.
pub(super) async fn put(
    State(st): State<AppState>,
    Path(raw): Path<String>,
    headers: HeaderMap,
    body: Body,
) -> Response {
    let (who, organization_id) = match admin_in_organization(&st, &headers) {
        Ok(found) => found,
        Err(response) => return response,
    };
    let origin = match origin_of(&raw) {
        Ok(origin) => origin,
        Err(response) => return response,
    };
    let expected = match expected_version(&headers) {
        Ok(version) => version,
        Err(response) => return response,
    };
    let bytes = match read_body(&headers, body, MAX_RECIPE_BYTES).await {
        Ok(bytes) => bytes,
        Err(response) => return response,
    };
    let now = Utc::now();
    let document = match RecipeDocument::parse(&bytes).and_then(|document| {
        document.check_window(now)?;
        Ok(document)
    }) {
        Ok(document) => document,
        Err(refused) => return invalid(&refused),
    };
    if document.origin != origin {
        return error(
            StatusCode::BAD_REQUEST,
            "origin_mismatch",
            "the recipe's origin is not the origin in the path",
        );
    }
    let organization = organization_id.to_string();
    let signer = match verified_signer(&st, &organization, &document).await {
        Ok(signer) => signer,
        Err(response) => return response,
    };
    store(
        &st,
        &who,
        &organization,
        &document,
        signer.as_deref(),
        expected,
        now,
    )
    .await
}

async fn store(
    st: &AppState,
    who: &Caller,
    organization: &str,
    document: &RecipeDocument,
    signer: Option<&str>,
    expected: i64,
    now: DateTime<Utc>,
) -> Response {
    let (Ok(digest), Ok(document_json), Ok(recipe_json)) = (
        document.digest(),
        serde_json::to_string(document),
        serde_json::to_string(document.steps()),
    ) else {
        return internal("serialize web-login recipe", &anyhow::anyhow!("recipe"));
    };
    let (Some(expires_at), canary_at) = (
        normalized(&document.expires_at),
        document
            .canary
            .as_ref()
            .and_then(|canary| normalized(&canary.verified_at)),
    ) else {
        return internal("normalize recipe timestamps", &anyhow::anyhow!("recipe"));
    };
    let now_text = now.to_rfc3339();
    let verification = signer.map(|key_id| RecipeVerification {
        signer_key_id: key_id,
        verified_at: &now_text,
        canary_attested_at: canary_at.as_deref(),
    });
    let audit_payload =
        put_audit(organization, who, document, &digest, expected, signer).to_string();
    let write = RecipeWrite {
        organization_id: organization,
        origin: &document.origin,
        recipe_id: &document.recipe_id,
        document_json: &document_json,
        recipe_json: &recipe_json,
        digest: &digest,
        expires_at: &expires_at,
        verification,
        expected_version: expected,
        updated_by: who.actor_subject(),
        now: &now_text,
    };
    let audit = RecipeAudit {
        event_type: EVENT_RECIPE_PUT,
        payload_json: &audit_payload,
    };
    match st.db.put_web_login_recipe_document(&write, &audit).await {
        Ok(RecipeWriteOutcome::Written(record)) => {
            let status = if expected == 0 {
                StatusCode::CREATED
            } else {
                StatusCode::OK
            };
            let body = json!({ "recipe": recipe_summary(st, &record).await });
            with_version(status, record.version, &body)
        }
        Ok(RecipeWriteOutcome::Conflict { current_version }) => (
            StatusCode::PRECONDITION_FAILED,
            Json(json!({
                "error": "precondition_failed",
                "hint": "the recipe changed since that version was read; GET it again and reapply",
                "current_version": current_version,
            })),
        )
            .into_response(),
        Ok(RecipeWriteOutcome::SignerNotPinned) => unverifiable(
            "signer_revoked",
            "the signing key was revoked while the recipe was being written",
        ),
        Err(failure) => internal("store web-login recipe", &failure),
    }
}

/// `DELETE /api/v1/web-login/recipes/{origin}` — compare-and-set removal.
pub(super) async fn remove(
    State(st): State<AppState>,
    Path(raw): Path<String>,
    headers: HeaderMap,
) -> Response {
    let (who, organization_id) = match admin_in_organization(&st, &headers) {
        Ok(found) => found,
        Err(response) => return response,
    };
    let origin = match origin_of(&raw) {
        Ok(origin) => origin,
        Err(response) => return response,
    };
    let expected = match expected_version(&headers) {
        Ok(version) => version,
        Err(response) => return response,
    };
    let organization = organization_id.to_string();
    let payload = json!({
        "organization_id": organization,
        "origin": origin,
        "deleted_by": who.actor_subject(),
        "version": expected,
        "origin_sha256": hex::encode(Sha256::digest(origin.as_bytes())),
    })
    .to_string();
    let audit = RecipeAudit {
        event_type: EVENT_RECIPE_DELETED,
        payload_json: &payload,
    };
    match st
        .db
        .delete_web_login_recipe(&organization, &origin, expected, &audit)
        .await
    {
        Ok(RecipeDeleteOutcome::Deleted) => {
            Json(json!({ "deleted": true, "origin": origin })).into_response()
        }
        Ok(RecipeDeleteOutcome::NotFound) => error(
            StatusCode::NOT_FOUND,
            "not_found",
            "no recipe is stored for that origin",
        ),
        Ok(RecipeDeleteOutcome::Conflict { current_version }) => (
            StatusCode::PRECONDITION_FAILED,
            Json(json!({
                "error": "precondition_failed",
                "hint": "the recipe changed since that version was read; GET it again and reapply",
                "current_version": current_version,
            })),
        )
            .into_response(),
        Err(failure) => internal("delete web-login recipe", &failure),
    }
}
