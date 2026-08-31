//! Expiry lifecycle hook routes (ADR 0074).
//!
//! Four surfaces, all metadata-only:
//!
//! - `GET /api/v1/lifecycle/expiring` — what is tracked and when each rung
//!   will fire. The "before you register a hook, what would I get?" view.
//! - `GET|PUT|DELETE /api/v1/lifecycle/hooks` — subscriptions. Registering
//!   returns the `whsec_` signing secret **once**; it is sealed at rest and
//!   never readable again, so a caller that loses it rotates the hook rather
//!   than reading it back.
//! - `GET /api/v1/lifecycle/deliveries` — the outbound ledger, so a broken
//!   endpoint is visible without reading gateway logs.
//! - `POST /api/v1/lifecycle/scan` — run a pass now. Same code path as the
//!   tick, so a tool can drive the feed deterministically.
//!
//! Subscription management is an integration-configuration surface: owner or
//! admin sessions, or the operator — the same gate as sync targets and
//! rotation policies. A hook is standing authority to receive a stream about
//! an organization's secrets' *timing*, which is not something any session
//! should be able to point at an endpoint of its choosing.

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use chrono::Utc;
use opensesame_agent_events::AGENT_EVENT_TYPES;
use opensesame_breach_intel::{BreachSubjectKind, BREACH_EVENT_TYPES};
use opensesame_connection_broker::crypto::seal_scoped;
use opensesame_lifecycle::{
    ExpiryStage, ExpirySubject, SubjectKind, Track, LIFECYCLE_EVENT_TYPES, MAX_DETAIL_CHARS,
};
use opensesame_security_events::{filter, Delivery, Severity};
use opensesame_storage::{
    SealedCertificateMaterial, StoredSecurityHook, SECURITY_HOOK_SECRET_SCOPE,
};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::app_state::AppState;
use crate::lifecycle::{responders, scanner};
use crate::middleware::auth::{resolve_caller, resolve_caller_organization, Caller};
use crate::security::delivery;

/// Sealing key id recorded on a hook's sealed secret column group.
const KEY_ID: &str = "connection-seal-v1";
/// Longest hook name accepted.
const MAX_NAME_CHARS: usize = 120;
/// Longest endpoint URL accepted.
const MAX_ENDPOINT_CHARS: usize = 2_048;
/// Longest caller-supplied sink secret accepted — a routing key or a bearer.
const MAX_SECRET_CHARS: usize = 1_024;
/// Deliveries returned by the ledger route without an explicit limit.
const DEFAULT_DELIVERY_LIMIT: usize = 50;

#[allow(clippy::result_large_err)]
fn authorize_read(st: &AppState, headers: &axum::http::HeaderMap) -> Result<Caller, Response> {
    resolve_caller(st, headers)
}

/// Subscriptions are integration configuration: owner/admin or the operator.
#[allow(clippy::result_large_err)]
fn authorize_configure(st: &AppState, headers: &axum::http::HeaderMap) -> Result<Caller, Response> {
    let who = resolve_caller(st, headers)?;
    if !who.can_configure_integrations() {
        return Err(forbidden(
            "owner or admin role required to configure lifecycle hooks",
        ));
    }
    Ok(who)
}

fn forbidden(hint: &str) -> Response {
    (
        StatusCode::FORBIDDEN,
        Json(json!({"error": "forbidden", "hint": hint})),
    )
        .into_response()
}

fn bad_request(hint: &str) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({"error": "invalid_request", "hint": hint})),
    )
        .into_response()
}

fn internal(error: &anyhow::Error, context: &'static str) -> Response {
    tracing::warn!(%error, context, "lifecycle route failed");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({"error": "internal", "hint": context})),
    )
        .into_response()
}

/// Public view of a subscription. The sealed signing secret is not a field:
/// it is write-once at registration and never rendered again.
fn hook_view(hook: &StoredSecurityHook) -> Value {
    json!({
        "id": hook.id,
        "name": hook.name,
        "organization_id": hook.organization_id,
        "event_types": hook.event_types,
        "delivery": hook.delivery,
        "endpoint_url": hook.endpoint_url,
        "responder": hook.responder,
        "subject_kinds": hook.subject_kinds,
        "severity_min": hook.severity_min,
        "enabled": hook.enabled,
        "last_delivered_at": hook.last_delivered_at,
        "last_error": hook.last_error,
        "version": hook.version,
        "created_at": hook.created_at,
        "updated_at": hook.updated_at,
        "secrets_returned": false,
    })
}

/// Public view of a tracked deadline, including where it sits on each ladder.
fn subject_view(subject: &ExpirySubject, now: chrono::DateTime<Utc>) -> Value {
    let renew_before = subject.renew_before();
    let remaining = subject.remaining_seconds(now);
    let mut next: Vec<Value> = Vec::new();
    for track in Track::ALL {
        if track == Track::Alert && !subject.alerting {
            continue;
        }
        for stage in opensesame_lifecycle::ladder(track, renew_before) {
            let threshold = stage.threshold_seconds(renew_before);
            next.push(json!({
                "stage": stage.as_str(),
                "track": track.as_str(),
                "event_type": opensesame_lifecycle::event_type_for_stage(stage),
                // Checked: a sentinel deadline near the start of the
                // representable range has no room to subtract a threshold
                // from, and an undated rung is better than a panicking route.
                "fires_at": subject
                    .expires_at
                    .checked_sub_signed(chrono::Duration::seconds(threshold))
                    .map(|at| at.to_rfc3339()),
                "crossed": remaining <= threshold,
            }));
        }
    }
    json!({
        "subject_kind": subject.kind.as_str(),
        "subject_id": subject.subject_id,
        "organization_id": subject.organization_id,
        "label": subject.label,
        "expires_at": subject.expires_at.to_rfc3339(),
        "remaining_seconds": remaining,
        "renew_before_seconds": renew_before,
        "auto_respond": subject.auto_respond,
        "responder": responders::responder_for(subject.kind),
        "alerting": subject.alerting,
        "ladder": next,
        "secrets_returned": false,
    })
}

/// `GET /api/v1/lifecycle/expiring` — every tracked deadline and its ladder.
pub async fn list_expiring(State(st): State<AppState>, headers: axum::http::HeaderMap) -> Response {
    let who = match authorize_read(&st, &headers) {
        Ok(who) => who,
        Err(response) => return response,
    };
    let organization_id = match resolve_caller_organization(&st, &who, &headers) {
        Ok(id) => id,
        Err(response) => return response,
    };
    let now = Utc::now();
    let subjects = scanner::inventory(&st, &organization_id, now).await;
    Json(json!({
        "subjects": subjects
            .iter()
            .map(|subject| subject_view(subject, now))
            .collect::<Vec<_>>(),
        "event_types": known_event_types(),
        "subject_kinds": SubjectKind::ALL.map(SubjectKind::as_str),
        "stages": ExpiryStage::ALL.map(ExpiryStage::as_str),
        "secrets_returned": false,
    }))
    .into_response()
}

