use axum::{
    extract::{Path, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use chrono::{Duration, Utc};
use clap::Parser;
use opensesame_audit::ReceiptSigner;
use opensesame_authz::PolicyEngine;
use opensesame_broker::{Broker, InvokeInput};
use opensesame_claims::{generate_claim_token, generate_user_code, hash_secret};
use opensesame_client_core::SyncBlob;
use opensesame_connector_host::HostRuntime;
use opensesame_host_core::daemon as host_daemon;
use opensesame_domain::*;
use opensesame_provider_openbao::{CredentialAuthority, OpenBaoHttpAuthority};
use opensesame_provider_openfga::{OpenFgaClient, TupleKey};
use opensesame_storage::Db;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    env,
    net::SocketAddr,
    sync::{Arc, Mutex},
};
use tower_http::trace::TraceLayer;

const DEV_OPERATOR_TOKEN: &str = "opensesame-dev-operator";

fn constant_time_eq(a: &str, b: &str) -> bool {
    let (aa, bb) = (a.as_bytes(), b.as_bytes());
    if aa.len() != bb.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in aa.iter().zip(bb.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

#[derive(Parser, Debug)]
#[command(name = "opensesame-gateway")]
struct Args {
    #[arg(long, env = "OPENSESAME_LISTEN", default_value = "127.0.0.1:8787")]
    listen: SocketAddr,
    #[arg(long, env = "OPENSESAME_RESOURCE", default_value = "https://opensesame.local")]
    resource: String,
    #[arg(long, env = "OPENSESAME_ISSUER", default_value = "https://keycloak.local/realms/opensesame")]
    issuer: String,
    #[arg(long, env = "OPENSESAME_DB", default_value = "sqlite::memory:")]
    database_url: String,
}

#[derive(Clone)]
struct AppState {
    resource: String,
    issuer: String,
    db: Db,
    broker: Arc<Broker>,
    sessions: Arc<Mutex<HashMap<String, Value>>>,
    device_codes: Arc<Mutex<HashMap<String, DevicePending>>>,
    claims: Arc<Mutex<HashMap<String, ClaimSession>>>,
    bootstrap: Arc<Mutex<Bootstrap>>,
    openfga: Option<OpenFgaClient>,
    openbao: Option<OpenBaoHttpAuthority>,
    connection_ref: ConnectionRef,
    /// Opaque ciphertext sync store — server never decrypts (ADR 0017).
    sync_blobs: Arc<Mutex<HashMap<String, SyncBlob>>>,
    /// blob_id -> owning session_id (tenant/device scoping for sync).
    blob_owners: Arc<Mutex<HashMap<String, String>>>,
    /// Per-device sync cursors (device_id -> last seen epoch).
    device_cursors: Arc<Mutex<HashMap<String, u64>>>,
    /// Shared secret for human/operator mutations (approve, claim complete, admin).
    operator_token: String,
}

fn resolve_operator_token() -> String {
    match env::var("OPENSESAME_OPERATOR_TOKEN") {
        Ok(t) if !t.is_empty() => t,
        _ => {
            let prod = env::var("OPENSESAME_ENV").ok().as_deref() == Some("production")
                || env::var("NODE_ENV").ok().as_deref() == Some("production");
            if prod {
                tracing::error!(
                    "OPENSESAME_OPERATOR_TOKEN unset in production — operator routes will deny"
                );
                String::new()
            } else {
                tracing::warn!(
                    "OPENSESAME_OPERATOR_TOKEN unset; using {DEV_OPERATOR_TOKEN} (dev only)"
                );
                DEV_OPERATOR_TOKEN.into()
            }
        }
    }
}

#[derive(Clone)]
struct DevicePending {
    user_code: String,
    expires_at: chrono::DateTime<Utc>,
    approved_principal: Option<String>,
}

#[derive(Clone)]
struct Bootstrap {
    org: OrganizationId,
    project: ProjectId,
    principal: PrincipalId,
    actor: ActorId,
    connection: ConnectionId,
    grant: Grant,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter("info,tower_http=info")
        .json()
        .init();
    let args = Args::parse();
    let db = if args.database_url == "sqlite::memory:" {
        Db::connect_memory().await?
    } else {
        Db::connect_sqlite(&args.database_url).await?
    };

    let mut policy = PolicyEngine::default();
    let org = OrganizationId::new();
    let project = ProjectId::new();
    let principal = PrincipalId::new();
    let actor = ActorId::new();
    let connection = ConnectionId::new();
    db.create_organization(&org, "demo").await?;
    db.create_project(&project, &org, "catalog").await?;

    policy
        .relationships
        .write(&format!("organization:{org}"), "member", "user:demo");
    policy
        .relationships
        .write(&format!("project:{project}"), "developer", "user:demo");
    // Policy engine connection checks use short ids in fixtures; use "demo-conn"
    policy
        .relationships
        .write("connection:demo-conn", "user", "user:demo");
    policy
        .assurance
        .insert("user:demo".into(), "mfa".into());

    let now = Utc::now();
    let grant = Grant {
        id: GrantId::new(),
        version: 1,
        issuer_principal_id: principal,
        beneficiary_principal_id: principal,
        actor_id: Some(actor),
        client_id: None,
        actor_instance_id: None,
        proof_key_thumbprint: None,
        organization_id: org,
        project_id: Some(project),
        environment_id: None,
        connection_id: Some(connection),
        actions: vec![
            "repository.read".into(),
            "pull_request.create".into(),
        ],
        resources: vec!["repo:acme/catalog".into()],
        constraints: GrantConstraints {
            audiences: vec!["https://api.github.com".into()],
            not_before: None,
            expires_at: now + Duration::hours(8),
            required_assurance: Some("mfa".into()),
            authentication_max_age_seconds: Some(3600),
            allowed_networks: vec![],
            parameter_rules_digest: None,
            budgets: Default::default(),
            maximum_delegation_depth: 0,
            offline_use: OfflineUse::Forbidden,
            raw_credential_export: false,
        },
        parent_grant_id: None,
        delegation_depth: 0,
        created_at: now,
        revoked_at: None,
    };
    db.insert_grant(&grant).await?;

    let connection_ref = ConnectionRef::new(org, Some(project), "github/main", connection)
        .expect("connection ref");

    let openfga = OpenFgaClient::from_env().ok().flatten();
    let openbao = OpenBaoHttpAuthority::from_env().ok().flatten();
    
    let broker = Arc::new(Broker {
        db: db.clone(),
        policy,
        host: HostRuntime::default(),
        signer: ReceiptSigner::generate(),
    });

    let state = AppState {
        resource: args.resource.clone(),
        issuer: args.issuer.clone(),
        db,
        broker,
        sessions: Arc::new(Mutex::new(HashMap::new())),
        device_codes: Arc::new(Mutex::new(HashMap::new())),
        claims: Arc::new(Mutex::new(HashMap::new())),
        bootstrap: Arc::new(Mutex::new(Bootstrap {
            org,
            project,
            principal,
            actor,
            connection,
            grant,
        })),
        openfga,
        openbao,
        connection_ref,
        sync_blobs: Arc::new(Mutex::new(HashMap::new())),
        blob_owners: Arc::new(Mutex::new(HashMap::new())),
        device_cursors: Arc::new(Mutex::new(HashMap::new())),
        operator_token: resolve_operator_token(),
    };

    let app = Router::new()
        .route("/health/live", get(|| async { "ok" }))
        .route("/health/ready", get(health_ready))
        .route("/health/authority", get(health_authority))
        .route("/health/degraded", get(health_degraded))
        .route("/health/providers", get(health_providers))
        .route(
            "/.well-known/oauth-protected-resource",
            get(protected_resource_metadata),
        )
        .route("/auth.md", get(auth_md))
        .route("/.well-known/agent-card.json", get(agent_card))
        .route("/api/v1/device/authorize", post(device_authorize))
        .route("/api/v1/device/token", post(device_token))
        .route("/api/v1/device/approve", post(device_approve))
        .route("/api/v1/session", get(session_status))
        .route("/api/v1/whoami", get(whoami))
        .route("/api/v1/connections", get(list_connections))
        .route("/api/v1/intents", post(create_intent_invoke))
        .route("/api/v1/receipts/{id}", get(get_receipt))
        .route("/api/v1/receipts/{id}/verify", post(verify_receipt))
        .route("/api/v1/agent-identities", post(agent_identity))
        .route("/api/v1/agent-claims/{id}/poll", post(claim_poll))
        .route("/api/v1/agent-claims/{id}/complete", post(claim_complete))
        .route("/api/v1/admin/authority", post(set_authority))
        .route("/api/v1/sync/push", post(sync_push))
        .route("/api/v1/sync/pull", post(sync_pull))
        .with_state(state)
        .layer(TraceLayer::new_for_http());

    tracing::info!(%args.listen, "opensesame gateway listening");
    let listener = tokio::net::TcpListener::bind(args.listen).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

async fn health_ready(State(st): State<AppState>) -> impl IntoResponse {
    match st.db.authority_quorum_ok().await {
        Ok(true) => (StatusCode::OK, Json(json!({"status":"ready"}))),
        Ok(false) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"status":"not_ready","reason":"authority_quorum"})),
        ),
        Err(e) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"status":"not_ready","reason":e.to_string()})),
        ),
    }
}

