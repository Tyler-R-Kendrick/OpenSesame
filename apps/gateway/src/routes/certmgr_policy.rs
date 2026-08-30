//! Certificate policy routes (ADR 0066 §2 — policies and profiles are separate
//! objects; a policy is a pure constraint document).
//!
//! `GET|POST /api/v1/certmgr/policies` and
//! `GET|PATCH|DELETE /api/v1/certmgr/policies/{id}`.
//!
//! The three-state rule semantics, the eight presets and the evaluator itself
//! live in [`opensesame_pki_core::policy`]; this module is only the HTTP
//! surface over them. It parses a request into
//! [`opensesame_pki_core::PolicyRules`], persists that document verbatim as
//! JSON so a read is lossless, and never re-implements a rule.
//!
//! Secrecy invariant: a policy document names subject attributes, SAN
//! patterns, algorithms and usages — public certificate material only. No
//! private key, sealed blob or connection credential is reachable from any
//! handler here, so every field of the stored row is safe to project.

use axum::{
    extract::{rejection::JsonRejection, Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use opensesame_pki_core::{policy, PolicyRules};
use opensesame_storage::StoredCertificatePolicy;
use serde::Deserialize;
use serde_json::{json, Map, Value};

use crate::app_state::AppState;
use crate::middleware::auth::{resolve_caller, resolve_caller_organization, Caller};

/// Body limit for every mutating policy and profile route (plan §4.2).
pub const MAX_BODY: usize = 16 * 1024;

/// Longest accepted policy or profile name.
pub(crate) const MAX_NAME_LEN: usize = 128;

/// Longest accepted policy description.
const MAX_DESCRIPTION_LEN: usize = 1024;

/// Largest accepted value list on any single field rule or constraint. A
/// pattern list this long is an operator mistake, not a policy; refusing it
/// keeps evaluation cost bounded for every later issuance.
const MAX_RULE_VALUES: usize = 256;

/// The `preset` column value for a hand-written rules document. The DDL
/// `CHECK` accepts the eight preset names plus this one.
const CUSTOM_PRESET: &str = "custom";

// —— shared response helpers (used by `certmgr_profile` too) ——————————

/// Owner/admin gate. Runs before any `st.db` access, on every handler.
pub(crate) fn require_configurator(st: &AppState, headers: &HeaderMap) -> Result<Caller, Response> {
    let who = resolve_caller(st, headers)?;
    if !who.can_configure_integrations() {
        return Err((
            StatusCode::FORBIDDEN,
            Json(json!({
                "error": "forbidden",
                "hint": "owner or admin role required to configure certificate policies"
            })),
        )
            .into_response());
    }
    Ok(who)
}

/// The organization every storage call in this file is scoped to.
pub(crate) fn caller_organization(
    st: &AppState,
    who: &Caller,
    headers: &HeaderMap,
) -> Result<String, Response> {
    resolve_caller_organization(st, who, headers).map(|id| id.to_string())
}

/// The `fn internal(...)` pattern: log the cause, return a fixed opaque body.
pub(crate) fn internal(error: impl std::fmt::Display, context: &'static str) -> Response {
    tracing::error!(%error, %context, "certificate manager operation failed");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({"error":"internal","hint":"certificate manager operation failed"})),
    )
        .into_response()
}

/// A 400 in the house `{"error","hint"}` shape.
pub(crate) fn bad_request(error: &'static str, hint: impl Into<String>) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({"error": error, "hint": hint.into()})),
    )
        .into_response()
}

/// A 409 in the house `{"error","hint"}` shape.
pub(crate) fn conflict(error: &'static str, hint: impl Into<String>) -> Response {
    (
        StatusCode::CONFLICT,
        Json(json!({"error": error, "hint": hint.into()})),
    )
        .into_response()
}

/// A 404 in the house `{"error","hint"}` shape. Cross-organization reads land
/// here rather than on a 403, so an id's existence never leaks across tenants.
pub(crate) fn not_found(hint: &'static str) -> Response {
    (
        StatusCode::NOT_FOUND,
        Json(json!({"error": "not_found", "hint": hint})),
    )
        .into_response()
}

/// Turn an `axum` JSON rejection — an unknown field, a type error, an oversized
/// body — into the house error shape instead of `axum`'s plain-text default.
pub(crate) fn json_body<T>(body: Result<Json<T>, JsonRejection>) -> Result<T, Response> {
    match body {
        Ok(Json(value)) => Ok(value),
        Err(JsonRejection::BytesRejection(rejection)) => Err((
            StatusCode::PAYLOAD_TOO_LARGE,
            Json(json!({
                "error": "payload_too_large",
                "hint": rejection.body_text(),
            })),
        )
            .into_response()),
        Err(rejection) => Err(bad_request("invalid_request", rejection.body_text())),
    }
}

/// Append the audit event for a mutating handler.
///
/// The state change and its event ought to share one transaction; the storage
/// accessors in `crates/storage` are not transaction-taking, so this follows
/// the compensating shape of `github_webhook::append_webhook_outbox` — the
/// caller undoes its write when the append fails.
pub(crate) async fn append_audit(
    st: &AppState,
    event_type: &str,
    payload: &Value,
) -> anyhow::Result<String> {
    let mut transaction = st.db.pool().begin().await?;
    let id =
        opensesame_storage::append_outbox_tx(&mut transaction, event_type, &payload.to_string())
            .await?;
    transaction.commit().await?;
    Ok(id)
}

/// Reject a name the DDL or the UI could not carry.
pub(crate) fn check_name(name: &str) -> Result<(), Response> {
    if name.trim().is_empty() {
        return Err(bad_request("invalid_request", "name must not be empty"));
    }
    if name.len() > MAX_NAME_LEN {
        return Err(bad_request(
            "invalid_request",
            format!("name must be at most {MAX_NAME_LEN} characters"),
        ));
    }
    Ok(())
}

/// Map a storage failure that is really a uniqueness collision onto a 409.
pub(crate) fn storage_write_error(
    error: &anyhow::Error,
    conflict_hint: &'static str,
    context: &'static str,
) -> Response {
    let text = error.to_string();
    if text.contains("UNIQUE constraint failed") {
        return conflict("conflict", conflict_hint);
    }
    internal(error, context)
}