/// `GET /api/v1/lifecycle/hooks` — registered subscriptions.
pub async fn list_hooks(State(st): State<AppState>, headers: axum::http::HeaderMap) -> Response {
    let who = match authorize_configure(&st, &headers) {
        Ok(who) => who,
        Err(response) => return response,
    };
    let organization_id = match resolve_caller_organization(&st, &who, &headers) {
        Ok(id) => id,
        Err(response) => return response,
    };
    match st
        .db
        .list_security_hooks(&organization_id.to_string())
        .await
    {
        Ok(hooks) => Json(json!({
            "hooks": hooks.iter().map(hook_view).collect::<Vec<_>>(),
            "secrets_returned": false,
        }))
        .into_response(),
        Err(error) => internal(&error, "list lifecycle hooks"),
    }
}

/// Every event name a subscription may filter on, across every family.
///
/// The union is assembled here rather than in either detector: a family owns
/// its own frozen names, and the *registration* surface is the only place that
/// needs to know about all of them at once.
#[must_use]
fn known_event_types() -> Vec<&'static str> {
    LIFECYCLE_EVENT_TYPES
        .iter()
        .copied()
        .chain(BREACH_EVENT_TYPES.iter().copied())
        .chain(AGENT_EVENT_TYPES.iter().copied())
        .collect()
}

/// Whether a subject-kind filter names something some family actually reports.
#[must_use]
fn is_known_subject_kind(kind: &str) -> bool {
    SubjectKind::parse(kind).is_some() || BreachSubjectKind::parse(kind).is_some()
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HookBody {
    /// Stable id. Omit to create; supply to edit in place.
    pub id: Option<String>,
    pub name: String,
    /// Frozen event types from any family, or a family wildcard
    /// (`lifecycle.*`, `breach.*`, `*`).
    pub event_types: Vec<String>,
    /// Absolute `https://` endpoint the sink is delivered to.
    pub endpoint_url: String,
    /// `webhook` (default), `alertmanager`, or `pagerduty`. `internal` is
    /// refused: a platform subscriber runs in process and is seeded by the
    /// gateway, never registered over the API.
    pub delivery: Option<String>,
    /// Optional narrowing to particular subject kinds.
    pub subject_kinds: Option<Vec<String>>,
    /// Severity floor: `info` (default), `warning`, `error`, or `critical`.
    pub severity_min: Option<String>,
    /// Sink material supplied by the caller rather than minted — a `PagerDuty`
    /// routing key, or a bearer token for an authenticating Alertmanager
    /// proxy. Sealed on write and never returned.
    pub secret: Option<String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

const fn default_true() -> bool {
    true
}

/// The sink a request selects, refusing the one that cannot be registered.
#[allow(clippy::result_large_err)]
fn requested_delivery(body: &HookBody) -> Result<Delivery, Response> {
    let raw = body.delivery.as_deref().unwrap_or("webhook");
    match Delivery::parse(raw) {
        Some(Delivery::Internal) | None => Err(bad_request(
            "delivery must be one of webhook, alertmanager, pagerduty, a2h",
        )),
        Some(kind) => Ok(kind),
    }
}

/// The severity floor a registration gets when it names none.
///
/// `Info` for every sink that talks to a system, because taking everything and
/// filtering downstream is what a webhook subscriber or an Alertmanager
/// routing tree is for. `Error` for A2H, because that one wakes a *person*:
/// registering it should not sign somebody up for a text every time an agent
/// takes a page, and the two phases at `Error` are exactly the ones that leave
/// a rotation not done.
///
/// An operator who wants the quiet ones says `severity_min: "info"` and gets
/// them. This is a default, not a second policy — which is the point, because
/// `opensesame_a2h::intent_for` deliberately has no opinion about it.
const fn default_floor_for(kind: Delivery) -> Severity {
    match kind {
        Delivery::A2h => Severity::Error,
        _ => Severity::Info,
    }
}

/// The severity floor a request selects.
#[allow(clippy::result_large_err)]
fn requested_floor(body: &HookBody, kind: Delivery) -> Result<Severity, Response> {
    let Some(raw) = body.severity_min.as_deref() else {
        return Ok(default_floor_for(kind));
    };
    Severity::parse(raw)
        .ok_or_else(|| bad_request("severity_min must be info, warning, error, or critical"))
}

/// Validate a subscription request before anything is written.
///
/// Split out of [`put_hook`] so the handler reads as the sequence it is —
/// validate, load, seal, write — rather than as one long funnel.
#[allow(clippy::result_large_err)]
fn validate_hook_body(body: &HookBody) -> Result<(), Response> {
    let name = body.name.trim();
    if name.is_empty() || name.chars().count() > MAX_NAME_CHARS {
        return Err(bad_request("name must be 1..=120 characters"));
    }
    if !filter::is_valid(&body.event_types, &known_event_types()) {
        return Err(bad_request(
            "event_types must be a non-empty list of known event types or a family wildcard (\"lifecycle.*\", \"breach.*\", \"agent.*\", \"*\")",
        ));
    }
    if let Some(kinds) = &body.subject_kinds {
        if kinds.is_empty() {
            return Err(bad_request("subject_kinds must be omitted or non-empty"));
        }
        if let Some(unknown) = kinds.iter().find(|kind| !is_known_subject_kind(kind)) {
            return Err(bad_request(&format!("unknown subject kind \"{unknown}\"")));
        }
    }
    let endpoint = body.endpoint_url.trim();
    if endpoint.chars().count() > MAX_ENDPOINT_CHARS {
        return Err(bad_request("endpoint_url is too long"));
    }
    // An A2H hook has somebody to reach, and only the agent family names one.
    // A subscription that could never render an intent is one that looks
    // configured and silently sends nothing — refuse it while a person is here
    // to fix it, rather than dead-lettering rows at 04:00.
    if body.delivery.as_deref() == Some(Delivery::A2h.as_str())
        && !AGENT_EVENT_TYPES
            .iter()
            .any(|event| filter::matches(&body.event_types, event))
    {
        return Err(bad_request(
            "an a2h subscription must name at least one agent event type or \"agent.*\": \
             only an agent run names the person to reach",
        ));
    }
    // Bounded like every other field on this body. A routing key is tens of
    // characters; anything near this cap is a mistake, and sealing an
    // unbounded one wastes a column on it forever.
    if let Some(secret) = &body.secret {
        if secret.trim().chars().count() > MAX_SECRET_CHARS {
            return Err(bad_request("secret is too long"));
        }
    }
    if let Err(hint) = delivery::assert_deliverable(endpoint) {
        return Err(bad_request(&hint));
    }
    Ok(())
}

/// The sealed secret and the one-time reveal for a newly registered hook.
type MintedSecret = (Option<SealedCertificateMaterial>, Option<(String, String)>);

/// Seal a hook's material under the hook's own identity.
///
/// Two shapes, one path. A `webhook` mints a `whsec_` signing secret we
/// generate; an alerting sink seals whatever the caller supplied — a
/// `PagerDuty` routing key, or a bearer for an Alertmanager behind a proxy.
/// Either way the plaintext is returned to be shown exactly once, and no route
/// ever reads it back out of the column.
///
/// A sink that requires material and was given none is refused here rather
/// than at delivery time: a hook that can never deliver is a subscription an
/// operator believes they have.
#[allow(clippy::result_large_err)]
fn mint_hook_secret(
    st: &AppState,
    organization: &str,
    requested_id: Option<&str>,
    kind: Delivery,
    supplied: Option<&str>,
) -> Result<MintedSecret, Response> {
    let secret = match supplied.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => value.to_string(),
        None if kind.requires_secret() && kind != Delivery::Webhook => {
            return Err(bad_request(&format!(
                "delivery \"{}\" requires `secret` (its routing key)",
                kind.as_str(),
            )));
        }
        None if !kind.requires_secret() => return Ok((None, None)),
        None => delivery::generate_secret(),
    };
    let id_for_seal =
        requested_id.map_or_else(|| format!("sech_{}", uuid::Uuid::now_v7()), str::to_string);
    let Some(key) = st.connection_broker.config().key().copied() else {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({
                "error": "sealing_unavailable",
                "hint": "a sealing key is required to register a hook that carries secret material",
            })),
        )
            .into_response());
    };
    let blob = seal_scoped(
        &key,
        SECURITY_HOOK_SECRET_SCOPE,
        &id_for_seal,
        organization,
        secret.as_bytes(),
    )
    .map_err(|error| internal(&anyhow::anyhow!("{error}"), "seal lifecycle hook secret"))?;
    Ok((
        Some(SealedCertificateMaterial {
            key_id: KEY_ID.into(),
            ciphertext: blob.ciphertext,
            nonce: blob.nonce,
            aad_digest: blob.aad_digest,
        }),
        Some((id_for_seal, secret)),
    ))
}