async fn health_authority(State(st): State<AppState>) -> impl IntoResponse {
    let ok = st.db.authority_quorum_ok().await.unwrap_or(false);
    Json(json!({"quorum_ok": ok, "class_a2_a3": if ok {"available"} else {"fail_closed"}}))
}

async fn health_degraded(State(st): State<AppState>) -> impl IntoResponse {
    let ok = st.db.authority_quorum_ok().await.unwrap_or(false);
    Json(json!({
        "authority": if ok {"ok"} else {"degraded"},
        "a0_local_e2ee": "available",
        "a2_authority_required": if ok {"available"} else {"denied"}
    }))
}

async fn health_providers(State(st): State<AppState>) -> impl IntoResponse {
    let mut openfga = json!({"configured": false});
    if let Some(c) = &st.openfga {
        openfga = match c.health().await {
            Ok(()) => json!({"configured": true, "status": "ok"}),
            Err(e) => json!({"configured": true, "status": "error", "error": e.to_string()}),
        };
    }
    let mut openbao = json!({"configured": false});
    if let Some(a) = &st.openbao {
        openbao = match a.health().await {
            Ok(h) => json!({"configured": true, "sealed": h.sealed, "quorum_ok": h.quorum_ok}),
            Err(e) => json!({"configured": true, "status": "error", "error": e.to_string()}),
        };
    }
    Json(json!({
        "openfga": openfga,
        "openbao": openbao,
        "agent_api": "connection_ref",
        "secret_ref_agent_facing": false
    }))
}

