//! HashiCorp Vault **KV v2 read facade** (ops plane, default off).
//!
//! Dozens of operations tools speak Vault's KV v2 HTTP API natively — External
//! Secrets Operator, the Terraform Vault provider, Vault Agent, CI plugins.
//! `crates/provider-openbao` is already the *client* half of that protocol;
//! this is the serving half, so those tools can read from OpenSesame without a
//! bespoke integration.
//!
//! ## What it is, and what it deliberately is not
//!
//! * **Read only.** `POST` / `PUT` / `PATCH` / `DELETE`, and the `delete`,
//!   `undelete` and `destroy` version endpoints, all answer `405` with a body
//!   pointing at the roadmap. Writing is not on this surface in v1.
//! * **A view, not a store.** Every byte served comes from storage the gateway
//!   already has: the connection broker's `connections` / `connection_credentials`
//!   / `connection_events` rows (ADR 0032), read through the broker's own public
//!   API. No table, no migration, and no second copy of anything is added here.
//! * **Reference-first.** `secret/connections/{name}` yields the same
//!   reference-only view `GET /api/v1/connections/{id}` yields: a ConnectionRef,
//!   the provider, the status, and the *names* of configured fields. An External
//!   Secrets `ExternalSecret` pointed at it materialises a Kubernetes Secret
//!   holding a ConnectionRef — which is the whole product thesis (ADR 0005),
//!   not a workaround. `secret/materialize/{name}` is the only path that can
//!   carry credential bytes, and only ever provider-minted short-lived ones,
//!   and only where the connection's materialization policy already says
//!   `derived_short_lived` (ADR 0049). A `deny` connection answers `403`.
//! * **Ops plane, never agent plane.** This surface is reachable only over the
//!   gateway's HTTP listener with an operator or session token; it has no
//!   ConnectionRef entry point, no MCP tool, and no WIT import. It is the
//!   human/ops-plane exception, and it pays for that with a receipt.
//! * **Receipted.** Every successful read signs and persists an
//!   [`InvocationReceipt`] before the body is returned, and returns its id in
//!   `X-OpenSesame-Receipt`. If the receipt cannot be recorded the read is
//!   refused (`503`) rather than served unaccountably — no receipt, no read.
//!   Receipt summaries carry counts and a ConnectionRef, never key names or
//!   values, so a receipt can never become the leak the read avoided.
//! * **Default off.** `OPENSESAME_KV_FACADE` gates the whole route group in
//!   [`crate::routes::router`]; with it unset the routes are not mounted, so a
//!   probe sees `404` (the surface does not exist) rather than `403` (it exists
//!   and refused you).
//!
//! ## Auth
//!
//! Vault clients send `X-Vault-Token`. That header is mapped onto the gateway's
//! existing validation ([`crate::middleware::auth`]) rather than a parallel
//! scheme: `opaque-session:<id>` becomes the session bearer, anything else is
//! tried as the operator token. A request that also carries `Authorization`
//! uses the native path unchanged.
//!
//! Refusals use Vault's own dialect so its clients report them properly:
//! `400 {"errors":["missing client token"]}` for no token,
//! `403 {"errors":["permission denied"]}` for a bad one, and `404 {"errors":[]}`
//! for anything unresolvable — including a malformed path, so the surface is
//! never an existence oracle.

#[path = "kv_facade_path.rs"]
pub mod path;

use axum::{
    extract::{Path as AxumPath, Query, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post, put},
    Json, Router,
};
use chrono::{Duration, Utc};
use opensesame_connection_broker::{ConnectionView, EventView};
use opensesame_domain::{
    ActorId, ConnectionId, DetachedProof, Intent, IntentId, Invocation, InvocationId,
    InvocationState, MaterializationPolicy, OrganizationId, PrincipalId, ReceiptId, ReceiptOutcome,
};
use serde::Deserialize;
use serde_json::{json, Map, Value};

use crate::app_state::AppState;
use crate::middleware::auth::{parse_principal, resolve_caller, Caller};

use path::{parse_kv_path, KvFamily, KvPath, KV_MOUNT};

/// Header carrying the receipt id minted for a read. Vault clients ignore
/// unknown headers, so ops tooling gets the audit pointer without the response
/// body drifting from the KV v2 shape.
pub const RECEIPT_HEADER: &str = "x-opensesame-receipt";

/// Vault's `X-Vault-Token`.
const VAULT_TOKEN_HEADER: &str = "x-vault-token";