// —— request bodies ————————————————————————————————————————————————

/// `POST /api/v1/certmgr/policies`.
///
/// `preset` seeds `rules` from [`policy::preset`]; any top-level key the caller
/// also sends under `rules` replaces the seeded one.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreatePolicyBody {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub preset: Option<opensesame_pki_core::types::PolicyPreset>,
    #[serde(default)]
    pub max_validity_seconds: Option<u64>,
    #[serde(default)]
    pub rules: Option<Value>,
}

/// `PATCH /api/v1/certmgr/policies/{id}`.
///
/// Absent fields are left alone. An empty `description` clears it, a
/// `max_validity_seconds` of `0` clears it, and `version`, when present, is the
/// version the caller read — a mismatch is a 409 rather than a lost update.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UpdatePolicyBody {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub preset: Option<opensesame_pki_core::types::PolicyPreset>,
    #[serde(default)]
    pub max_validity_seconds: Option<u64>,
    #[serde(default)]
    pub rules: Option<Value>,
    #[serde(default)]
    pub version: Option<i64>,
}

// —— projections ————————————————————————————————————————————————————

/// Whitelist projection of a stored policy. `rules` is re-serialized from the
/// typed document, so what a caller reads back is exactly what the evaluator
/// will see.
pub(crate) fn policy_view(row: &StoredCertificatePolicy) -> Result<Value, Response> {
    let rules: PolicyRules = serde_json::from_str(&row.rules_json)
        .map_err(|error| internal(error, "decode stored policy rules"))?;
    Ok(json!({
        "id": row.id,
        "name": row.name,
        "description": row.description,
        "preset": row.preset,
        "max_validity_seconds": row.max_validity_seconds,
        "rules": rules,
        "version": row.version,
        "created_at": row.created_at,
        "updated_at": row.updated_at,
    }))
}

// —— rules assembly ————————————————————————————————————————————————

/// Shallow-merge `overlay`'s top-level keys over `base`.
fn merge_top_level(base: &mut Map<String, Value>, overlay: Map<String, Value>) {
    for (key, value) in overlay {
        base.insert(key, value);
    }
}

/// Build the effective rules document from a seed (a preset, the stored
/// document, or the permissive default) and the caller's partial overlay.
fn resolve_rules(seed: PolicyRules, overlay: Option<Value>) -> Result<PolicyRules, Response> {
    let seeded = serde_json::to_value(&seed)
        .map_err(|error| internal(error, "serialize seeded policy rules"))?;
    let merged = match (seeded, overlay) {
        (_, None) => return Ok(seed),
        (Value::Object(mut base), Some(Value::Object(overlay))) => {
            merge_top_level(&mut base, overlay);
            Value::Object(base)
        }
        // A non-object `rules` is a caller error; let the typed deserialize
        // below produce the message rather than guessing at intent.
        (_, Some(other)) => other,
    };
    let rules: PolicyRules = serde_json::from_value(merged)
        .map_err(|error| bad_request("invalid_request", format!("rules: {error}")))?;
    check_rule_bounds(&rules)?;
    Ok(rules)
}

/// Refuse a rules document whose value lists are implausibly long.
fn check_rule_bounds(rules: &PolicyRules) -> Result<(), Response> {
    let subject = &rules.subject;
    let san = &rules.san;
    let lengths = [
        ("subject.cn", subject.cn.values.len()),
        ("subject.o", subject.o.values.len()),
        ("subject.ou", subject.ou.values.len()),
        ("subject.c", subject.c.values.len()),
        ("subject.st", subject.st.values.len()),
        ("subject.l", subject.l.values.len()),
        ("subject.dc", subject.dc.components.len()),
        ("san.dns", san.dns.values.len()),
        ("san.ip", san.ip.values.len()),
        ("san.email", san.email.values.len()),
        ("san.uri", san.uri.values.len()),
        ("san.upn", san.upn.values.len()),
        (
            "signature_algorithms",
            rules.signature_algorithms.allowed.len() + rules.signature_algorithms.required.len(),
        ),
        (
            "key_algorithms",
            rules.key_algorithms.allowed.len() + rules.key_algorithms.required.len(),
        ),
        (
            "key_usages",
            rules.key_usages.allowed.len() + rules.key_usages.required.len(),
        ),
        (
            "ext_key_usages",
            rules.ext_key_usages.allowed.len() + rules.ext_key_usages.required.len(),
        ),
    ];
    for (field, length) in lengths {
        if length > MAX_RULE_VALUES {
            return Err(bad_request(
                "invalid_request",
                format!("rules.{field} carries {length} values; the maximum is {MAX_RULE_VALUES}"),
            ));
        }
    }
    Ok(())
}

/// `max_validity_seconds` is a `u64` on the wire and a positive `INTEGER` in
/// the database; `0` clears it and anything past `i64::MAX` is a caller error,
/// never a panic or a constraint failure.
fn resolve_max_validity(seconds: Option<u64>) -> Result<Option<i64>, Response> {
    match seconds {
        None | Some(0) => Ok(None),
        Some(value) => i64::try_from(value).map(Some).map_err(|_| {
            bad_request(
                "invalid_request",
                "max_validity_seconds must be at most 9223372036854775807",
            )
        }),
    }
}

fn resolve_description(description: Option<String>) -> Result<Option<String>, Response> {
    match description {
        None => Ok(None),
        Some(text) if text.is_empty() => Ok(None),
        Some(text) if text.len() > MAX_DESCRIPTION_LEN => Err(bad_request(
            "invalid_request",
            format!("description must be at most {MAX_DESCRIPTION_LEN} characters"),
        )),
        Some(text) => Ok(Some(text)),
    }
}

// —— handlers ——————————————————————————————————————————————————————

/// `GET /api/v1/certmgr/policies` — every policy in the caller's organization.
pub async fn list(State(st): State<AppState>, headers: HeaderMap) -> Response {
    let who = match require_configurator(&st, &headers) {
        Ok(who) => who,
        Err(response) => return response,
    };
    let organization = match caller_organization(&st, &who, &headers) {
        Ok(id) => id,
        Err(response) => return response,
    };
    let rows = match st.db.list_certificate_policies(&organization).await {
        Ok(rows) => rows,
        Err(error) => return internal(error, "list certificate policies"),
    };
    let mut policies = Vec::with_capacity(rows.len());
    for row in &rows {
        match policy_view(row) {
            Ok(view) => policies.push(view),
            Err(response) => return response,
        }
    }
    (StatusCode::OK, Json(json!({"policies": policies}))).into_response()
}