async fn list_connections(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
) -> Response {
    if let Err(resp) = require_session_or_operator(&st, &headers) {
        return resp;
    }
    // Agent surface: ConnectionRef only — never SecretRef / raw credential handles.
    Json(json!({
        "connections": [{
            "connection_ref": st.connection_ref.handle.uri(),
            "connection_id": st.connection_ref.connection_id.to_string(),
            "logical_name": st.connection_ref.handle.logical_name,
            "max_invoke_level": 2,
            "operations": ["repository.read", "pull_request.create"]
        }]
    }))
    .into_response()
}

async fn protected_resource_metadata(State(st): State<AppState>) -> impl IntoResponse {
    Json(json!({
        "resource": st.resource,
        "authorization_servers": [st.issuer],
        "scopes_supported": ["opensesame.session", "opensesame.invoke"],
        "bearer_methods_supported": ["header"],
        "resource_signing_alg_values_supported": ["EdDSA", "RS256"],
        "dpop_signing_alg_values_supported": ["EdDSA", "ES256"]
    }))
}

async fn auth_md(State(st): State<AppState>) -> impl IntoResponse {
    let body = format!(
        r#"# OpenSesame Authorization

- Protected Resource Metadata: {resource}/.well-known/oauth-protected-resource
- Authorization Server: {issuer}/.well-known/openid-configuration
- Device Authorization: POST {resource}/api/v1/device/authorize
- Agent identity: POST {resource}/api/v1/agent-identities
- Claim poll: POST {resource}/api/v1/agent-claims/{{id}}/poll
- Invoke: POST {resource}/api/v1/intents with connection_ref (never SecretRef)
- Connections: GET {resource}/api/v1/connections
- Supported grants: authorization_code+PKCE (S256), urn:ietf:params:oauth:grant-type:device_code
- Pre-claim authority: none beyond draft metadata / poll
- Proof requirements: DPoP or detached intent proof where configured
- Examples use placeholders only — never paste live credentials
- Agents exercise ConnectionRef + Intent; credential materialization is denied by default

"#,
        resource = st.resource,
        issuer = st.issuer
    );
    ([(header::CONTENT_TYPE, "text/markdown; charset=utf-8")], body)
}