/// `mount_type` reported in every envelope. Vault reports the engine type here
/// and KV v2 clients branch on it.
const MOUNT_TYPE: &str = "kv";

/// Reported by `/v1/sys/health`. Not a Vault version number: clients that gate
/// on a Vault release must not be told they are talking to one.
const FACADE_VERSION: &str = "opensesame-kv-facade/1";

/// The one roadmap answer every write verb gives.
const WRITE_UNSUPPORTED: &str = "the OpenSesame KV v2 facade is read-only; writes go through \
     the Host API (POST /api/v1/connections/{id}/credential) — see docs/adr/0049";

/// Routes mounted only when the facade is enabled (see [`crate::config::kv_facade_enabled`]).
pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/v1/sys/health", get(sys_health))
        .route(
            "/v1/{mount}/data/{*path}",
            get(read_data)
                .post(write_denied)
                .put(write_denied)
                .patch(write_denied)
                .delete(write_denied),
        )
        .route(
            "/v1/{mount}/metadata/{*path}",
            get(read_metadata)
                .post(write_denied)
                .put(write_denied)
                .patch(write_denied)
                .delete(write_denied),
        )
        // KV v2 version management: `delete` and `undelete` are POST, `destroy`
        // is PUT, and the latest-version delete is DELETE on `data`. All refused
        // with the same roadmap answer rather than 404, so a client learns the
        // surface exists and is read-only.
        .route("/v1/{mount}/delete/{*path}", post(write_denied))
        .route("/v1/{mount}/undelete/{*path}", post(write_denied))
        .route(
            "/v1/{mount}/destroy/{*path}",
            put(write_denied).post(write_denied),
        )
        .route("/v1/{mount}/subkeys/{*path}", get(vault_not_found_handler))
        .route(
            "/v1/{mount}/config",
            get(vault_not_found_handler)
                .post(write_denied)
                .delete(write_denied),
        )
}

// ---- Vault-shaped responses ------------------------------------------------

fn vault_error<S: serde::Serialize>(status: StatusCode, errors: Vec<S>) -> Response {
    (status, Json(json!({ "errors": errors }))).into_response()
}

/// Vault's answer for "no secret here", and this facade's answer for every
/// unresolvable path: a malformed path, an unknown mount, an unknown family
/// and a connection in another organization are indistinguishable on the wire.
fn vault_not_found() -> Response {
    (
        StatusCode::NOT_FOUND,
        Json(json!({ "errors": Value::Array(Vec::new()) })),
    )
        .into_response()
}

async fn vault_not_found_handler() -> Response {
    vault_not_found()
}

/// Every write verb, on every KV v2 version endpoint: refused with the roadmap
/// answer rather than 404, so a client learns the surface exists and is
/// read-only instead of guessing that it addressed the wrong path.
async fn write_denied() -> Response {
    (
        StatusCode::METHOD_NOT_ALLOWED,
        [(header::ALLOW, HeaderValue::from_static("GET"))],
        Json(json!({
            "errors": [WRITE_UNSUPPORTED],
        })),
    )
        .into_response()
}

// ---- auth ------------------------------------------------------------------

/// Maps `X-Vault-Token` onto the gateway's existing session/operator validation.
///
/// The header is translated into the headers [`resolve_caller`] already
/// understands rather than re-implementing token checks: `opaque-session:<id>`
/// becomes `Authorization: Bearer opaque-session:<id>`, anything else is
/// offered as the operator token. A request that already carries a native
/// credential skips the translation entirely.
fn vault_caller(st: &AppState, headers: &HeaderMap) -> Result<Caller, Response> {
    if headers.contains_key(header::AUTHORIZATION) || headers.contains_key("x-opensesame-operator")
    {
        return resolve_caller(st, headers).map_err(|_| permission_denied());
    }
    let Some(raw) = headers.get(VAULT_TOKEN_HEADER) else {
        return Err(vault_error(
            StatusCode::BAD_REQUEST,
            vec!["missing client token"],
        ));
    };
    let Ok(token) = raw.to_str() else {
        return Err(permission_denied());
    };
    let token = token.trim();
    if token.is_empty() {
        return Err(vault_error(
            StatusCode::BAD_REQUEST,
            vec!["missing client token"],
        ));
    }
    let mut mapped = HeaderMap::new();
    let inserted = match token.strip_prefix("opaque-session:") {
        Some(session) => HeaderValue::from_str(&format!("Bearer opaque-session:{session}"))
            .map(|value| mapped.insert(header::AUTHORIZATION, value)),
        None => {
            HeaderValue::from_str(token).map(|value| mapped.insert("x-opensesame-operator", value))
        }
    };
    if inserted.is_err() {
        return Err(permission_denied());
    }
    resolve_caller(st, &mapped).map_err(|_| permission_denied())
}