/// `PUT /api/v1/lifecycle/hooks` — register or edit a subscription.
///
/// A new registration mints a `whsec_` secret and returns it **once**. An edit
/// keeps the existing secret: rotating it is a delete and re-register, so a
/// caller cannot silently invalidate every receiver's verification by editing
/// a name.
pub async fn put_hook(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(body): Json<HookBody>,
) -> Response {
    let who = match authorize_configure(&st, &headers) {
        Ok(who) => who,
        Err(response) => return response,
    };
    let organization_id = match resolve_caller_organization(&st, &who, &headers) {
        Ok(id) => id,
        Err(response) => return response,
    };
    let organization = organization_id.to_string();
    if let Err(response) = validate_hook_body(&body) {
        return response;
    }
    let kind = match requested_delivery(&body) {
        Ok(kind) => kind,
        Err(response) => return response,
    };
    let floor = match requested_floor(&body, kind) {
        Ok(floor) => floor,
        Err(response) => return response,
    };
    let name = body.name.trim();
    let endpoint = body.endpoint_url.trim();

    let existing = match &body.id {
        Some(id) => match st.db.get_security_hook(&organization, id).await {
            Ok(found) => found,
            Err(error) => return internal(&error, "read lifecycle hook"),
        },
        None => None,
    };
    if body.id.is_some() && existing.is_none() {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({"error": "not_found", "hint": "no such lifecycle hook"})),
        )
            .into_response();
    }
    // An internal row cannot be *created* over this API, so it must not be
    // overwritable through it either. Without this, a PUT carrying a built-in
    // subscriber's id would rewrite it into a webhook — and because seeding
    // only ever inserts, the row's continued existence would stop it being
    // restored. Turning a built-in off is `enabled: false`, not a rewrite.
    if existing
        .as_ref()
        .is_some_and(|hook| hook.delivery == Delivery::Internal.as_str())
    {
        return bad_request(
            "this subscription is a platform responder; disable it with enabled=false rather than rewriting it",
        );
    }

    // An existing hook keeps its secret; a new one seals and reveals one once.
    let (sealed_secret, revealed) = if let Some(hook) = &existing {
        (hook.sealed_secret.clone(), None)
    } else {
        match mint_hook_secret(
            &st,
            &organization,
            body.id.as_deref(),
            kind,
            body.secret.as_deref(),
        ) {
            Ok(minted) => minted,
            Err(response) => return response,
        }
    };

    let now = Utc::now().to_rfc3339();
    let id = revealed
        .as_ref()
        .map_or_else(|| body.id.clone().unwrap_or_default(), |(id, _)| id.clone());
    let hook = StoredSecurityHook {
        id: id.clone(),
        organization_id: organization.clone(),
        name: name.to_string(),
        event_types: body.event_types.clone(),
        delivery: kind.as_str().to_string(),
        endpoint_url: Some(endpoint.to_string()),
        responder: None,
        subject_kinds: body.subject_kinds.clone(),
        severity_min: floor.as_str().to_string(),
        enabled: body.enabled,
        sealed_secret,
        last_delivered_at: existing.as_ref().and_then(|h| h.last_delivered_at.clone()),
        last_error: existing.as_ref().and_then(|h| h.last_error.clone()),
        version: existing.as_ref().map_or(1, |h| h.version),
        created_at: existing
            .as_ref()
            .map_or_else(|| now.clone(), |h| h.created_at.clone()),
        updated_at: now,
    };
    if let Err(error) = st.db.upsert_security_hook(&hook).await {
        return internal(&error, "write lifecycle hook");
    }

    let mut view = hook_view(&hook);
    if let (Some(object), Some((_, secret))) = (view.as_object_mut(), revealed) {
        // Shown once. The column holds ciphertext and no route reads it back,
        // so losing it means re-registering rather than recovering it.
        object.insert("signing_secret".into(), json!(secret));
        object.insert(
            "signing_secret_hint".into(),
            json!(match kind {
                Delivery::Webhook => "shown once; verify with any Standard Webhooks library",
                _ => "shown once; sealed at rest and never returned again",
            }),
        );
    }
    (StatusCode::OK, Json(view)).into_response()
}