async fn agent_card(State(st): State<AppState>) -> impl IntoResponse {
    Json(json!({
        "name": "OpenSesame",
        "description": "Private credential and authorization fabric",
        "url": st.resource,
        "version": "0.1.0",
        "capabilities": {"streaming": false},
        "defaultInputModes": ["application/json"],
        "defaultOutputModes": ["application/json"],
        "skills": [{
            "id": "broker.invoke",
            "name": "Brokered connector invoke",
            "description": "Authorize -> invoke -> receipt without exposing raw credentials",
            "tags": ["authorization", "connectors"]
        }],
        "securitySchemes": {
            "oauth2": {
                "type": "oauth2",
                "authorization_servers": [st.issuer]
            }
        },
        "metadata": {
            "opensesame.claim": format!("{}/api/v1/agent-identities", st.resource),
            "opensesame.auth_md": format!("{}/auth.md", st.resource)
        }
    }))
}

#[derive(Deserialize)]
struct DeviceAuthorizeRequest {
    client_id: String,
    scope: Option<String>,
}

async fn device_authorize(
    State(st): State<AppState>,
    Json(req): Json<DeviceAuthorizeRequest>,
) -> impl IntoResponse {
    let device_code = format!("dc_{}", uuid::Uuid::new_v4());
    let user_code = generate_user_code();
    let expires_at = Utc::now() + Duration::minutes(15);
    st.device_codes.lock().unwrap().insert(
        device_code.clone(),
        DevicePending {
            user_code: user_code.clone(),
            expires_at,
            approved_principal: None,
        },
    );
    // device_code returned once to client process — never logged
    Json(json!({
        "device_code": device_code,
        "user_code": user_code,
        "verification_uri": format!("{}/device", st.resource),
        "verification_uri_complete": format!("{}/device?user_code={}", st.resource, user_code),
        "expires_in": 900,
        "interval": 5,
        "client_id": req.client_id,
        "scope": req.scope.unwrap_or_else(|| "opensesame.session".into())
    }))
}

#[derive(Deserialize)]
struct DeviceTokenRequest {
    device_code: String,
    grant_type: String,
}

async fn device_token(
    State(st): State<AppState>,
    Json(req): Json<DeviceTokenRequest>,
) -> Response {
    if req.grant_type != "urn:ietf:params:oauth:grant-type:device_code" {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"unsupported_grant_type"})),
        )
            .into_response();
    }
    let mut map = st.device_codes.lock().unwrap();
    let Some(pending) = map.get_mut(&req.device_code) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"invalid_grant"})),
        )
            .into_response();
    };
    if Utc::now() >= pending.expires_at {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"expired_token"})),
        )
            .into_response();
    }
    let Some(principal) = pending.approved_principal.clone() else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"authorization_pending"})),
        )
            .into_response();
    };
    let session_id = format!("sess_{}", uuid::Uuid::new_v4());
    let handle = format!("handle_{}", uuid::Uuid::new_v4());
    let boot = st.bootstrap.lock().unwrap().clone();
    let meta = json!({
        "session_id": session_id,
        "principal_id": boot.principal.to_string(),
        "actor_id": boot.actor.to_string(),
        "issuer": st.issuer,
        "assurance": "mfa",
        "organization_id": boot.org.to_string(),
        "project_id": boot.project.to_string(),
        "credential_handle": handle,
        "approved_as": principal,
        "expires_at": (Utc::now() + Duration::hours(8)).to_rfc3339()
    });
    st.sessions
        .lock()
        .unwrap()
        .insert(session_id.clone(), meta.clone());
    map.remove(&req.device_code);
    // Never return refresh token bytes — opaque handle only
    (
        StatusCode::OK,
        Json(json!({
            "token_type": "Bearer",
            "expires_in": 28800,
            "session": meta,
            "access_token": format!("opaque-session:{session_id}")
        })),
    )
        .into_response()
}