fn permission_denied() -> Response {
    vault_error(StatusCode::FORBIDDEN, vec!["permission denied"])
}

// ---- handlers --------------------------------------------------------------

#[derive(Debug, Default, Deserialize)]
pub struct DataQuery {
    /// Required by the GitHub App mint path; ignored by every other provider.
    #[serde(default)]
    installation_id: Option<String>,
}

/// `GET /v1/{mount}/data/{*path}` — Vault KV v2 "read secret version".
async fn read_data(
    State(st): State<AppState>,
    headers: HeaderMap,
    AxumPath((mount, raw_path)): AxumPath<(String, String)>,
    Query(query): Query<DataQuery>,
) -> Response {
    let parsed = match parse_kv_path(&mount, &raw_path) {
        Ok(parsed) => parsed,
        // The reason, never the path: a rejected path is caller-supplied text.
        Err(reason) => {
            tracing::debug!(reason = reason.as_str(), "kv facade rejected a path");
            return vault_not_found();
        }
    };
    let caller = match vault_caller(&st, &headers) {
        Ok(caller) => caller,
        Err(response) => return response,
    };
    let organization_id = caller.organization(st.connection_organization);
    let Some(view) = resolve_connection(&st, &caller, &organization_id, &parsed.name).await else {
        return vault_not_found();
    };
    let events = st
        .connection_broker
        .events(&organization_id, &view.connection_id)
        .await
        .unwrap_or_default();

    let data = match parsed.family {
        KvFamily::Connections => reference_data(&view),
        KvFamily::Materialize => {
            match materialized_data(&st, &view, &caller, &organization_id, &query).await {
                Ok(data) => data,
                Err(response) => return response,
            }
        }
    };
    respond_read(
        &st,
        &caller,
        &organization_id,
        &parsed,
        &view,
        &events,
        data,
    )
    .await
}

/// `GET /v1/{mount}/metadata/{*path}` — Vault KV v2 "read secret metadata".
///
/// Version history is the connection's own event log (`connection_events`),
/// which is the closest true analogue of KV v2 versions the Host already
/// keeps: one row per authorization, refresh, policy change or revocation.
async fn read_metadata(
    State(st): State<AppState>,
    headers: HeaderMap,
    AxumPath((mount, raw_path)): AxumPath<(String, String)>,
) -> Response {
    let parsed = match parse_kv_path(&mount, &raw_path) {
        Ok(parsed) => parsed,
        Err(reason) => {
            tracing::debug!(reason = reason.as_str(), "kv facade rejected a path");
            return vault_not_found();
        }
    };
    let caller = match vault_caller(&st, &headers) {
        Ok(caller) => caller,
        Err(response) => return response,
    };
    let organization_id = caller.organization(st.connection_organization);
    let Some(view) = resolve_connection(&st, &caller, &organization_id, &parsed.name).await else {
        return vault_not_found();
    };
    let events = st
        .connection_broker
        .events(&organization_id, &view.connection_id)
        .await
        .unwrap_or_default();
    let body = metadata_envelope(&view, &events);
    let resource = receipt_resource(&parsed);
    match emit_receipt(
        &st,
        &caller,
        &organization_id,
        "kv.metadata.read",
        &resource,
        &view,
        json!({ "versions": events.len().max(1) }),
    )
    .await
    {
        Ok(receipt_id) => with_receipt(receipt_id, body),
        Err(response) => response,
    }
}

/// `GET /v1/sys/health` — the shape Vault clients probe before anything else.
///
/// `sealed` mirrors the Host's authority quorum, so a client that refuses to
/// talk to a sealed Vault also refuses to talk to a gateway whose authority is
/// unavailable. Unauthenticated, exactly as Vault's own health endpoint is,
/// and carrying nothing tenant-specific.
async fn sys_health(State(st): State<AppState>) -> Response {
    let quorum_ok = st.db.authority_quorum_ok().await.unwrap_or(false);
    let status = if quorum_ok {
        StatusCode::OK
    } else {
        // Vault answers 503 when sealed; its clients treat that as retryable.
        StatusCode::SERVICE_UNAVAILABLE
    };
    (
        status,
        Json(json!({
            "initialized": true,
            "sealed": !quorum_ok,
            "standby": false,
            "performance_standby": false,
            "replication_performance_mode": "disabled",
            "replication_dr_mode": "disabled",
            "server_time_utc": Utc::now().timestamp(),
            "version": FACADE_VERSION,
            "cluster_name": "opensesame",
        })),
    )
        .into_response()
}