/// `DELETE /api/v1/lifecycle/hooks/{id}` — remove a subscription and its
/// queued deliveries.
pub async fn delete_hook(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let who = match authorize_configure(&st, &headers) {
        Ok(who) => who,
        Err(response) => return response,
    };
    let organization_id = match resolve_caller_organization(&st, &who, &headers) {
        Ok(id) => id,
        Err(response) => return response,
    };
    match st
        .db
        .delete_security_hook(&organization_id.to_string(), &id)
        .await
    {
        Ok(true) => (StatusCode::OK, Json(json!({"deleted": true}))).into_response(),
        Ok(false) => (
            StatusCode::NOT_FOUND,
            Json(json!({"error": "not_found", "hint": "no such lifecycle hook"})),
        )
            .into_response(),
        Err(error) => internal(&error, "delete lifecycle hook"),
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeliveryQuery {
    pub limit: Option<usize>,
}

/// `GET /api/v1/lifecycle/deliveries` — the outbound ledger.
pub async fn list_deliveries(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Query(query): Query<DeliveryQuery>,
) -> Response {
    let who = match authorize_configure(&st, &headers) {
        Ok(who) => who,
        Err(response) => return response,
    };
    let organization_id = match resolve_caller_organization(&st, &who, &headers) {
        Ok(id) => id,
        Err(response) => return response,
    };
    let limit = query.limit.unwrap_or(DEFAULT_DELIVERY_LIMIT);
    match st
        .db
        .list_security_deliveries(&organization_id.to_string(), limit)
        .await
    {
        Ok(deliveries) => Json(json!({
            "deliveries": deliveries
                .iter()
                .map(|row| json!({
                    "id": row.id,
                    "hook_id": row.hook_id,
                    "event_type": row.event_type,
                    "subject_kind": row.subject_kind,
                    "subject_id": row.subject_id,
                    "state": row.state,
                    "attempts": row.attempts,
                    "available_at": row.available_at,
                    "last_error": row.last_error.as_deref()
                        .map(|error| error.chars().take(MAX_DETAIL_CHARS).collect::<String>()),
                    "delivered_at": row.delivered_at,
                    "created_at": row.created_at,
                }))
                .collect::<Vec<_>>(),
            "secrets_returned": false,
        }))
        .into_response(),
        Err(error) => internal(&error, "list lifecycle deliveries"),
    }
}

/// `POST /api/v1/lifecycle/scan` — run one pass now.
///
/// The same function the tick calls, so a tool can drive the feed rather than
/// waiting a minute for it. Idempotent by construction: the watermarks mean a
/// second scan with nothing new publishes nothing.
pub async fn scan(State(st): State<AppState>, headers: axum::http::HeaderMap) -> Response {
    let who = match authorize_configure(&st, &headers) {
        Ok(who) => who,
        Err(response) => return response,
    };
    let organization_id = match resolve_caller_organization(&st, &who, &headers) {
        Ok(id) => id,
        Err(response) => return response,
    };
    match scanner::scan_organization(&st, &organization_id, Utc::now()).await {
        Ok(published) => Json(json!({
            "published": published,
            "secrets_returned": false,
        }))
        .into_response(),
        Err(error) => internal(&error, "run lifecycle scan"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_state::{test_demo_state, test_session_headers};
    use axum::{
        body::Body,
        http::{Request, StatusCode},
        Router,
    };
    use opensesame_connection_broker::{BrokerConfig, ConnectionBroker};
    use opensesame_domain::OrganizationRole;
    use std::sync::Arc;
    use tower::ServiceExt;

    async fn state_with_seal_key() -> AppState {
        let mut st = test_demo_state().await;
        st.connection_broker = Arc::new(
            ConnectionBroker::new(
                st.db.pool().clone(),
                BrokerConfig::in_memory(Some([42u8; 32]), "http://127.0.0.1:8787"),
            )
            .unwrap(),
        );
        st
    }

    pub(super) async fn send(
        app: &Router,
        headers: &axum::http::HeaderMap,
        method: &str,
        uri: &str,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let mut builder = Request::builder().method(method).uri(uri).header(
            "authorization",
            headers.get("authorization").unwrap().as_bytes(),
        );
        let body = match body {
            Some(json) => {
                builder = builder.header("content-type", "application/json");
                Body::from(json.to_string())
            }
            None => Body::empty(),
        };
        let response = app
            .clone()
            .oneshot(builder.body(body).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let value = if bytes.is_empty() {
            json!({})
        } else {
            serde_json::from_slice(&bytes).unwrap_or_else(|_| json!({}))
        };
        (status, value)
    }

    fn registration() -> Value {
        json!({
            "name": "expiry-watcher",
            "event_types": ["lifecycle.renewal.due", "lifecycle.expiry.expired"],
            "endpoint_url": "https://hooks.example.com/opensesame",
        })
    }

    #[tokio::test]
    async fn registering_reveals_the_signing_secret_exactly_once() {
        let st = state_with_seal_key().await;
        let org = st.connection_organization;
        let admin = test_session_headers(&st, "principal:admin", org, OrganizationRole::Admin);
        let app = crate::routes::router(st.clone());

        let (status, created) = send(
            &app,
            &admin,
            "PUT",
            "/api/v1/lifecycle/hooks",
            Some(registration()),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{created}");
        let secret = created["signing_secret"]
            .as_str()
            .expect("the secret is revealed on registration")
            .to_string();
        assert!(secret.starts_with("whsec_"), "{secret}");
        let id = created["id"].as_str().unwrap().to_string();

        // …and never again, on any route that renders a hook.
        let (status, listed) = send(&app, &admin, "GET", "/api/v1/lifecycle/hooks", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(listed["hooks"].as_array().unwrap().len(), 1);
        assert!(listed["hooks"][0]["signing_secret"].is_null());
        assert!(
            !listed.to_string().contains(&secret),
            "a stored signing secret must never render again",
        );

        // An edit keeps the existing secret rather than silently minting a new
        // one, which would break every receiver's verification.
        let mut edit = registration();
        edit["id"] = json!(id);
        edit["name"] = json!("renamed");
        let (status, edited) =
            send(&app, &admin, "PUT", "/api/v1/lifecycle/hooks", Some(edit)).await;
        assert_eq!(status, StatusCode::OK, "{edited}");
        assert!(
            edited["signing_secret"].is_null(),
            "an edit must not reveal or replace the secret",
        );
        assert_eq!(edited["name"], json!("renamed"));
    }

    #[tokio::test]
    async fn the_stored_secret_is_ciphertext_at_rest() {
        let st = state_with_seal_key().await;
        let org = st.connection_organization;
        let admin = test_session_headers(&st, "principal:admin", org, OrganizationRole::Admin);
        let app = crate::routes::router(st.clone());

        let (_, created) = send(
            &app,
            &admin,
            "PUT",
            "/api/v1/lifecycle/hooks",
            Some(registration()),
        )
        .await;
        let secret = created["signing_secret"].as_str().unwrap().to_string();
        let id = created["id"].as_str().unwrap();

        let stored = st
            .db
            .get_security_hook(&org.to_string(), id)
            .await
            .unwrap()
            .unwrap();
        let material = stored
            .sealed_secret
            .as_ref()
            .expect("a webhook hook is sealed");
        assert!(
            !String::from_utf8_lossy(&material.ciphertext).contains(&secret),
            "the signing secret must not sit in the column in the clear",
        );
        assert!(format!("{stored:?}").contains("[REDACTED]"));
    }

    #[tokio::test]
    async fn a_private_or_plaintext_endpoint_is_refused() {
        let st = state_with_seal_key().await;
        let org = st.connection_organization;
        let admin = test_session_headers(&st, "principal:admin", org, OrganizationRole::Admin);
        let app = crate::routes::router(st.clone());

        for endpoint in [
            "http://hooks.example.com/insecure",
            "https://127.0.0.1/hook",
            "https://169.254.169.254/latest/meta-data",
            "https://user:pass@hooks.example.com/hook",
            "not-a-url",
        ] {
            let mut body = registration();
            body["endpoint_url"] = json!(endpoint);
            let (status, response) =
                send(&app, &admin, "PUT", "/api/v1/lifecycle/hooks", Some(body)).await;
            assert_eq!(
                status,
                StatusCode::BAD_REQUEST,
                "{endpoint} must be refused, got {response}",
            );
        }
    }

    #[tokio::test]
    async fn an_unknown_event_type_or_subject_kind_is_refused() {
        let st = state_with_seal_key().await;
        let org = st.connection_organization;
        let admin = test_session_headers(&st, "principal:admin", org, OrganizationRole::Admin);
        let app = crate::routes::router(st.clone());

        let mut unknown_event = registration();
        unknown_event["event_types"] = json!(["lifecycle.expiry.imminent"]);
        let (status, _) = send(
            &app,
            &admin,
            "PUT",
            "/api/v1/lifecycle/hooks",
            Some(unknown_event),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);

        let mut empty = registration();
        empty["event_types"] = json!([]);
        let (status, _) = send(&app, &admin, "PUT", "/api/v1/lifecycle/hooks", Some(empty)).await;
        assert_eq!(
            status,
            StatusCode::BAD_REQUEST,
            "an empty filter must be refused, not read as \"everything\"",
        );

        let mut unknown_kind = registration();
        unknown_kind["subject_kinds"] = json!(["password"]);
        let (status, _) = send(
            &app,
            &admin,
            "PUT",
            "/api/v1/lifecycle/hooks",
            Some(unknown_kind),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn a_member_may_read_the_inventory_but_not_configure_hooks() {
        let st = state_with_seal_key().await;
        let org = st.connection_organization;
        let member = test_session_headers(&st, "principal:member", org, OrganizationRole::Member);
        let app = crate::routes::router(st.clone());

        let (status, _) = send(&app, &member, "GET", "/api/v1/lifecycle/expiring", None).await;
        assert_eq!(status, StatusCode::OK, "the inventory is metadata-only");

        for (method, uri, body) in [
            ("GET", "/api/v1/lifecycle/hooks", None),
            ("PUT", "/api/v1/lifecycle/hooks", Some(registration())),
            ("GET", "/api/v1/lifecycle/deliveries", None),
            ("POST", "/api/v1/lifecycle/scan", None),
            ("DELETE", "/api/v1/lifecycle/hooks/whatever", None),
        ] {
            let (status, _) = send(&app, &member, method, uri, body).await;
            assert_eq!(
                status,
                StatusCode::FORBIDDEN,
                "{method} {uri} is integration configuration",
            );
        }
    }

    #[tokio::test]
    async fn a_hook_from_another_organization_is_not_visible_or_deletable() {
        let st = state_with_seal_key().await;
        let org = st.connection_organization;
        let admin = test_session_headers(&st, "principal:admin", org, OrganizationRole::Admin);
        let app = crate::routes::router(st.clone());
        let (_, created) = send(
            &app,
            &admin,
            "PUT",
            "/api/v1/lifecycle/hooks",
            Some(registration()),
        )
        .await;
        let id = created["id"].as_str().unwrap().to_string();

        let other_org = opensesame_domain::OrganizationId::from_uuid(uuid::Uuid::new_v4());
        let stranger = test_session_headers(
            &st,
            "principal:stranger",
            other_org,
            OrganizationRole::Admin,
        );
        let (status, listed) = send(&app, &stranger, "GET", "/api/v1/lifecycle/hooks", None).await;
        assert_eq!(status, StatusCode::OK);
        assert!(listed["hooks"].as_array().unwrap().is_empty());

        let (status, _) = send(
            &app,
            &stranger,
            "DELETE",
            &format!("/api/v1/lifecycle/hooks/{id}"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn deleting_a_hook_removes_it() {
        let st = state_with_seal_key().await;
        let org = st.connection_organization;
        let admin = test_session_headers(&st, "principal:admin", org, OrganizationRole::Admin);
        let app = crate::routes::router(st.clone());
        let (_, created) = send(
            &app,
            &admin,
            "PUT",
            "/api/v1/lifecycle/hooks",
            Some(registration()),
        )
        .await;
        let id = created["id"].as_str().unwrap().to_string();

        let (status, _) = send(
            &app,
            &admin,
            "DELETE",
            &format!("/api/v1/lifecycle/hooks/{id}"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let (_, listed) = send(&app, &admin, "GET", "/api/v1/lifecycle/hooks", None).await;
        assert!(listed["hooks"].as_array().unwrap().is_empty());
        // A second delete is a 404, not a silent success.
        let (status, _) = send(
            &app,
            &admin,
            "DELETE",
            &format!("/api/v1/lifecycle/hooks/{id}"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn editing_a_hook_that_does_not_exist_is_a_404() {
        let st = state_with_seal_key().await;
        let org = st.connection_organization;
        let admin = test_session_headers(&st, "principal:admin", org, OrganizationRole::Admin);
        let app = crate::routes::router(st.clone());
        let mut body = registration();
        body["id"] = json!("lch_nope");
        let (status, _) = send(&app, &admin, "PUT", "/api/v1/lifecycle/hooks", Some(body)).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn the_inventory_publishes_the_frozen_vocabulary_and_a_policys_ladder() {
        let st = state_with_seal_key().await;
        let org = st.connection_organization;
        let admin = test_session_headers(&st, "principal:admin", org, OrganizationRole::Admin);
        st.connection_broker
            .upsert_rotation_policy(
                &org.to_string(),
                opensesame_connection_broker::UpsertRotationPolicy {
                    id: None,
                    target: opensesame_connection_broker::RotationTarget::StorePath {
                        path: "Dev/api-token".into(),
                    },
                    owner_subject: None,
                    interval_seconds: 3_600,
                    enabled: true,
                },
            )
            .await
            .unwrap();
        let app = crate::routes::router(st.clone());

        let (status, view) = send(&app, &admin, "GET", "/api/v1/lifecycle/expiring", None).await;
        assert_eq!(status, StatusCode::OK, "{view}");
        assert_eq!(
            view["event_types"].as_array().unwrap().len(),
            LIFECYCLE_EVENT_TYPES.len() + BREACH_EVENT_TYPES.len() + AGENT_EVENT_TYPES.len(),
            "the frozen vocabulary is part of the contract, and it spans every family",
        );
        assert_eq!(view["secrets_returned"], json!(false));

        let subject = view["subjects"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["subject_id"] == json!("Dev/api-token"))
            .expect("the policy is a tracked subject");
        assert_eq!(subject["subject_kind"], json!("store_path"));
        assert_eq!(subject["responder"], json!("rotation"));
        assert_eq!(
            subject["alerting"],
            json!(false),
            "a schedule reports only its renewal rung",
        );
        let rungs: Vec<&str> = subject["ladder"]
            .as_array()
            .unwrap()
            .iter()
            .map(|rung| rung["stage"].as_str().unwrap())
            .collect();
        assert_eq!(rungs, ["renewal"]);
    }

    #[tokio::test]
    async fn a_scan_publishes_to_a_matching_subscriber_and_skips_the_rest() {
        let st = state_with_seal_key().await;
        let org = st.connection_organization;
        let admin = test_session_headers(&st, "principal:admin", org, OrganizationRole::Admin);
        st.connection_broker
            .upsert_rotation_policy(
                &org.to_string(),
                opensesame_connection_broker::UpsertRotationPolicy {
                    id: None,
                    target: opensesame_connection_broker::RotationTarget::StorePath {
                        path: "Dev/api-token".into(),
                    },
                    owner_subject: None,
                    interval_seconds: 3_600,
                    enabled: true,
                },
            )
            .await
            .unwrap();
        let app = crate::routes::router(st.clone());

        // One subscriber wants the renewal rung on store paths; the other
        // only cares about certificates and must receive nothing.
        let mut matching = registration();
        matching["name"] = json!("store-watcher");
        matching["subject_kinds"] = json!(["store_path"]);
        send(
            &app,
            &admin,
            "PUT",
            "/api/v1/lifecycle/hooks",
            Some(matching),
        )
        .await;
        let mut unrelated = registration();
        unrelated["name"] = json!("cert-watcher");
        unrelated["subject_kinds"] = json!(["certificate"]);
        let (_, unrelated_hook) = send(
            &app,
            &admin,
            "PUT",
            "/api/v1/lifecycle/hooks",
            Some(unrelated),
        )
        .await;
        let unrelated_id = unrelated_hook["id"].as_str().unwrap().to_string();

        let (status, scanned) = send(&app, &admin, "POST", "/api/v1/lifecycle/scan", None).await;
        assert_eq!(status, StatusCode::OK, "{scanned}");
        assert!(scanned["published"].as_i64().unwrap() >= 1, "{scanned}");

        let (_, ledger) = send(&app, &admin, "GET", "/api/v1/lifecycle/deliveries", None).await;
        let deliveries = ledger["deliveries"].as_array().unwrap();
        assert!(!deliveries.is_empty(), "the matching hook was queued");
        assert!(
            deliveries
                .iter()
                .all(|row| row["hook_id"] != json!(unrelated_id)),
            "a subject-kind filter must exclude the unrelated subscriber: {ledger}",
        );
        assert!(
            deliveries
                .iter()
                .any(|row| row["event_type"] == json!("lifecycle.renewal.due")),
            "the renewal rung is what a rotation subscriber receives: {ledger}",
        );

        // Rotation ran off that same event — the dogfood, end to end.
        let jobs = st
            .connection_broker
            .list_rotation_jobs(&org.to_string(), 10)
            .await
            .unwrap();
        assert_eq!(jobs.len(), 1, "the hook issued the rotation");

        // A second scan with nothing newly crossed publishes nothing.
        let (_, again) = send(&app, &admin, "POST", "/api/v1/lifecycle/scan", None).await;
        assert_eq!(again["published"], json!(0));
    }

    #[tokio::test]
    async fn no_lifecycle_response_carries_a_secret_shaped_key() {
        let st = state_with_seal_key().await;
        let org = st.connection_organization;
        let admin = test_session_headers(&st, "principal:admin", org, OrganizationRole::Admin);
        let app = crate::routes::router(st.clone());
        send(
            &app,
            &admin,
            "PUT",
            "/api/v1/lifecycle/hooks",
            Some(registration()),
        )
        .await;
        send(&app, &admin, "POST", "/api/v1/lifecycle/scan", None).await;

        for uri in [
            "/api/v1/lifecycle/expiring",
            "/api/v1/lifecycle/hooks",
            "/api/v1/lifecycle/deliveries",
        ] {
            let (status, body) = send(&app, &admin, "GET", uri, None).await;
            assert_eq!(status, StatusCode::OK);
            assert_eq!(body["secrets_returned"], json!(false), "{uri}");
            assert_secret_shaped_keys_absent(uri, &body.to_string());
        }
    }

    /// The shapes the audit redactor's `DENY_KEY` pass strips, plus the one
    /// literal a lifecycle response could plausibly leak.
    fn assert_secret_shaped_keys_absent(uri: &str, rendered: &str) {
        for forbidden in [
            "\"password\"",
            "\"api_key\"",
            "\"access_token\"",
            "\"refresh_token\"",
            "\"private_key\"",
            "\"signing_secret\"",
            "whsec_",
        ] {
            assert!(
                !rendered.contains(forbidden),
                "{uri} rendered {forbidden}: {rendered}",
            );
        }
    }
}

/// End-to-end coverage of host-custody certificate renewal (ADR 0074 + 0075).
///
/// These are the tests the whole design exists to make possible: a certificate
/// the host holds the key for, approaching expiry, reissued by the lifecycle
/// hook without anyone watching — and an operator able to pick up the result.
#[cfg(test)]
mod custody_e2e {
    use super::tests::*;
    use super::*;
    use crate::app_state::{test_demo_state, test_session_headers};
    use axum::http::StatusCode;
    use opensesame_connection_broker::{BrokerConfig, ConnectionBroker};
    use opensesame_domain::OrganizationRole;
    use opensesame_storage::CertificateFilter;
    use std::sync::Arc;

    /// Issue a managed certificate and age it until its renewal window opens.
    ///
    /// The window cannot be forced open at issuance: `converging_renew_before`
    /// caps the lead at half the lifetime precisely so a fresh certificate is
    /// never immediately due. So the certificate is issued normally and then
    /// its validity is slid backwards, which is what actually happens to a
    /// real certificate — it gets old — without a test waiting a day for it.
    async fn issue_and_age_certificate(
        state: &AppState,
        app: &axum::Router,
        headers: &axum::http::HeaderMap,
    ) -> (String, String) {
        let (status, issued) = send(
            app,
            headers,
            "POST",
            "/api/v1/certs/issue",
            Some(json!({
                "common_name": "api.internal.test",
                "dns_names": ["api.internal.test"],
                "ttl_hours": 24,
                "managed": true,
                "renew_before_hours": 12,
            })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{issued}");
        assert_eq!(issued["managed"], json!(true));
        assert_eq!(issued["auto_renew_enabled"], json!(true));
        assert_eq!(
            issued["renew_before_seconds"],
            json!(12 * 3_600),
            "a 12h lead fits inside a 24h life",
        );
        let id = issued["certificate_id"].as_str().unwrap().to_string();
        let key = issued["private_key"].as_str().unwrap().to_string();
        assert!(
            key.contains("BEGIN"),
            "the requester still gets the key once"
        );
        age_certificate(state, &id, 23).await;
        (id, key)
    }

    /// Slide a certificate's whole validity window `hours` into the past,
    /// keeping its span — an aged certificate, not a malformed one.
    async fn age_certificate(state: &AppState, certificate_id: &str, hours: i64) {
        let shift = chrono::Duration::hours(hours);
        let stored = state
            .db
            .get_certificate(&state.connection_organization.to_string(), certificate_id)
            .await
            .unwrap()
            .expect("certificate");
        let slide = |raw: &str| {
            (chrono::DateTime::parse_from_rfc3339(raw)
                .expect("stored timestamps are RFC 3339")
                .with_timezone(&Utc)
                - shift)
                .to_rfc3339()
        };
        sqlx::query(
            "UPDATE issued_certificates SET not_before = ?, expires_at = ?              WHERE organization_id = ? AND id = ?",
        )
        .bind(slide(&stored.not_before))
        .bind(slide(&stored.expires_at))
        .bind(state.connection_organization.to_string())
        .bind(certificate_id)
        .execute(state.db.pool())
        .await
        .unwrap();
    }

    async fn custody_state() -> AppState {
        let mut st = test_demo_state().await;
        st.connection_broker = Arc::new(
            ConnectionBroker::new(
                st.db.pool().clone(),
                BrokerConfig::in_memory(Some([42u8; 32]), "http://127.0.0.1:8787"),
            )
            .unwrap(),
        );
        st
    }

    #[tokio::test]
    async fn a_managed_certificate_is_reissued_by_the_hook_and_the_operator_can_collect_it() {
        let st = custody_state().await;
        let org = st.connection_organization;
        let admin = test_session_headers(&st, "principal:admin", org, OrganizationRole::Admin);
        let app = crate::routes::router(st.clone());
        let (original_id, original_key) = issue_and_age_certificate(&st, &app, &admin).await;

        // A subscriber is watching the feed, exactly as a third-party tool would.
        let mut hook = json!({
            "name": "cert-watcher",
            "event_types": ["lifecycle.*"],
            "endpoint_url": "https://hooks.example.com/certs",
            "subject_kinds": ["certificate"],
        });
        hook["subject_kinds"] = json!(["certificate"]);
        let (status, _) = send(&app, &admin, "PUT", "/api/v1/lifecycle/hooks", Some(hook)).await;
        assert_eq!(status, StatusCode::OK);

        // The scan is the only trigger. Nothing calls renewal directly.
        let (status, scanned) = send(&app, &admin, "POST", "/api/v1/lifecycle/scan", None).await;
        assert_eq!(status, StatusCode::OK, "{scanned}");
        assert!(scanned["published"].as_i64().unwrap() >= 1, "{scanned}");

        // The predecessor is retired and linked to a live successor.
        let previous = st
            .db
            .get_certificate(&org.to_string(), &original_id)
            .await
            .unwrap()
            .expect("predecessor survives");
        assert_eq!(previous.status, "renewed", "the old certificate is retired");
        let successor_id = previous
            .renewed_by_id
            .clone()
            .expect("the hook produced a successor");
        let successor = st
            .db
            .get_certificate(&org.to_string(), &successor_id)
            .await
            .unwrap()
            .expect("successor exists");
        assert_eq!(successor.status, "active");
        assert_eq!(successor.common_name, previous.common_name);
        assert_eq!(successor.san_json, previous.san_json);
        assert_eq!(
            successor.renewed_from_id.as_deref(),
            Some(original_id.as_str()),
            "the chain links both ways",
        );
        assert!(successor.auto_renew_enabled, "renewal stays unattended");
        assert!(
            successor.expires_at > previous.expires_at,
            "a renewal must actually extend the deadline: {} -> {}",
            previous.expires_at,
            successor.expires_at,
        );

        // The subscriber was told, on the same feed, with both events.
        let (_, ledger) = send(&app, &admin, "GET", "/api/v1/lifecycle/deliveries", None).await;
        let delivered: Vec<&str> = ledger["deliveries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| row["event_type"].as_str().unwrap())
            .collect();
        assert!(
            delivered.contains(&"lifecycle.renewal.due"),
            "{delivered:?}",
        );
        assert!(
            delivered.contains(&"lifecycle.renewal.succeeded"),
            "a subscriber must learn the renewal worked: {delivered:?}",
        );

        // And an operator can collect what the unattended renewal produced.
        let (status, revealed) = send(
            &app,
            &admin,
            "GET",
            &format!("/api/v1/certs/{successor_id}/key"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{revealed}");
        let renewed_key = revealed["private_key"].as_str().unwrap();
        assert!(renewed_key.contains("BEGIN"));
        assert_ne!(
            renewed_key, original_key,
            "a renewal must mint a fresh key, not re-hand the old one",
        );
    }

    #[tokio::test]
    async fn a_second_scan_does_not_reissue_the_same_certificate_again() {
        let st = custody_state().await;
        let org = st.connection_organization;
        let admin = test_session_headers(&st, "principal:admin", org, OrganizationRole::Admin);
        let app = crate::routes::router(st.clone());
        issue_and_age_certificate(&st, &app, &admin).await;

        send(&app, &admin, "POST", "/api/v1/lifecycle/scan", None).await;
        let after_first = st
            .db
            .list_certificates(&org.to_string(), &CertificateFilter::default())
            .await
            .unwrap()
            .len();
        send(&app, &admin, "POST", "/api/v1/lifecycle/scan", None).await;
        let after_second = st
            .db
            .list_certificates(&org.to_string(), &CertificateFilter::default())
            .await
            .unwrap()
            .len();
        assert_eq!(
            after_first, after_second,
            "a renewed certificate leaves the sweep and its successor is not yet due; \
             scanning again must not mint another",
        );
        assert_eq!(after_first, 2, "one predecessor, one successor");
    }

    /// Two gateway processes scanning at the same moment must reissue one
    /// certificate, not two.
    ///
    /// The scanner has no view of concurrency: it evaluates watermarks and then
    /// responds. Both processes read an unrecorded rung, so both would renew.
    /// The watermark write is the claim, and only the winner acts (ADR 0076).
    #[tokio::test]
    async fn concurrent_scans_reissue_a_certificate_once() {
        let st = custody_state().await;
        let org = st.connection_organization;
        let admin = test_session_headers(&st, "principal:admin", org, OrganizationRole::Admin);
        let app = crate::routes::router(st.clone());
        issue_and_age_certificate(&st, &app, &admin).await;

        let before = st
            .db
            .list_certificates(&org.to_string(), &CertificateFilter::default())
            .await
            .unwrap()
            .len();

        let now = chrono::Utc::now();
        let (first, second) = tokio::join!(
            crate::lifecycle::scanner::scan_organization(&st, &org, now),
            crate::lifecycle::scanner::scan_organization(&st, &org, now)
        );
        first.unwrap();
        second.unwrap();

        let after = st
            .db
            .list_certificates(&org.to_string(), &CertificateFilter::default())
            .await
            .unwrap()
            .len();
        assert_eq!(
            after,
            before + 1,
            "the claim admits one reissue even when both scans fire the rung",
        );
    }

    #[tokio::test]
    async fn a_delivered_certificate_is_never_renewed_unattended() {
        // The default issuance path hands the key to its requester, so the
        // host cannot reissue it — and must say so rather than mint a key
        // nobody will receive.
        let st = custody_state().await;
        let org = st.connection_organization;
        let admin = test_session_headers(&st, "principal:admin", org, OrganizationRole::Admin);
        let app = crate::routes::router(st.clone());

        let (status, issued) = send(
            &app,
            &admin,
            "POST",
            "/api/v1/certs/issue",
            Some(json!({"common_name": "delivered.internal.test", "ttl_hours": 1})),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{issued}");
        assert!(issued["certificate_id"].is_null(), "not a managed issuance");

        let certificates = st
            .db
            .list_certificates(&org.to_string(), &CertificateFilter::default())
            .await
            .unwrap();
        let delivered = certificates.first().expect("one certificate");
        assert!(
            !delivered.auto_renew_enabled,
            "a delivered certificate never opts into unattended renewal",
        );
        assert!(
            st.db
                .get_managed_certificate_key(&org.to_string(), &delivered.id)
                .await
                .unwrap()
                .is_none(),
            "the host holds no key for it",
        );

        // The reveal route refuses it for the same reason.
        let (status, refused) = send(
            &app,
            &admin,
            "GET",
            &format!("/api/v1/certs/{}/key", delivered.id),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT, "{refused}");
        assert_eq!(refused["error"], json!("not_in_custody"));
    }

    #[tokio::test]
    async fn a_certificate_too_short_lived_to_renew_is_refused_at_issuance() {
        // Accepting it would mint something whose replacement is due the
        // instant it is signed — a responder loop, one reissue per tick.
        let st = custody_state().await;
        let org = st.connection_organization;
        let admin = test_session_headers(&st, "principal:admin", org, OrganizationRole::Admin);
        let app = crate::routes::router(st.clone());
        let (status, refused) = send(
            &app,
            &admin,
            "POST",
            "/api/v1/certs/issue",
            Some(json!({
                "common_name": "brief.internal.test",
                "ttl_hours": 1,
                "managed": true,
            })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{refused}");
        assert_eq!(refused["error"], json!("lifetime_too_short"));
    }

    #[tokio::test]
    async fn managed_custody_is_refused_for_an_external_issuer() {
        let st = custody_state().await;
        let org = st.connection_organization;
        let admin = test_session_headers(&st, "principal:admin", org, OrganizationRole::Admin);
        let app = crate::routes::router(st.clone());
        let (status, refused) = send(
            &app,
            &admin,
            "POST",
            "/api/v1/certs/issue",
            Some(json!({
                "common_name": "public.example",
                "managed": true,
                "issuer_connection_id": "connection:letsencrypt",
            })),
        )
        .await;
        assert_ne!(status, StatusCode::OK, "{refused}");
    }
}

#[cfg(test)]
mod a2h_hook_tests {
    use super::{default_floor_for, requested_delivery, requested_floor, HookBody};
    use opensesame_agent_events::EVENT_RUN_BLOCKED;
    use opensesame_lifecycle::EVENT_RENEWAL_DUE;
    use opensesame_security_events::{Delivery, Severity};

    fn body(delivery: &str, event_types: &[&str]) -> HookBody {
        HookBody {
            id: None,
            name: "notifier".into(),
            event_types: event_types.iter().map(|e| (*e).to_string()).collect(),
            endpoint_url: "https://a2h.example".into(),
            delivery: Some(delivery.into()),
            subject_kinds: None,
            severity_min: None,
            secret: Some("whsec_deadbeef".into()),
            enabled: true,
        }
    }

    #[test]
    fn a2h_is_registrable_beside_the_system_sinks() {
        assert!(super::validate_hook_body(&body("webhook", &[EVENT_RENEWAL_DUE])).is_ok());
        assert!(super::validate_hook_body(&body("a2h", &[EVENT_RUN_BLOCKED])).is_ok());
        assert!(super::validate_hook_body(&body("a2h", &["agent.*"])).is_ok());
        assert_eq!(
            requested_delivery(&body("a2h", &["agent.*"])).ok(),
            Some(Delivery::A2h)
        );
    }

    #[test]
    fn internal_is_still_not_registrable_from_outside() {
        // A row claiming to be a platform responder is one the delivery worker
        // skips forever: a subscription that looks live and receives nothing.
        assert!(requested_delivery(&body("internal", &["agent.*"])).is_err());
        assert!(requested_delivery(&body("carrier-pigeon", &["agent.*"])).is_err());
    }

    #[test]
    fn an_a2h_hook_that_could_never_name_a_person_is_refused() {
        // Only the agent family carries a run owner, so a lifecycle- or
        // breach-only a2h subscription would dead-letter every row it queued.
        // Refuse it while somebody is here to fix it.
        assert!(super::validate_hook_body(&body("a2h", &[EVENT_RENEWAL_DUE])).is_err());
        assert!(super::validate_hook_body(&body("a2h", &["lifecycle.*"])).is_err());
        assert!(super::validate_hook_body(&body("a2h", &["breach.*"])).is_err());
        // Naming both families is fine: the agent half escalates and the rest
        // is refused at render time with a reason, not silently dropped.
        assert!(
            super::validate_hook_body(&body("a2h", &[EVENT_RENEWAL_DUE, EVENT_RUN_BLOCKED]))
                .is_ok()
        );
        // The bare wildcard covers the agent family, so it qualifies.
        assert!(super::validate_hook_body(&body("a2h", &["*"])).is_ok());
    }

    #[test]
    fn registering_a_phone_does_not_sign_somebody_up_for_every_state_change() {
        // The quiet phases are Info; an a2h hook floors at Error unless an
        // operator lowers it deliberately. This is the *only* place that
        // decides — `opensesame_a2h::intent_for` has no opinion, so the two
        // cannot disagree.
        assert_eq!(default_floor_for(Delivery::A2h), Severity::Error);
        assert_eq!(
            requested_floor(&body("a2h", &["agent.*"]), Delivery::A2h).ok(),
            Some(Severity::Error),
        );
        for system_sink in [
            Delivery::Webhook,
            Delivery::Alertmanager,
            Delivery::PagerDuty,
        ] {
            assert_eq!(default_floor_for(system_sink), Severity::Info);
        }

        let mut chatty = body("a2h", &["agent.*"]);
        chatty.severity_min = Some("info".into());
        assert_eq!(
            requested_floor(&chatty, Delivery::A2h).ok(),
            Some(Severity::Info),
            "an operator who asks for everything gets everything",
        );
    }
}

#[cfg(test)]
mod hook_filter_tests {
    use super::known_event_types;
    use opensesame_agent_events::{AGENT_EVENT_TYPES, EVENT_RUN_BLOCKED};
    use opensesame_breach_intel::BREACH_EVENT_TYPES;
    use opensesame_lifecycle::{EVENT_RENEWAL_DUE, LIFECYCLE_EVENT_TYPES};
    use opensesame_security_events::filter;

    fn entries(names: &[&str]) -> Vec<String> {
        names.iter().map(|name| (*name).to_string()).collect()
    }

    fn valid(names: &[&str]) -> bool {
        filter::is_valid(&entries(names), &known_event_types())
    }

    #[test]
    fn one_subscription_may_span_every_family() {
        assert!(valid(&[EVENT_RENEWAL_DUE, EVENT_RUN_BLOCKED]));
        assert!(valid(&["lifecycle.*", "breach.*", "agent.*"]));
        assert!(valid(&["*"]));
    }

    #[test]
    fn an_unknown_name_is_refused_even_beside_valid_ones() {
        assert!(!valid(&[EVENT_RENEWAL_DUE, "agent.run.exploded"]));
        assert!(!valid(&["everything"]));
        assert!(!valid(&["rumour.*"]));
    }

    #[test]
    fn an_empty_filter_is_refused_rather_than_read_as_everything() {
        assert!(!valid(&[]));
    }

    #[test]
    fn discovery_and_registration_answer_for_the_same_families() {
        // One union, used by both surfaces. Two lists is how a caller reads
        // the advertised vocabulary, registers from it, and is told a name it
        // was just given is unknown — or, worse, never learns a family exists.
        let advertised = known_event_types();
        for name in LIFECYCLE_EVENT_TYPES
            .iter()
            .chain(BREACH_EVENT_TYPES.iter())
            .chain(AGENT_EVENT_TYPES.iter())
        {
            assert!(advertised.contains(name), "{name} is not discoverable");
            assert!(valid(&[name]), "{name} is advertised but not registrable");
        }
        assert_eq!(
            advertised.len(),
            LIFECYCLE_EVENT_TYPES.len() + BREACH_EVENT_TYPES.len() + AGENT_EVENT_TYPES.len(),
            "the union carries every family and nothing else",
        );
    }
}