#[derive(Deserialize)]
struct DeviceApproveRequest {
    user_code: String,
    principal: Option<String>,
}

async fn device_approve(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(req): Json<DeviceApproveRequest>,
) -> Response {
    if let Err(resp) = require_operator(&st, &headers) {
        return resp;
    }
    let mut map = st.device_codes.lock().unwrap();
    for pending in map.values_mut() {
        if pending.user_code == req.user_code {
            pending.approved_principal =
                Some(req.principal.unwrap_or_else(|| "user:demo".into()));
            return (StatusCode::OK, Json(json!({"status":"approved"}))).into_response();
        }
    }
    (
        StatusCode::NOT_FOUND,
        Json(json!({"error":"unknown_user_code"})),
    )
        .into_response()
}

async fn session_status(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
) -> Response {
    if let Err(resp) = require_session_or_operator(&st, &headers) {
        return resp;
    }
    let n = st.sessions.lock().unwrap().len();
    Json(json!({"active_sessions": n})).into_response()
}

async fn whoami(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
) -> Response {
    if let Err(resp) = require_session_or_operator(&st, &headers) {
        return resp;
    }
    let boot = st.bootstrap.lock().unwrap().clone();
    Json(json!({
        "principal_id": boot.principal.to_string(),
        "actor_id": boot.actor.to_string(),
        "client_id": "cli:opensesame",
        "issuer": st.issuer,
        "assurance": "mfa",
        "context": format!("{}/{}/", boot.org, boot.project)
    }))
    .into_response()
}

#[derive(Deserialize)]
struct InvokeBody {
    /// Preferred agent API: ConnectionRef URI (conn://...).
    #[serde(default)]
    connection_ref: Option<String>,
    /// Legacy alias accepted as ConnectionRef logical name or URI.
    #[serde(default)]
    connection: Option<String>,
    operation: String,
    resource: String,
    audience: Option<String>,
    parameters: Option<Value>,
    idempotency_key: Option<String>,
    /// 1=typed, 2=constrained HTTP, 3=materialize (denied by default).
    #[serde(default)]
    invoke_level: Option<u8>,
}