// ---- views over existing storage -------------------------------------------

/// The connection a KV name addresses, or `None` when the caller may not see
/// it. An operator sees the whole organization; a session sees what it owns.
/// A connection owned by somebody else reads as absent, never as forbidden.
async fn resolve_connection(
    st: &AppState,
    caller: &Caller,
    organization_id: &OrganizationId,
    logical_name: &str,
) -> Option<ConnectionView> {
    let views = st
        .connection_broker
        .list_connections(organization_id)
        .await
        .ok()?;
    let view = views
        .into_iter()
        .find(|view| view.logical_name == logical_name)?;
    let owner = st
        .connection_broker
        .owner_subject(organization_id, &view.connection_id)
        .await
        .ok()?;
    let permitted = match caller {
        Caller::Operator => true,
        Caller::Session { .. } => owner.is_some_and(|owner| caller.owns_subject(&owner)),
    };
    permitted.then_some(view)
}

/// `secret/connections/{name}`: the reference-only view. Field *names* only —
/// the same information `GET /api/v1/connections/{id}` already publishes.
fn reference_data(view: &ConnectionView) -> Map<String, Value> {
    let mut data = Map::new();
    data.insert("connection_ref".into(), json!(view.connection_ref));
    data.insert("connection_id".into(), json!(view.connection_id));
    data.insert("provider_id".into(), json!(view.provider_id));
    data.insert("logical_name".into(), json!(view.logical_name));
    data.insert("status".into(), json!(view.status.as_str()));
    data.insert(
        "materialization".into(),
        json!(opensesame_connection_broker::materialization_str(
            view.materialization
        )),
    );
    data.insert(
        "configured_fields".into(),
        json!(view
            .configured_fields
            .iter()
            .map(|field| field.name.clone())
            .collect::<Vec<_>>()),
    );
    data.insert("granted_scopes".into(), json!(view.granted_scopes));
    data.insert("expires_at".into(), json!(view.expires_at));
    data.insert("organization_id".into(), json!(view.organization_id));
    data.insert("project_id".into(), json!(view.project_id));
    data
}

/// `secret/materialize/{name}`: a provider-minted short-lived credential.
///
/// Gated exactly where `POST /api/v1/connections/{id}/mint` is gated — this is
/// that route wearing a KV v2 costume, not a second policy. A `deny` connection
/// (the default for every connection) answers `403`, and a provider with no
/// mint path answers `403` too, both naming ADR 0049.
async fn materialized_data(
    st: &AppState,
    view: &ConnectionView,
    caller: &Caller,
    organization_id: &OrganizationId,
    query: &DataQuery,
) -> Result<Map<String, Value>, Response> {
    if view.materialization != MaterializationPolicy::DerivedShortLived {
        return Err(vault_error(
            StatusCode::FORBIDDEN,
            vec![
                "connection policy denies materialization (ADR 0049); set materialization to \
                 derived_short_lived to mint a short-lived derived credential",
            ],
        ));
    }
    let actor = match caller {
        Caller::Operator => "operator".to_string(),
        Caller::Session { subject, .. } => subject.clone(),
    };
    let minted = st
        .connection_broker
        .mint_derived_token(
            organization_id,
            &view.connection_id,
            &actor,
            query.installation_id.as_deref(),
        )
        .await
        .map_err(|error| {
            // The broker's own status mapping, in Vault's error shape. The text
            // is the broker's hint, which is written to be caller-safe.
            let status = StatusCode::from_u16(error.http_status())
                .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
            vault_error(status, vec![error.hint()])
        })?;
    let mut data = Map::new();
    data.insert("connection_ref".into(), json!(view.connection_ref));
    data.insert("provider_id".into(), json!(minted.provider_id));
    data.insert("kind".into(), json!(minted.kind));
    data.insert("derived_token".into(), json!(minted.derived_token));
    data.insert("expires_at".into(), json!(minted.expires_at));
    data.insert("issued_at".into(), json!(minted.issued_at));
    Ok(data)
}