/// `POST /api/v1/certmgr/policies` — create one policy.
pub async fn create(
    State(st): State<AppState>,
    headers: HeaderMap,
    body: Result<Json<CreatePolicyBody>, JsonRejection>,
) -> Response {
    let who = match require_configurator(&st, &headers) {
        Ok(who) => who,
        Err(response) => return response,
    };
    let organization = match caller_organization(&st, &who, &headers) {
        Ok(id) => id,
        Err(response) => return response,
    };
    let body = match json_body(body) {
        Ok(body) => body,
        Err(response) => return response,
    };
    if let Err(response) = check_name(&body.name) {
        return response;
    }
    let description = match resolve_description(body.description) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let max_validity_seconds = match resolve_max_validity(body.max_validity_seconds) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let seed = body
        .preset
        .map_or_else(PolicyRules::default, policy::preset);
    let rules = match resolve_rules(seed, body.rules) {
        Ok(rules) => rules,
        Err(response) => return response,
    };
    let rules_json = match serde_json::to_string(&rules) {
        Ok(text) => text,
        Err(error) => return internal(error, "serialize policy rules"),
    };

    let now = chrono::Utc::now().to_rfc3339();
    let row = StoredCertificatePolicy {
        id: format!("certificate-policy:{}", uuid::Uuid::now_v7()),
        organization_id: organization.clone(),
        name: body.name,
        description,
        preset: body
            .preset
            .map_or(
                CUSTOM_PRESET,
                opensesame_pki_core::types::PolicyPreset::as_str,
            )
            .to_string(),
        max_validity_seconds,
        rules_json,
        version: 1,
        created_at: now.clone(),
        updated_at: now,
    };
    if let Err(error) = st.db.insert_certificate_policy(&row).await {
        return storage_write_error(
            &error,
            "a policy with that name already exists in this organization",
            "insert certificate policy",
        );
    }
    let view = match policy_view(&row) {
        Ok(view) => view,
        Err(response) => return response,
    };
    if let Err(error) = append_audit(
        &st,
        "certmgr.policy.created",
        &json!({"organization_id": organization, "policy_id": row.id, "name": row.name, "preset": row.preset}),
    )
    .await
    {
        // Compensate: an unaudited policy must not survive the request.
        if let Err(rollback) = st
            .db
            .delete_certificate_policy(&organization, &row.id)
            .await
        {
            tracing::error!(%rollback, "certificate policy rollback failed");
        }
        return internal(error, "append policy audit event");
    }
    (StatusCode::CREATED, Json(view)).into_response()
}

/// `GET /api/v1/certmgr/policies/{id}` — one policy, org-scoped.
pub async fn get(
    State(st): State<AppState>,
    headers: HeaderMap,
    Path(policy_id): Path<String>,
) -> Response {
    let who = match require_configurator(&st, &headers) {
        Ok(who) => who,
        Err(response) => return response,
    };
    let organization = match caller_organization(&st, &who, &headers) {
        Ok(id) => id,
        Err(response) => return response,
    };
    match st
        .db
        .get_certificate_policy(&organization, &policy_id)
        .await
    {
        Ok(Some(row)) => match policy_view(&row) {
            Ok(view) => (StatusCode::OK, Json(view)).into_response(),
            Err(response) => response,
        },
        Ok(None) => not_found("no such certificate policy"),
        Err(error) => internal(error, "get certificate policy"),
    }
}

/// `PATCH /api/v1/certmgr/policies/{id}` — partial update under a
/// compare-and-swap on `version`.
#[expect(
    clippy::too_many_lines,
    reason = "one linear validate-then-write path; splitting it would hide the ordering that keeps the authz gate ahead of every read and the rules merge ahead of the write"
)]
pub async fn update(
    State(st): State<AppState>,
    headers: HeaderMap,
    Path(policy_id): Path<String>,
    body: Result<Json<UpdatePolicyBody>, JsonRejection>,
) -> Response {
    let who = match require_configurator(&st, &headers) {
        Ok(who) => who,
        Err(response) => return response,
    };
    let organization = match caller_organization(&st, &who, &headers) {
        Ok(id) => id,
        Err(response) => return response,
    };
    let body = match json_body(body) {
        Ok(body) => body,
        Err(response) => return response,
    };
    let current = match st
        .db
        .get_certificate_policy(&organization, &policy_id)
        .await
    {
        Ok(Some(row)) => row,
        Ok(None) => return not_found("no such certificate policy"),
        Err(error) => return internal(error, "get certificate policy"),
    };

    let mut next = current.clone();
    if let Some(name) = body.name {
        if let Err(response) = check_name(&name) {
            return response;
        }
        next.name = name;
    }
    if body.description.is_some() {
        match resolve_description(body.description) {
            Ok(value) => next.description = value,
            Err(response) => return response,
        }
    }
    if body.max_validity_seconds.is_some() {
        match resolve_max_validity(body.max_validity_seconds) {
            Ok(value) => next.max_validity_seconds = value,
            Err(response) => return response,
        }
    }
    if body.preset.is_some() || body.rules.is_some() {
        let seed = match body.preset {
            Some(preset) => {
                next.preset = preset.as_str().to_string();
                policy::preset(preset)
            }
            None => match serde_json::from_str(&current.rules_json) {
                Ok(rules) => rules,
                Err(error) => return internal(error, "decode stored policy rules"),
            },
        };
        let rules = match resolve_rules(seed, body.rules) {
            Ok(rules) => rules,
            Err(response) => return response,
        };
        if body.preset.is_none() {
            next.preset = CUSTOM_PRESET.to_string();
        }
        match serde_json::to_string(&rules) {
            Ok(text) => next.rules_json = text,
            Err(error) => return internal(error, "serialize policy rules"),
        }
    }
    if let Some(expected) = body.version {
        next.version = expected;
    }

    match st.db.update_certificate_policy(&next).await {
        Ok(true) => {}
        Ok(false) => {
            return conflict(
                "version_conflict",
                "the policy changed since it was read; re-read it and retry",
            )
        }
        Err(error) => {
            return storage_write_error(
                &error,
                "a policy with that name already exists in this organization",
                "update certificate policy",
            )
        }
    }
    if let Err(error) = append_audit(
        &st,
        "certmgr.policy.updated",
        &json!({"organization_id": organization, "policy_id": next.id, "name": next.name}),
    )
    .await
    {
        tracing::error!(%error, "policy audit event append failed after update");
    }
    match st
        .db
        .get_certificate_policy(&organization, &policy_id)
        .await
    {
        Ok(Some(row)) => match policy_view(&row) {
            Ok(view) => (StatusCode::OK, Json(view)).into_response(),
            Err(response) => response,
        },
        Ok(None) => not_found("no such certificate policy"),
        Err(error) => internal(error, "re-read certificate policy"),
    }
}