async fn create_intent_invoke(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(body): Json<InvokeBody>,
) -> Response {
    if let Err(resp) = require_session_or_operator(&st, &headers) {
        return resp;
    }
    let boot = st.bootstrap.lock().unwrap().clone();
    let parameters = body.parameters.unwrap_or_else(|| json!({}));
    let _requested_ref = body
        .connection_ref
        .clone()
        .or_else(|| body.connection.clone())
        .unwrap_or_else(|| st.connection_ref.handle.uri());
    let level = body.invoke_level.unwrap_or(1);
    
    if level >= 3 || body.operation == "credential.resolve" || body.operation.contains("secret") {
                return (
            StatusCode::FORBIDDEN,
            Json(json!({
                "error": "materialize_denied",
                "detail": "Agents receive ConnectionRef, not SecretRef. Level-3 export requires raw_credential_export.",
                "type": "about:blank"
            })),
        )
            .into_response();
    }

    // Optional live OpenFGA check when configured
    if let Some(fga) = &st.openfga {
        match fga
            .check_tuple(&TupleKey {
                user: "user:demo".into(),
                relation: "user".into(),
                object: "connection:demo-conn".into(),
            })
            .await
        {
            Ok(true) => {}
            Ok(false) => {
                return (
                    StatusCode::FORBIDDEN,
                    Json(json!({"error":"openfga_denied","type":"about:blank"})),
                )
                    .into_response();
            }
            Err(e) => {
                return (
                    StatusCode::SERVICE_UNAVAILABLE,
                    Json(json!({"error": format!("openfga_unavailable: {e}"), "type":"about:blank"})),
                )
                    .into_response();
            }
        }
    }

    // Prove OpenBao path never materializes bearer to agent
    if let Some(bao) = &st.openbao {
        if let Ok(h) = bao.create_handle("github/acme").await {
            let _ = bao
                .use_credential(
                    &h,
                    opensesame_provider_openbao::CredentialOperation::BearerHttpPlaceholder,
                )
                .await;
        }
    }

    let param_hash = match Intent::parameters_hash(&parameters) {
        Ok(h) => h,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"error": e.to_string()})),
            )
                .into_response();
        }
    };
    let now = Utc::now();
    let intent = Intent {
        id: IntentId::new(),
        organization_id: boot.org,
        project_id: Some(boot.project),
        principal_id: boot.principal,
        actor_id: boot.actor,
        actor_instance_id: None,
        client_id: None,
        operator_id: None,
        connection_id: Some(boot.connection),
        operation: body.operation,
        resource: body.resource,
        audience: body
            .audience
            .unwrap_or_else(|| "https://api.github.com".into()),
        normalized_parameters_hash: param_hash,
        body_hash: None,
        nonce: uuid::Uuid::new_v4().to_string(),
        idempotency_key: body
            .idempotency_key
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
        issued_at: now,
        expires_at: now + Duration::minutes(5),
        parent_invocation_id: None,
        delegation_chain: vec![boot.grant.id],
        proof: DetachedProof {
            algorithm: "EdDSA".into(),
            key_thumbprint: "demo".into(),
            signature: "demo".into(),
        },
    };

    match st
        .broker
        .invoke(InvokeInput {
            intent,
            grant: boot.grant.clone(),
            subject: "user:demo".into(),
            connection_policy_id: "demo-conn".into(),
            parameters,
        })
        .await
    {
        Ok(receipt) => {
            let mut body = serde_json::to_value(&receipt).unwrap_or(json!({}));
            if let Some(obj) = body.as_object_mut() {
                obj.insert(
                    "connection_ref".into(),
                    json!(st.connection_ref.handle.uri()),
                );
                obj.insert("invoke_level".into(), json!(level));
                obj.insert("credential_bytes_returned".into(), json!(false));
            }
            (StatusCode::OK, Json(body)).into_response()
        }
        Err(e) => {
            let msg = opensesame_redaction::redact_text(&e.to_string());
            (
                StatusCode::FORBIDDEN,
                Json(json!({"error": msg, "type": "about:blank"})),
            )
                .into_response()
        }
    }
}

async fn get_receipt(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
) -> Response {
    if let Err(resp) = require_session_or_operator(&st, &headers) {
        return resp;
    }
    let rid = match ReceiptId::parse(&id) {
        Ok(r) => r,
        Err(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"error":"invalid id"})),
            )
                .into_response();
        }
    };
    match st.db.get_receipt(&rid).await {
        Ok(Some(r)) => (StatusCode::OK, Json(r)).into_response(),
        Ok(None) => (StatusCode::NOT_FOUND, Json(json!({"error":"not_found"}))).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": e.to_string()})),
        )
            .into_response(),
    }
}

async fn verify_receipt(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
) -> Response {
    if let Err(resp) = require_session_or_operator(&st, &headers) {
        return resp;
    }
    let rid = match ReceiptId::parse(&id) {
        Ok(r) => r,
        Err(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"error":"invalid id"})),
            )
                .into_response();
        }
    };
    match st.db.get_receipt(&rid).await {
        Ok(Some(r)) => match st.broker.signer.verify_receipt(&r) {
            Ok(()) => (StatusCode::OK, Json(json!({"valid": true}))).into_response(),
            Err(e) => (
                StatusCode::BAD_REQUEST,
                Json(json!({"valid": false, "error": e.to_string()})),
            )
                .into_response(),
        },
        Ok(None) => (StatusCode::NOT_FOUND, Json(json!({"error":"not_found"}))).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": e.to_string()})),
        )
            .into_response(),
    }
}

#[derive(Deserialize)]
struct AgentIdentityRequest {
    instance_public_key_jwk: Value,
    requested_grant_digest: String,
    organization_hint: Option<String>,
    project_hint: Option<String>,
}