// ---- KV v2 envelopes -------------------------------------------------------

/// KV v2 version number for a connection: one per recorded connection event,
/// never below 1. Monotonic in the event log, which is the property KV v2
/// clients actually depend on.
fn current_version(events: &[EventView]) -> u64 {
    events.len().max(1) as u64
}

fn envelope(data: Value) -> Value {
    json!({
        "request_id": uuid::Uuid::new_v4().to_string(),
        "lease_id": "",
        "renewable": false,
        "lease_duration": 0,
        "data": data,
        "wrap_info": Value::Null,
        "warnings": Value::Null,
        "auth": Value::Null,
        "mount_type": MOUNT_TYPE,
    })
}

/// The KV v2 "read secret version" body.
pub fn data_envelope(
    view: &ConnectionView,
    events: &[EventView],
    data: Map<String, Value>,
) -> Value {
    envelope(json!({
        "data": Value::Object(data),
        "metadata": {
            "created_time": view.created_at,
            "custom_metadata": Value::Null,
            "deletion_time": "",
            "destroyed": false,
            "version": current_version(events),
        },
    }))
}

/// The KV v2 "read secret metadata" body. Versions are connection events:
/// value-free by construction (kind and timestamp only, never the detail line).
pub fn metadata_envelope(view: &ConnectionView, events: &[EventView]) -> Value {
    let mut versions = Map::new();
    for (index, event) in events.iter().enumerate() {
        versions.insert(
            (index + 1).to_string(),
            json!({
                "created_time": event.at,
                "deletion_time": "",
                "destroyed": false,
            }),
        );
    }
    if versions.is_empty() {
        versions.insert(
            "1".into(),
            json!({
                "created_time": view.created_at,
                "deletion_time": "",
                "destroyed": false,
            }),
        );
    }
    envelope(json!({
        "cas_required": false,
        "created_time": view.created_at,
        "current_version": current_version(events),
        "custom_metadata": Value::Null,
        "delete_version_after": "0s",
        "max_versions": 0,
        "oldest_version": 0,
        "updated_time": view.updated_at,
        "versions": Value::Object(versions),
    }))
}

fn with_receipt(receipt_id: ReceiptId, body: Value) -> Response {
    let mut response = (StatusCode::OK, Json(body)).into_response();
    if let Ok(value) = HeaderValue::from_str(&receipt_id.to_string()) {
        response.headers_mut().insert(RECEIPT_HEADER, value);
    }
    response
}

fn receipt_resource(parsed: &KvPath) -> String {
    format!(
        "kv/v2/{KV_MOUNT}/{}/{}",
        parsed.family.as_str(),
        parsed.name
    )
}

#[allow(clippy::too_many_arguments)]
async fn respond_read(
    st: &AppState,
    caller: &Caller,
    organization_id: &OrganizationId,
    parsed: &KvPath,
    view: &ConnectionView,
    events: &[EventView],
    data: Map<String, Value>,
) -> Response {
    let summary = json!({
        "mount": KV_MOUNT,
        "family": parsed.family.as_str(),
        "connection_ref": view.connection_ref,
        // Counts, never names: a receipt is durable and readable, so it must
        // not become the disclosure the read itself avoided.
        "keys": data.len(),
        "version": current_version(events),
    });
    let resource = receipt_resource(parsed);
    let body = data_envelope(view, events, data);
    match emit_receipt(
        st,
        caller,
        organization_id,
        "kv.read",
        &resource,
        view,
        summary,
    )
    .await
    {
        Ok(receipt_id) => with_receipt(receipt_id, body),
        Err(response) => response,
    }
}

// ---- receipts --------------------------------------------------------------