/// `DELETE /api/v1/certmgr/policies/{id}` — refused while a profile still
/// points at it. Deleting the constraint out from under a profile would leave
/// the profile issuing unconstrained certificates, so nothing cascades.
pub async fn delete(
    State(st): State<AppState>,
    headers: HeaderMap,
    Path(policy_id): Path<String>,
) -> Response {
    let who = match require_configurator(&st, &headers) {
        Ok(who) => who,
        Err(response) => return response,
    };
    let organization = match caller_organization(&st, &who, &headers) {
        Ok(id) => id,
        Err(response) => return response,
    };
    match st
        .db
        .get_certificate_policy(&organization, &policy_id)
        .await
    {
        Ok(Some(_)) => {}
        Ok(None) => return not_found("no such certificate policy"),
        Err(error) => return internal(error, "get certificate policy"),
    }
    let profiles = match st.db.list_certificate_profiles(&organization).await {
        Ok(rows) => rows,
        Err(error) => return internal(error, "list certificate profiles"),
    };
    let referrers = profiles
        .iter()
        .filter(|profile| profile.policy_id == policy_id)
        .count();
    if referrers > 0 {
        return conflict(
            "policy_in_use",
            format!(
                "{referrers} profile(s) still reference this policy; repoint or delete them first"
            ),
        );
    }
    match st
        .db
        .delete_certificate_policy(&organization, &policy_id)
        .await
    {
        Ok(true) => {}
        Ok(false) => return not_found("no such certificate policy"),
        Err(error) => return internal(error, "delete certificate policy"),
    }
    if let Err(error) = append_audit(
        &st,
        "certmgr.policy.deleted",
        &json!({"organization_id": organization, "policy_id": policy_id}),
    )
    .await
    {
        tracing::error!(%error, "policy audit event append failed after delete");
    }
    StatusCode::NO_CONTENT.into_response()
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::app_state::{self, test_session_headers, AppState};
    use axum::body::{to_bytes, Body};
    use axum::http::Request;
    use axum::routing::get;
    use axum::Router;
    use opensesame_domain::{OrganizationId, OrganizationRole};
    use opensesame_pki_core::types::{
        BasicConstraintRule, CaRule, Constraint, ConstraintMode, DcRule, ExtendedKeyUsage,
        FieldRule, KeyAlgorithm, KeyUsage, PolicyPreset, RuleMode, SanRules, SignatureAlgorithm,
        SubjectRules,
    };
    use proptest::prelude::*;
    use tower::ServiceExt;

    /// The router mounted for these tests. It mirrors, route for route and
    /// limit for limit, the diff the assembler applies to `routes/mod.rs`.
    pub(crate) fn certmgr_router(state: AppState) -> Router {
        Router::new()
            .route(
                "/api/v1/certmgr/policies",
                get(super::list)
                    .post(super::create)
                    .layer(axum::extract::DefaultBodyLimit::max(MAX_BODY)),
            )
            .route(
                "/api/v1/certmgr/policies/{id}",
                get(super::get)
                    .patch(super::update)
                    .delete(super::delete)
                    .layer(axum::extract::DefaultBodyLimit::max(MAX_BODY)),
            )
            .route(
                "/api/v1/certmgr/profiles",
                get(crate::routes::certmgr_profile::list)
                    .post(crate::routes::certmgr_profile::create)
                    .layer(axum::extract::DefaultBodyLimit::max(MAX_BODY)),
            )
            .route(
                "/api/v1/certmgr/profiles/{id}",
                get(crate::routes::certmgr_profile::get)
                    .patch(crate::routes::certmgr_profile::update)
                    .delete(crate::routes::certmgr_profile::delete)
                    .layer(axum::extract::DefaultBodyLimit::max(MAX_BODY)),
            )
            .with_state(state)
    }

    pub(crate) async fn state() -> AppState {
        app_state::test_demo_state().await
    }

    pub(crate) fn owner(state: &AppState) -> HeaderMap {
        test_session_headers(
            state,
            "prn_policy_owner",
            state.connection_organization,
            OrganizationRole::Owner,
        )
    }

    pub(crate) fn member(state: &AppState) -> HeaderMap {
        test_session_headers(
            state,
            "prn_policy_member",
            state.connection_organization,
            OrganizationRole::Member,
        )
    }

    pub(crate) fn foreign_owner(state: &AppState) -> (HeaderMap, OrganizationId) {
        let organization = OrganizationId::new();
        (
            test_session_headers(
                state,
                "prn_foreign_owner",
                organization,
                OrganizationRole::Owner,
            ),
            organization,
        )
    }

    pub(crate) async fn call(
        state: &AppState,
        method: &str,
        path: &str,
        headers: &HeaderMap,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        call_raw(state, method, path, headers, body.map(|v| v.to_string())).await
    }

    pub(crate) async fn call_raw(
        state: &AppState,
        method: &str,
        path: &str,
        headers: &HeaderMap,
        body: Option<String>,
    ) -> (StatusCode, Value) {
        let mut request = Request::builder().method(method).uri(path);
        for (name, value) in headers {
            request = request.header(name, value);
        }
        let request = match body {
            Some(text) => request
                .header("content-type", "application/json")
                .body(Body::from(text))
                .unwrap(),
            None => request.body(Body::empty()).unwrap(),
        };
        let response = certmgr_router(state.clone())
            .oneshot(request)
            .await
            .unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), 4 * 1024 * 1024)
            .await
            .unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    async fn create_policy(state: &AppState, headers: &HeaderMap, body: Value) -> Value {
        let (status, value) = call(
            state,
            "POST",
            "/api/v1/certmgr/policies",
            headers,
            Some(body),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "{value}");
        value
    }

    // —— unit / behavior ——————————————————————————————————————————

    #[tokio::test]
    async fn given_each_shipped_preset_when_created_then_stored_rules_match_the_engine() {
        let state = state().await;
        let headers = owner(&state);
        for preset in PolicyPreset::ALL {
            let created = create_policy(
                &state,
                &headers,
                json!({"name": format!("preset-{}", preset.as_str()), "preset": preset.as_str()}),
            )
            .await;
            assert_eq!(created["preset"], json!(preset.as_str()));
            let (status, fetched) = call(
                &state,
                "GET",
                &format!(
                    "/api/v1/certmgr/policies/{}",
                    created["id"].as_str().unwrap()
                ),
                &headers,
                None,
            )
            .await;
            assert_eq!(status, StatusCode::OK, "{fetched}");
            let read_back: PolicyRules = serde_json::from_value(fetched["rules"].clone()).unwrap();
            assert_eq!(
                read_back,
                policy::preset(*preset),
                "preset {} drifted through the route layer",
                preset.as_str()
            );
        }
    }

    #[tokio::test]
    async fn given_a_preset_when_rules_are_also_sent_then_the_explicit_fields_win() {
        let state = state().await;
        let headers = owner(&state);
        let created = create_policy(
            &state,
            &headers,
            json!({
                "name": "seeded-then-overridden",
                "preset": "tls_server",
                "rules": {"key_algorithms": {"mode": "allow", "allowed": ["ed25519"]}},
            }),
        )
        .await;
        let rules: PolicyRules = serde_json::from_value(created["rules"].clone()).unwrap();
        // The overridden key survives...
        assert_eq!(rules.key_algorithms.allowed, vec![KeyAlgorithm::Ed25519]);
        // ...and every key the caller did not send still comes from the preset.
        assert_eq!(
            rules.san.dns,
            policy::preset(PolicyPreset::TlsServer).san.dns
        );
        assert_eq!(created["preset"], json!("tls_server"));
    }

    #[tokio::test]
    async fn given_a_hand_written_document_when_read_back_then_it_round_trips_losslessly() {
        let state = state().await;
        let headers = owner(&state);
        let rules = PolicyRules {
            subject: SubjectRules {
                cn: FieldRule::allow(["*.example.com"]),
                o: FieldRule::require(["Example Ltd"]),
                dc: DcRule {
                    mode: RuleMode::Allow,
                    components: vec!["*".into(), "example".into(), "com".into()],
                },
                ..SubjectRules::default()
            },
            san: SanRules {
                ip: FieldRule::allow(["10.0.0.0/8"]),
                upn: FieldRule::deny(["admin@example.com"]),
                ..SanRules::default()
            },
            key_algorithms: Constraint::allow([KeyAlgorithm::EcdsaP384]),
            signature_algorithms: Constraint::allow([SignatureAlgorithm::Sha384Ecdsa]),
            key_usages: Constraint::require(
                [KeyUsage::DigitalSignature],
                [KeyUsage::DigitalSignature],
            ),
            ext_key_usages: Constraint::allow([ExtendedKeyUsage::ServerAuth]),
            basic_constraints: BasicConstraintRule {
                ca: CaRule::Forbid,
                max_path_len: None,
            },
        };
        let created = create_policy(
            &state,
            &headers,
            json!({"name": "hand-written", "rules": rules, "max_validity_seconds": 7_776_000_u64}),
        )
        .await;
        assert_eq!(created["preset"], json!("custom"));
        assert_eq!(created["max_validity_seconds"], json!(7_776_000_i64));
        let (_, fetched) = call(
            &state,
            "GET",
            &format!(
                "/api/v1/certmgr/policies/{}",
                created["id"].as_str().unwrap()
            ),
            &headers,
            None,
        )
        .await;
        let read_back: PolicyRules = serde_json::from_value(fetched["rules"].clone()).unwrap();
        assert_eq!(read_back, rules);
    }

    #[tokio::test]
    async fn given_a_policy_when_patched_then_only_the_named_fields_change() {
        let state = state().await;
        let headers = owner(&state);
        let created = create_policy(
            &state,
            &headers,
            json!({"name": "patch-me", "preset": "tls_client", "description": "before"}),
        )
        .await;
        let id = created["id"].as_str().unwrap().to_string();
        let (status, patched) = call(
            &state,
            "PATCH",
            &format!("/api/v1/certmgr/policies/{id}"),
            &headers,
            Some(json!({"description": "after"})),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{patched}");
        assert_eq!(patched["description"], json!("after"));
        assert_eq!(patched["version"], json!(2));
        let rules: PolicyRules = serde_json::from_value(patched["rules"].clone()).unwrap();
        assert_eq!(rules, policy::preset(PolicyPreset::TlsClient));
    }

    #[tokio::test]
    async fn given_a_list_when_read_then_only_this_organizations_policies_appear() {
        let state = state().await;
        let headers = owner(&state);
        create_policy(
            &state,
            &headers,
            json!({"name": "mine", "preset": "device"}),
        )
        .await;
        let (foreign, _) = foreign_owner(&state);
        let (status, listed) =
            call(&state, "GET", "/api/v1/certmgr/policies", &foreign, None).await;
        assert_eq!(status, StatusCode::OK, "{listed}");
        assert_eq!(listed["policies"], json!([]));
    }

    // —— adversarial ————————————————————————————————————————————————

    #[tokio::test]
    async fn adversarial_a_member_cannot_read_or_write_policies() {
        let state = state().await;
        let member = member(&state);
        for (method, path, body) in [
            ("GET", "/api/v1/certmgr/policies", None),
            (
                "POST",
                "/api/v1/certmgr/policies",
                Some(json!({"name": "nope"})),
            ),
            ("GET", "/api/v1/certmgr/policies/anything", None),
            (
                "PATCH",
                "/api/v1/certmgr/policies/anything",
                Some(json!({"name": "nope"})),
            ),
            ("DELETE", "/api/v1/certmgr/policies/anything", None),
        ] {
            let (status, body) = call(&state, method, path, &member, body).await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{method} {path}: {body}");
        }
    }

    #[tokio::test]
    async fn adversarial_a_policy_in_another_organization_is_not_found_not_forbidden() {
        let state = state().await;
        let headers = owner(&state);
        let created = create_policy(
            &state,
            &headers,
            json!({"name": "tenant-a", "preset": "user"}),
        )
        .await;
        let id = created["id"].as_str().unwrap().to_string();
        let (foreign, _) = foreign_owner(&state);
        for (method, body) in [
            ("GET", None),
            ("PATCH", Some(json!({"name": "stolen"}))),
            ("DELETE", None),
        ] {
            let (status, response) = call(
                &state,
                method,
                &format!("/api/v1/certmgr/policies/{id}"),
                &foreign,
                body,
            )
            .await;
            assert_eq!(status, StatusCode::NOT_FOUND, "{method}: {response}");
            assert_eq!(response["error"], json!("not_found"));
        }
        // And the original is untouched.
        let (status, still_there) = call(
            &state,
            "GET",
            &format!("/api/v1/certmgr/policies/{id}"),
            &headers,
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{still_there}");
        assert_eq!(still_there["name"], json!("tenant-a"));
    }

    #[tokio::test]
    async fn adversarial_unknown_body_fields_are_rejected() {
        let state = state().await;
        let headers = owner(&state);
        let (status, body) = call(
            &state,
            "POST",
            "/api/v1/certmgr/policies",
            &headers,
            Some(json!({"name": "sneaky", "organization_id": "org:other"})),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        // Nested documents are `deny_unknown_fields` too.
        let (status, body) = call(
            &state,
            "POST",
            "/api/v1/certmgr/policies",
            &headers,
            Some(json!({"name": "sneaky-2", "rules": {"subject": {"cn": {"mode": "allow", "values": [], "extra": 1}}}})),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    }

    #[tokio::test]
    async fn adversarial_an_unknown_preset_or_enum_value_is_a_client_error() {
        let state = state().await;
        let headers = owner(&state);
        for body in [
            json!({"name": "bad-preset", "preset": "kitchen_sink"}),
            json!({"name": "bad-alg", "rules": {"key_algorithms": {"mode": "allow", "allowed": ["rsa-1024"]}}}),
            json!({"name": "bad-mode", "rules": {"subject": {"cn": {"mode": "maybe"}}}}),
            json!({"name": ""}),
            json!({"name": "x", "rules": ["not", "an", "object"]}),
        ] {
            let (status, response) = call(
                &state,
                "POST",
                "/api/v1/certmgr/policies",
                &headers,
                Some(body),
            )
            .await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{response}");
        }
    }

    #[tokio::test]
    async fn adversarial_a_duplicate_policy_name_is_a_clean_conflict() {
        let state = state().await;
        let headers = owner(&state);
        create_policy(&state, &headers, json!({"name": "twice", "preset": "user"})).await;
        let (status, body) = call(
            &state,
            "POST",
            "/api/v1/certmgr/policies",
            &headers,
            Some(json!({"name": "twice", "preset": "user"})),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT, "{body}");
    }

    #[tokio::test]
    async fn adversarial_deleting_a_policy_a_profile_still_uses_is_refused() {
        let state = state().await;
        let headers = owner(&state);
        let policy = create_policy(
            &state,
            &headers,
            json!({"name": "referenced", "preset": "tls_client"}),
        )
        .await;
        let policy_id = policy["id"].as_str().unwrap().to_string();
        let (status, profile) = call(
            &state,
            "POST",
            "/api/v1/certmgr/profiles",
            &headers,
            Some(json!({
                "name": "uses-referenced",
                "issuer_type": "self_signed",
                "policy_id": policy_id,
            })),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "{profile}");

        let (status, refused) = call(
            &state,
            "DELETE",
            &format!("/api/v1/certmgr/policies/{policy_id}"),
            &headers,
            None,
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT, "{refused}");
        assert_eq!(refused["error"], json!("policy_in_use"));
        assert!(
            refused["hint"].as_str().unwrap().starts_with("1 profile"),
            "the hint must name the referrer count: {refused}"
        );

        // Remove the referrer and the delete goes through — nothing cascaded.
        let (status, _) = call(
            &state,
            "DELETE",
            &format!(
                "/api/v1/certmgr/profiles/{}",
                profile["id"].as_str().unwrap()
            ),
            &headers,
            None,
        )
        .await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        let (status, _) = call(
            &state,
            "DELETE",
            &format!("/api/v1/certmgr/policies/{policy_id}"),
            &headers,
            None,
        )
        .await;
        assert_eq!(status, StatusCode::NO_CONTENT);
    }

    // —— chaos ——————————————————————————————————————————————————————

    #[tokio::test]
    async fn chaos_oversized_deeply_nested_and_absurd_documents_degrade_cleanly() {
        let state = state().await;
        let headers = owner(&state);

        // A rules document a mebibyte long.
        let huge: String = "a".repeat(1024 * 1024);
        let (status, body) = call_raw(
            &state,
            "POST",
            "/api/v1/certmgr/policies",
            &headers,
            Some(json!({"name": "huge", "rules": {"subject": {"cn": {"mode": "allow", "values": [huge]}}}}).to_string()),
        )
        .await;
        assert!(status.is_client_error(), "{status}: {body}");

        // Ten thousand entries in one field rule: past the body limit.
        let many: Vec<String> = (0..10_000).map(|i| format!("h{i}.example.com")).collect();
        let (status, body) = call_raw(
            &state,
            "POST",
            "/api/v1/certmgr/policies",
            &headers,
            Some(json!({"name": "many", "rules": {"san": {"dns": {"mode": "allow", "values": many}}}}).to_string()),
        )
        .await;
        assert!(status.is_client_error(), "{status}: {body}");

        // A list that fits the body limit but exceeds the per-rule cap.
        let over_cap: Vec<String> = (0..=MAX_RULE_VALUES).map(|i| format!("d{i}")).collect();
        let (status, body) = call(
            &state,
            "POST",
            "/api/v1/certmgr/policies",
            &headers,
            Some(json!({"name": "over-cap", "rules": {"san": {"dns": {"mode": "allow", "values": over_cap}}}})),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");

        // Deeply nested JSON.
        let mut nested = String::new();
        for _ in 0..2_000 {
            nested.push_str("{\"subject\":");
        }
        let (status, body) = call_raw(
            &state,
            "POST",
            "/api/v1/certmgr/policies",
            &headers,
            Some(format!("{{\"name\":\"nested\",\"rules\":{nested}null}}")),
        )
        .await;
        assert!(status.is_client_error(), "{status}: {body}");

        // `u64::MAX` seconds of validity: a 400, never an overflow or a
        // database constraint failure.
        let (status, body) = call_raw(
            &state,
            "POST",
            "/api/v1/certmgr/policies",
            &headers,
            Some(format!(
                "{{\"name\":\"forever\",\"max_validity_seconds\":{}}}",
                u64::MAX
            )),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert_eq!(body["error"], json!("invalid_request"));
    }

    #[tokio::test]
    async fn chaos_concurrent_patches_surface_one_winner_and_one_clean_conflict() {
        let state = state().await;
        let headers = owner(&state);
        let created = create_policy(
            &state,
            &headers,
            json!({"name": "raced", "preset": "device"}),
        )
        .await;
        let id = created["id"].as_str().unwrap().to_string();

        // Both writers hold version 1; the compare-and-swap admits exactly one.
        let path = format!("/api/v1/certmgr/policies/{id}");
        let first = call(
            &state,
            "PATCH",
            &path,
            &headers,
            Some(json!({"version": 1, "description": "writer-a"})),
        );
        let second = call(
            &state,
            "PATCH",
            &path,
            &headers,
            Some(json!({"version": 1, "description": "writer-b"})),
        );
        let ((first_status, first_body), (second_status, second_body)) =
            tokio::join!(first, second);
        let statuses = [first_status, second_status];
        assert!(
            statuses.contains(&StatusCode::OK),
            "one writer must win: {first_body} / {second_body}"
        );
        assert!(
            statuses.contains(&StatusCode::CONFLICT),
            "the loser must get a clean 409: {first_body} / {second_body}"
        );
        for status in statuses {
            assert!(!status.is_server_error(), "{status}");
        }

        // No lost update: the surviving row carries exactly one writer's text.
        let (_, final_state) = call(
            &state,
            "GET",
            &format!("/api/v1/certmgr/policies/{id}"),
            &headers,
            None,
        )
        .await;
        assert_eq!(final_state["version"], json!(2));
        let description = final_state["description"].as_str().unwrap();
        assert!(
            description == "writer-a" || description == "writer-b",
            "{final_state}"
        );
    }

    // —— snapshot (insta) ————————————————————————————————————————————

    #[tokio::test]
    #[expect(
        clippy::too_many_lines,
        reason = "the value of this test is the full inline snapshot of the preset-seeded rules document"
    )]
    async fn snapshot_policy_create_get_and_list_wire_shapes_are_pinned() {
        let state = state().await;
        let headers = owner(&state);
        let created = create_policy(
            &state,
            &headers,
            json!({
                "name": "edge-tls",
                "description": "Edge TLS server certificates",
                "preset": "tls_server",
                "max_validity_seconds": 7_776_000_u64,
            }),
        )
        .await;
        insta::assert_json_snapshot!(created, {
            ".id" => "[id]",
            ".created_at" => "[timestamp]",
            ".updated_at" => "[timestamp]",
        }, @r###"
        {
          "created_at": "[timestamp]",
          "description": "Edge TLS server certificates",
          "id": "[id]",
          "max_validity_seconds": 7776000,
          "name": "edge-tls",
          "preset": "tls_server",
          "rules": {
            "basic_constraints": {
              "ca": "forbid"
            },
            "ext_key_usages": {
              "allowed": [
                "server_auth"
              ],
              "mode": "require",
              "required": [
                "server_auth"
              ]
            },
            "key_algorithms": {
              "allowed": [
                "rsa-2048",
                "rsa-4096",
                "ecdsa-p256",
                "ecdsa-p384"
              ],
              "mode": "allow",
              "required": []
            },
            "key_usages": {
              "allowed": [
                "digital_signature",
                "key_encipherment",
                "key_agreement"
              ],
              "mode": "require",
              "required": [
                "digital_signature"
              ]
            },
            "san": {
              "dns": {
                "mode": "require",
                "values": []
              },
              "email": {
                "mode": "unset",
                "values": []
              },
              "ip": {
                "mode": "unset",
                "values": []
              },
              "upn": {
                "mode": "unset",
                "values": []
              },
              "uri": {
                "mode": "unset",
                "values": []
              }
            },
            "signature_algorithms": {
              "allowed": [
                "sha256-rsa",
                "sha384-rsa",
                "sha256-ecdsa",
                "sha384-ecdsa"
              ],
              "mode": "allow",
              "required": []
            },
            "subject": {
              "c": {
                "mode": "unset",
                "values": []
              },
              "cn": {
                "mode": "unset",
                "values": []
              },
              "dc": {
                "components": [],
                "mode": "unset"
              },
              "l": {
                "mode": "unset",
                "values": []
              },
              "o": {
                "mode": "unset",
                "values": []
              },
              "ou": {
                "mode": "unset",
                "values": []
              },
              "st": {
                "mode": "unset",
                "values": []
              }
            }
          },
          "updated_at": "[timestamp]",
          "version": 1
        }
        "###);

        let (_, fetched) = call(
            &state,
            "GET",
            &format!(
                "/api/v1/certmgr/policies/{}",
                created["id"].as_str().unwrap()
            ),
            &headers,
            None,
        )
        .await;
        assert_eq!(
            fetched, created,
            "GET must project exactly what POST returned"
        );

        let (_, listed) = call(&state, "GET", "/api/v1/certmgr/policies", &headers, None).await;
        insta::assert_json_snapshot!(listed, {
            ".policies[].id" => "[id]",
            ".policies[].created_at" => "[timestamp]",
            ".policies[].updated_at" => "[timestamp]",
            ".policies[].rules" => "[rules]",
        }, @r###"
        {
          "policies": [
            {
              "created_at": "[timestamp]",
              "description": "Edge TLS server certificates",
              "id": "[id]",
              "max_validity_seconds": 7776000,
              "name": "edge-tls",
              "preset": "tls_server",
              "rules": "[rules]",
              "updated_at": "[timestamp]",
              "version": 1
            }
          ]
        }
        "###);
    }

    #[tokio::test]
    async fn snapshot_policy_error_bodies_are_pinned() {
        let state = state().await;
        let member_headers = member(&state);
        let (_, forbidden) = call(
            &state,
            "GET",
            "/api/v1/certmgr/policies",
            &member_headers,
            None,
        )
        .await;
        insta::assert_json_snapshot!(forbidden, @r###"
        {
          "error": "forbidden",
          "hint": "owner or admin role required to configure certificate policies"
        }
        "###);

        let headers = owner(&state);
        let (_, missing) = call(
            &state,
            "GET",
            "/api/v1/certmgr/policies/certificate-policy:absent",
            &headers,
            None,
        )
        .await;
        insta::assert_json_snapshot!(missing, @r###"
        {
          "error": "not_found",
          "hint": "no such certificate policy"
        }
        "###);
    }

    // —— property ————————————————————————————————————————————————————

    fn field_rule_strategy() -> impl Strategy<Value = FieldRule> {
        (
            prop::sample::select(RuleMode::ALL),
            prop::collection::vec("[a-z*.]{1,12}", 0..4),
        )
            .prop_map(|(mode, values)| FieldRule { mode, values })
    }

    fn constraint_strategy<T: Clone + std::fmt::Debug + 'static>(
        all: &'static [T],
    ) -> impl Strategy<Value = Constraint<T>> {
        (
            prop::sample::select(ConstraintMode::ALL),
            prop::collection::vec(prop::sample::select(all), 0..3),
            prop::collection::vec(prop::sample::select(all), 0..3),
        )
            .prop_map(|(mode, allowed, required)| Constraint {
                mode,
                allowed,
                required,
            })
    }

    fn policy_rules_strategy() -> impl Strategy<Value = PolicyRules> {
        (
            (
                field_rule_strategy(),
                field_rule_strategy(),
                field_rule_strategy(),
                prop::collection::vec("[a-z*]{1,6}", 0..3),
                prop::sample::select(RuleMode::ALL),
            ),
            (
                field_rule_strategy(),
                field_rule_strategy(),
                field_rule_strategy(),
            ),
            constraint_strategy(SignatureAlgorithm::ALL),
            constraint_strategy(KeyAlgorithm::ALL),
            constraint_strategy(KeyUsage::ALL),
            constraint_strategy(ExtendedKeyUsage::ALL),
            (prop::sample::select(CaRule::ALL), prop::option::of(0u8..8)),
        )
            .prop_map(
                |(
                    (cn, o, ou, dc_components, dc_mode),
                    (dns, ip, email),
                    signature_algorithms,
                    key_algorithms,
                    key_usages,
                    ext_key_usages,
                    (ca, max_path_len),
                )| PolicyRules {
                    subject: SubjectRules {
                        cn,
                        o,
                        ou,
                        dc: DcRule {
                            mode: dc_mode,
                            components: dc_components,
                        },
                        ..SubjectRules::default()
                    },
                    san: SanRules {
                        dns,
                        ip,
                        email,
                        ..SanRules::default()
                    },
                    signature_algorithms,
                    key_algorithms,
                    key_usages,
                    ext_key_usages,
                    basic_constraints: BasicConstraintRule { ca, max_path_len },
                },
            )
    }

    #[test]
    fn property_any_rules_document_survives_create_then_get_unchanged() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let (state, headers) = runtime.block_on(async {
            let state = state().await;
            let headers = owner(&state);
            (state, headers)
        });
        let counter = std::sync::atomic::AtomicUsize::new(0);
        proptest::proptest!(
            ProptestConfig::with_cases(24),
            |(rules in policy_rules_strategy())| {
                let index = counter.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                let read_back = runtime.block_on(async {
                    let (status, created) = call(
                        &state,
                        "POST",
                        "/api/v1/certmgr/policies",
                        &headers,
                        Some(json!({"name": format!("prop-{index}"), "rules": rules})),
                    )
                    .await;
                    assert_eq!(status, StatusCode::CREATED, "{created}");
                    let (status, fetched) = call(
                        &state,
                        "GET",
                        &format!("/api/v1/certmgr/policies/{}", created["id"].as_str().unwrap()),
                        &headers,
                        None,
                    )
                    .await;
                    assert_eq!(status, StatusCode::OK, "{fetched}");
                    serde_json::from_value::<PolicyRules>(fetched["rules"].clone()).unwrap()
                });
                prop_assert_eq!(read_back, rules);
            }
        );
    }

    #[test]
    fn property_no_request_body_whatsoever_produces_a_server_error() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let (state, headers) = runtime.block_on(async {
            let state = state().await;
            let headers = owner(&state);
            (state, headers)
        });
        let leaf = prop_oneof![
            Just(Value::Null),
            any::<bool>().prop_map(Value::Bool),
            any::<i32>().prop_map(|n| json!(n)),
            "[ -~]{0,24}".prop_map(Value::String),
        ];
        let arbitrary = leaf.prop_recursive(4, 32, 4, |inner| {
            prop_oneof![
                prop::collection::vec(inner.clone(), 0..4).prop_map(Value::Array),
                prop::collection::hash_map("[a-z_]{1,10}", inner, 0..4)
                    .prop_map(|map| Value::Object(map.into_iter().collect())),
            ]
        });
        proptest::proptest!(
            ProptestConfig::with_cases(48),
            |(body in arbitrary)| {
                let statuses = runtime.block_on(async {
                    let (create_status, _) =
                        call(&state, "POST", "/api/v1/certmgr/policies", &headers, Some(body.clone()))
                            .await;
                    let (patch_status, _) = call(
                        &state,
                        "PATCH",
                        "/api/v1/certmgr/policies/certificate-policy:absent",
                        &headers,
                        Some(body.clone()),
                    )
                    .await;
                    [create_status, patch_status]
                });
                for status in statuses {
                    prop_assert!(!status.is_server_error(), "{status} for {body}");
                }
            }
        );
    }
}