async fn agent_identity(
    State(st): State<AppState>,
    Json(req): Json<AgentIdentityRequest>,
) -> impl IntoResponse {
    let claim_token = generate_claim_token();
    let user_code = generate_user_code();
    let id = ClaimSessionId::new();
    let boot = st.bootstrap.lock().unwrap().clone();
    let session = ClaimSession {
        id,
        organization_hint: req
            .organization_hint
            .as_deref()
            .and_then(|s| OrganizationId::parse(s).ok())
            .or(Some(boot.org)),
        project_hint: req
            .project_hint
            .as_deref()
            .and_then(|s| ProjectId::parse(s).ok())
            .or(Some(boot.project)),
        actor_id: ActorId::new(),
        actor_instance_id: ActorInstanceId::new(),
        client_id: None,
        operator_id: None,
        instance_public_key_jwk: req.instance_public_key_jwk,
        claim_token_hash: hash_secret(&claim_token),
        user_code_hash: Some(hash_secret(&user_code)),
        claim_attempt_token_hash: None,
        provider_assertion_digest: None,
        attestation_digest: None,
        requested_grant_digest: req.requested_grant_digest,
        state: ClaimState::Pending,
        created_at: Utc::now(),
        expires_at: Utc::now() + Duration::minutes(15),
        claimed_at: None,
        claimed_by_principal_id: None,
    };
    let claim_id = session.id.to_string();
    st.claims.lock().unwrap().insert(claim_id.clone(), session);
    Json(json!({
        "claim_id": claim_id,
        "claim_token": claim_token,
        "user_code": user_code,
        "verification_uri": format!("{}/claim", st.resource),
        "expires_in": 900
    }))
}

async fn claim_poll(
    State(st): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let map = st.claims.lock().unwrap();
    match map.get(&id) {
        Some(s) => Json(json!({"state": s.state, "claim_id": id})),
        None => Json(json!({"error":"not_found"})),
    }
}

#[derive(Deserialize)]
struct ClaimCompleteRequest {
    claim_token: String,
    narrow_actions: Option<Vec<String>>,
}

async fn claim_complete(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
    Json(req): Json<ClaimCompleteRequest>,
) -> Response {
    // Operator must approve — claim_token alone must not self-complete (agent cannot).
    if let Err(resp) = require_operator(&st, &headers) {
        return resp;
    }
    let mut map = st.claims.lock().unwrap();
    let Some(session) = map.get_mut(&id) else {
        return (StatusCode::NOT_FOUND, Json(json!({"error":"not_found"}))).into_response();
    };
    if hash_secret(&req.claim_token) != session.claim_token_hash {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({"error":"invalid_claim_token"})),
        )
            .into_response();
    }
    if session.state != ClaimState::Pending {
        return (
            StatusCode::CONFLICT,
            Json(json!({"error":"already_completed_or_invalid"})),
        )
            .into_response();
    }
    let boot = st.bootstrap.lock().unwrap().clone();
    // Claiming must not silently widen the requested grant.
    if let Some(actions) = &req.narrow_actions {
        let parent_actions = &boot.grant.actions;
        if actions.iter().any(|a| !parent_actions.iter().any(|p| p == a)) {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"error":"cannot_widen_grant"})),
            )
                .into_response();
        }
    }
    session.state = ClaimState::Claimed;
    session.claimed_at = Some(Utc::now());
    session.claimed_by_principal_id = Some(boot.principal);
    (
        StatusCode::OK,
        Json(json!({"state":"claimed","principal_id": boot.principal.to_string()})),
    )
        .into_response()
}

#[derive(Deserialize)]
struct AuthorityBody {
    quorum_ok: bool,
}

async fn set_authority(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(body): Json<AuthorityBody>,
) -> Response {
    if let Err(resp) = require_operator(&st, &headers) {
        return resp;
    }
    st.db.set_authority_quorum(body.quorum_ok).await.ok();
    Json(json!({"quorum_ok": body.quorum_ok})).into_response()
}

#[derive(Deserialize)]
struct SyncPushBody {
    blobs: Vec<SyncBlob>,
}

#[derive(Deserialize)]
struct SyncPullBody {
    #[serde(default)]
    since_epoch: u64,
    #[serde(default)]
    device_id: Option<String>,
}