/// Signs and persists the receipt for one read, through the same storage and
/// the same signer `opensesame_broker::Broker` uses.
///
/// Fails closed: when the receipt cannot be recorded — most commonly because
/// the caller's organization has no row for the intent to reference — the read
/// is refused rather than served without evidence.
async fn emit_receipt(
    st: &AppState,
    caller: &Caller,
    organization_id: &OrganizationId,
    operation: &str,
    resource: &str,
    view: &ConnectionView,
    summary: Value,
) -> Result<ReceiptId, Response> {
    let boot = st.bootstrap.lock().unwrap().clone();
    let principal_id = match caller {
        Caller::Session { subject, .. } => parse_principal(subject)
            .or_else(|| boot.as_ref().map(|b| b.principal))
            .unwrap_or_else(|| PrincipalId::from_uuid(uuid::Uuid::nil())),
        Caller::Operator => boot
            .as_ref()
            .map(|b| b.principal)
            .unwrap_or_else(|| PrincipalId::from_uuid(uuid::Uuid::nil())),
    };
    let actor_id = boot
        .as_ref()
        .map(|b| b.actor)
        .unwrap_or_else(|| ActorId::from_uuid(uuid::Uuid::nil()));
    let now = Utc::now();
    let intent = Intent {
        id: IntentId::new(),
        organization_id: *organization_id,
        project_id: None,
        principal_id,
        actor_id,
        actor_instance_id: None,
        client_id: None,
        operator_id: None,
        connection_id: ConnectionId::parse(&view.connection_id).ok(),
        operation: operation.to_string(),
        resource: resource.to_string(),
        audience: format!("kv-v2-facade://{KV_MOUNT}"),
        normalized_parameters_hash: Intent::parameters_hash(&json!({}))
            .map_err(|_| receipt_unavailable())?,
        body_hash: None,
        nonce: uuid::Uuid::new_v4().to_string(),
        idempotency_key: uuid::Uuid::new_v4().to_string(),
        issued_at: now,
        expires_at: now + Duration::minutes(5),
        parent_invocation_id: None,
        delegation_chain: boot.as_ref().map(|b| vec![b.grant.id]).unwrap_or_default(),
        // There is no client proof on this path, and claiming one would be a
        // lie a verifier could not detect. The receipt records that honestly.
        proof: DetachedProof {
            algorithm: "none".into(),
            key_thumbprint: "kv-v2-facade".into(),
            signature: String::new(),
        },
    };
    let invocation = Invocation {
        id: InvocationId::new(),
        intent_id: intent.id,
        state: InvocationState::Succeeded,
        attempt: 1,
        lease_owner: None,
        lease_expires_at: None,
        created_at: now,
        updated_at: Utc::now(),
    };
    let receipt = opensesame_domain::InvocationReceipt {
        id: ReceiptId::new(),
        invocation_id: invocation.id,
        intent_digest: intent.digest().map_err(|_| receipt_unavailable())?,
        principal_id,
        organization_id: Some(*organization_id),
        actor_id,
        actor_instance_id: None,
        client_id: None,
        operator_id: None,
        delegation_chain: intent.delegation_chain.clone(),
        connection_id: intent.connection_id,
        operation: intent.operation.clone(),
        resource: intent.resource.clone(),
        policy_decision_id: "kv-facade-read-only".into(),
        policy_version_digest: "kv-facade/1".into(),
        approval_id: None,
        credential_handle_id: None,
        connector_component_digest: None,
        external_request_digest: None,
        external_response_digest: None,
        started_at: now,
        completed_at: Utc::now(),
        outcome: ReceiptOutcome::Succeeded,
        safe_result_summary: Some(summary),
        authority_key_id: String::new(),
        signature: String::new(),
        receipt_schema_version: 3,
        task_run_id: None,
        task_state_version: None,
        task_state_digest: None,
    };
    let receipt = st
        .broker
        .signer
        .sign_receipt(receipt)
        .map_err(|_| receipt_unavailable())?;
    if !receipt.assert_no_secret_leak() {
        tracing::error!("kv facade receipt summary rejected by the secret-leak check");
        return Err(receipt_unavailable());
    }
    let id = receipt.id;
    st.db
        .insert_intent(&intent)
        .await
        .map_err(receipt_storage_failure)?;
    st.db
        .insert_invocation(&invocation)
        .await
        .map_err(receipt_storage_failure)?;
    st.db
        .insert_receipt(&receipt)
        .await
        .map_err(receipt_storage_failure)?;
    Ok(id)
}

fn receipt_storage_failure(error: anyhow::Error) -> Response {
    // Storage errors can echo identifiers; redact before they reach a log.
    tracing::error!(
        error = %opensesame_redaction::redact_text(&error.to_string()),
        "kv facade could not record a read receipt; refusing the read"
    );
    receipt_unavailable()
}

fn receipt_unavailable() -> Response {
    vault_error(
        StatusCode::SERVICE_UNAVAILABLE,
        vec!["read refused: the receipt for this read could not be recorded"],
    )
}

#[cfg(test)]
mod tests;