/// Store opaque ciphertext only — never attempt decryption.
/// Requires an active opaque session token (`Authorization: Bearer opaque-session:…`).
fn require_session(st: &AppState, headers: &axum::http::HeaderMap) -> Result<String, Response> {
    let auth = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let Some(token) = auth
        .strip_prefix("Bearer ")
        .or_else(|| auth.strip_prefix("bearer "))
    else {
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(json!({"error":"unauthorized","hint":"Bearer opaque-session:<id> required"})),
        )
            .into_response());
    };
    let Some(session_id) = token.strip_prefix("opaque-session:") else {
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(json!({"error":"unauthorized","hint":"expected opaque-session token"})),
        )
            .into_response());
    };
    let mut sessions = st.sessions.lock().unwrap();
    let Some(meta) = sessions.get(session_id).cloned() else {
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(json!({"error":"invalid_session"})),
        )
            .into_response());
    };
    let expired = meta
        .get("expires_at")
        .and_then(|v| v.as_str())
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|dt| Utc::now() >= dt.with_timezone(&Utc))
        .unwrap_or(true);
    if expired {
        sessions.remove(session_id);
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(json!({"error":"session_expired"})),
        )
            .into_response());
    }
    Ok(session_id.to_string())
}

/// Human/operator mutations: `X-OpenSesame-Operator` or `Authorization: Bearer operator:<token>`.
fn require_operator(st: &AppState, headers: &axum::http::HeaderMap) -> Result<(), Response> {
    if st.operator_token.is_empty() {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"error":"operator_token_unconfigured"})),
        )
            .into_response());
    }
    let from_header = headers
        .get("x-opensesame-operator")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let from_bearer = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|a| {
            a.strip_prefix("Bearer operator:")
                .or_else(|| a.strip_prefix("bearer operator:"))
                .map(str::to_string)
        });
    let provided = from_header.or(from_bearer);
    match provided {
        Some(t) if constant_time_eq(&t, &st.operator_token) => Ok(()),
        _ => Err((
            StatusCode::UNAUTHORIZED,
            Json(json!({
                "error":"operator_unauthorized",
                "hint":"X-OpenSesame-Operator or Bearer operator:<token> required"
            })),
        )
            .into_response()),
    }
}

fn require_session_or_operator(
    st: &AppState,
    headers: &axum::http::HeaderMap,
) -> Result<(), Response> {
    if require_session(st, headers).is_ok() {
        return Ok(());
    }
    require_operator(st, headers)
}

async fn sync_push(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(body): Json<SyncPushBody>,
) -> Response {
    let session_id = match require_session(&st, &headers) {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    let mut store = st.sync_blobs.lock().unwrap();
    let mut owners = st.blob_owners.lock().unwrap();
    let mut accepted = 0u32;
    for blob in body.blobs {
        match store.get(&blob.id) {
            Some(existing) if existing.epoch > blob.epoch => {}
            _ => {
                owners.insert(blob.id.clone(), session_id.clone());
                store.insert(blob.id.clone(), blob);
                accepted += 1;
            }
        }
    }
    (
        StatusCode::OK,
        Json(json!({"accepted": accepted, "store_size": store.len()})),
    )
        .into_response()
}

async fn sync_pull(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(body): Json<SyncPullBody>,
) -> Response {
    let session_id = match require_session(&st, &headers) {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    let since = body.since_epoch;
    let store = st.sync_blobs.lock().unwrap();
    let owners = st.blob_owners.lock().unwrap();
    let blobs: Vec<SyncBlob> = store
        .values()
        .filter(|b| b.epoch > since)
        .filter(|b| owners.get(&b.id).map(|o| o == &session_id).unwrap_or(false))
        .cloned()
        .collect();
    drop(owners);
    drop(store);
    let mut device_cursor = None;
    if let Some(device_id) = body.device_id.as_ref().filter(|s| !s.is_empty()) {
        let mut cursors = st.device_cursors.lock().unwrap();
        let max_epoch = blobs.iter().map(|b| b.epoch).max().unwrap_or(since);
        let entry = cursors.entry(device_id.clone()).or_insert(0);
        if max_epoch > *entry {
            *entry = max_epoch;
        }
        device_cursor = Some(*entry);
    }
    let _ = host_daemon::DEFAULT_LISTEN;
    Json(json!({
        "blobs": blobs,
        "plaintext": null,
        "note": "ciphertext only",
        "device_cursor": device_cursor,
        "daemon_default_listen": host_daemon::DEFAULT_LISTEN,
    }))
    .into_response()
}
