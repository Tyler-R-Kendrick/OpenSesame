//! Attachment replication target and replicate endpoints (ADR 0054).
//!
//! The free tier keeps sealed attachments in the git-native store. This is the
//! opt-in external tier: an organization points at a storage connection once,
//! and clients then push sealed bytes through these endpoints, which inject the
//! provider credential and forward.
//!
//! The gateway deliberately never holds attachment chunks and runs no
//! replication actor. It cannot: it has no store key, so every byte crossing
//! these routes is ciphertext it cannot read. That is also why there are no
//! outbox events here — there would be nothing for a consumer to replicate
//! from. Replication is client-driven by construction, not by omission.

use axum::{
    body::Bytes,
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use opensesame_storage::AttachmentTarget;
use serde::Deserialize;
use serde_json::json;

use crate::app_state::AppState;
use crate::middleware::auth::{require_operator, resolve_caller, Caller};

/// Largest sealed chunk frame: 1 MiB of plaintext plus AEAD overhead, rounded
/// to the chunk ceiling the store writes. Anything larger did not come from
/// this system.
pub const MAX_CHUNK_BODY: usize = 2_621_440;

/// Manifests are small — a digest list — but scale with chunk count.
pub const MAX_MANIFEST_BODY: usize = 1_048_576;

/// The only provider with an uploader implemented here. Others are refused at
/// configuration time rather than failing later on the first replicate call.
/// A sealed chunk is 1 MiB of plaintext plus a 48-byte frame. If either limit
/// is ever edited below what the store actually writes, replication would
/// reject the store's own output — so this fails the build, not a test run.
const _: () = assert!(MAX_CHUNK_BODY > 1_048_576 + 48);
const _: () = assert!(MAX_MANIFEST_BODY >= 1_048_576);

const SUPPORTED_PROVIDER: &str = "dropbox";

const DROPBOX_UPLOAD_URL: &str = "https://content.dropboxapi.com/2/files/upload";

fn require_configurator(
    st: &AppState,
    headers: &axum::http::HeaderMap,
) -> Result<Caller, Response> {
    require_operator(st, headers)?;
    Ok(Caller::Operator)
}

fn target_view(target: &AttachmentTarget) -> serde_json::Value {
    json!({
        "connection_id": target.connection_id,
        "provider_id": target.provider_id,
        "folder_path": target.folder_path,
        "enabled": target.enabled,
        "status": target.status,
        "last_error": target.last_error,
        "updated_at_unix_ms": target.updated_at_unix_ms,
    })
}

fn internal(error: impl std::fmt::Display) -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({"error":"internal","hint":error.to_string()})),
    )
        .into_response()
}

fn unprocessable(code: &str, hint: &str) -> Response {
    (
        StatusCode::UNPROCESSABLE_ENTITY,
        Json(json!({"error": code, "hint": hint})),
    )
        .into_response()
}

/// A destination folder on the provider: absolute, no traversal, no empty
/// segments. This string is interpolated into an upload path, so it is
/// validated here rather than trusted.
fn valid_folder_path(value: &str) -> bool {
    if value.is_empty() || value.len() > 512 || !value.starts_with('/') || value.ends_with('/') {
        return false;
    }
    if value.contains('\\') || value.chars().any(|c| c.is_control()) {
        return false;
    }
    value
        .split('/')
        .skip(1) // leading empty segment from the root slash
        .all(|segment| {
            !segment.is_empty()
                && segment != "."
                && segment != ".."
                && !segment.contains(':')
                && segment.chars().all(|c| !c.is_control())
        })
}

/// A store-logical attachment path such as `Taxes/2025`. Same shape the sealed
/// store enforces locally: relative, no traversal, no empty segments.
fn valid_logical_path(value: &str) -> bool {
    if value.is_empty() || value.len() > 512 || value.starts_with('/') || value.ends_with('/') {
        return false;
    }
    if value.contains('\\') || value.chars().any(|c| c.is_control()) {
        return false;
    }
    value.split('/').all(|segment| {
        !segment.is_empty() && segment != "." && segment != ".." && !segment.contains(':')
    })
}

fn valid_digest(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
}

pub async fn get_target(State(st): State<AppState>, headers: axum::http::HeaderMap) -> Response {
    let who = match require_configurator(&st, &headers) {
        Ok(who) => who,
        Err(resp) => return resp,
    };
    let organization = who.organization(st.connection_organization).to_string();
    match st.db.get_attachment_target(&organization).await {
        Ok(target) => (
            StatusCode::OK,
            Json(json!({ "target": target.as_ref().map(target_view) })),
        )
            .into_response(),
        Err(error) => internal(error),
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PutAttachmentTargetBody {
    pub connection_id: String,
    pub folder_path: String,
    #[serde(default)]
    pub enabled: Option<bool>,
}

pub async fn put_target(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(body): Json<PutAttachmentTargetBody>,
) -> Response {
    let who = match require_configurator(&st, &headers) {
        Ok(who) => who,
        Err(resp) => return resp,
    };
    let organization = who.organization(st.connection_organization);

    if !valid_folder_path(&body.folder_path) {
        return unprocessable(
            "invalid_folder_path",
            "folder_path must be an absolute provider path such as /OpenSesame/attachments, with no '..' or empty segments",
        );
    }

    // The connection must exist in this organization and be a provider we can
    // actually upload to. Refusing here means a misconfiguration surfaces at
    // configuration time rather than on the first replicate call.
    let connection = match st
        .connection_broker
        .get_connection(&organization, &body.connection_id)
        .await
    {
        Ok(view) => view,
        Err(error) => {
            return unprocessable(
                "connection_not_found",
                &format!("no such connection in this organization: {error}"),
            )
        }
    };
    if connection.provider_id != SUPPORTED_PROVIDER {
        return unprocessable(
            "provider_unsupported_for_attachments",
            &format!(
                "attachment replication currently uploads to {SUPPORTED_PROVIDER} only; this connection is {}",
                connection.provider_id
            ),
        );
    }

    let target = AttachmentTarget {
        organization_id: organization.to_string(),
        connection_id: body.connection_id,
        provider_id: connection.provider_id,
        folder_path: body.folder_path,
        enabled: body.enabled.unwrap_or(true),
        status: "configured".to_string(),
        last_error: None,
        updated_at_unix_ms: chrono::Utc::now().timestamp_millis(),
    };
    if let Err(error) = st.db.upsert_attachment_target(&target).await {
        return internal(error);
    }
    (StatusCode::OK, Json(json!({ "target": target_view(&target) }))).into_response()
}

pub async fn delete_target(State(st): State<AppState>, headers: axum::http::HeaderMap) -> Response {
    let who = match require_configurator(&st, &headers) {
        Ok(who) => who,
        Err(resp) => return resp,
    };
    let organization = who.organization(st.connection_organization).to_string();
    match st.db.delete_attachment_target(&organization).await {
        Ok(()) => (StatusCode::OK, Json(json!({ "deleted": true }))).into_response(),
        Err(error) => internal(error),
    }
}

/// The configured target, or a response explaining what to configure.
async fn active_target(st: &AppState, organization: &str) -> Result<AttachmentTarget, Response> {
    let target = match st.db.get_attachment_target(organization).await {
        Ok(Some(target)) => target,
        Ok(None) => {
            return Err(unprocessable(
                "no_attachment_target",
                "configure one with PUT /api/v1/attachments/target before replicating",
            ))
        }
        Err(error) => return Err(internal(error)),
    };
    if !target.enabled {
        return Err(unprocessable(
            "attachment_target_disabled",
            "the configured attachment target is disabled",
        ));
    }
    Ok(target)
}

/// Dropbox takes the destination as a JSON header rather than a path segment.
fn dropbox_arg(path: &str) -> String {
    json!({ "path": path, "mode": "overwrite", "mute": true }).to_string()
}

/// Push one sealed object to the provider, recording a failure against the
/// target so an operator can see why replication stopped working.
async fn upload(
    st: &AppState,
    organization: &opensesame_domain::OrganizationId,
    target: &AttachmentTarget,
    remote_path: String,
    body: Vec<u8>,
) -> Response {
    let headers = vec![("Dropbox-API-Arg".to_string(), dropbox_arg(&remote_path))];
    match st
        .connection_broker
        .authorized_bytes(
            organization,
            &target.connection_id,
            DROPBOX_UPLOAD_URL,
            &headers,
            body,
        )
        .await
    {
        Ok(()) => {
            let _ = st
                .db
                .record_attachment_target_error(&target.organization_id, None)
                .await;
            (StatusCode::OK, Json(json!({ "stored": true }))).into_response()
        }
        Err(error) => {
            let message = error.to_string();
            let _ = st
                .db
                .record_attachment_target_error(&target.organization_id, Some(&message))
                .await;
            (
                StatusCode::BAD_GATEWAY,
                Json(json!({"error":"upstream_upload_failed","hint": message})),
            )
                .into_response()
        }
    }
}

#[derive(Deserialize)]
pub struct ChunkQuery {
    pub digest: String,
}

pub async fn replicate_chunk(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Query(query): Query<ChunkQuery>,
    body: Bytes,
) -> Response {
    let who = match resolve_caller(&st, &headers) {
        Ok(who) => who,
        Err(resp) => return resp,
    };
    let organization = who.organization(st.connection_organization);

    if !valid_digest(&query.digest) {
        return unprocessable("invalid_digest", "digest must be 64 lowercase hex characters");
    }
    if body.is_empty() {
        return unprocessable("empty_body", "a chunk frame cannot be empty");
    }

    // Verify what we are about to forward. The gateway learns nothing from this
    // — the body is ciphertext either way — but a mismatch means the object
    // would be filed under a digest that does not describe it, and the manifest
    // that names that digest would never reassemble.
    let actual = blake3::hash(&body).to_hex().to_string();
    if actual != query.digest.to_ascii_lowercase() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "error": "digest_mismatch",
                "hint": "the body does not hash to the claimed digest",
            })),
        )
            .into_response();
    }

    let target = match active_target(&st, &organization.to_string()).await {
        Ok(target) => target,
        Err(resp) => return resp,
    };
    let shard = &actual[0..2];
    let remote = format!("{}/objects/{shard}/{actual}.oschunk", target.folder_path);
    upload(&st, &organization, &target, remote, body.to_vec()).await
}

#[derive(Deserialize)]
pub struct ManifestQuery {
    pub path: String,
}

pub async fn replicate_manifest(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Query(query): Query<ManifestQuery>,
    body: Bytes,
) -> Response {
    let who = match resolve_caller(&st, &headers) {
        Ok(who) => who,
        Err(resp) => return resp,
    };
    let organization = who.organization(st.connection_organization);

    if !valid_logical_path(&query.path) {
        return unprocessable(
            "invalid_path",
            "path must be a store-logical path such as Taxes/2025, with no '..' or empty segments",
        );
    }
    if body.is_empty() {
        return unprocessable("empty_body", "a manifest cannot be empty");
    }

    let target = match active_target(&st, &organization.to_string()).await {
        Ok(target) => target,
        Err(resp) => return resp,
    };
    let remote = format!(
        "{}/manifests/{}.osattach",
        target.folder_path, query.path
    );
    upload(&st, &organization, &target, remote, body.to_vec()).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_state::test_demo_state;
    use axum::{
        body::Body,
        http::{Request, StatusCode},
        Router,
    };
    use opensesame_connection_broker::{
        BrokerConfig, ConnectionBroker, CreateConnection, CreateIntegration,
    };
    use opensesame_domain::Shareability;
    use std::sync::Arc;
    use tower::ServiceExt;

    fn app(state: AppState) -> Router {
        crate::routes::router(state)
    }

    fn operator(st: &AppState) -> String {
        st.operator_token.clone()
    }

    /// A state whose broker is backed by the same pool, so connections created
    /// here are the ones the routes resolve.
    async fn state_with_broker() -> AppState {
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

    async fn make_connection(st: &AppState, provider_id: &str) -> String {
        let org = st.connection_organization;
        // Dropbox authenticates with OAuth, so a connection needs an
        // integration to hang off; API-key providers do not.
        let integration_id = if provider_id == "dropbox" {
            Some(
                st.connection_broker
                    .create_integration(
                        &org,
                        CreateIntegration {
                            key: format!("{provider_id}-attachments"),
                            provider_id: provider_id.into(),
                            display_name: "Attachments".into(),
                            scopes: vec!["files.content.write".into()],
                            client_id: Some("client".into()),
                            client_secret: Some("secret".into()),
                            configuration: Default::default(),
                            created_by: "principal:attach-tester".into(),
                        },
                    )
                    .await
                    .unwrap()
                    .id,
            )
        } else {
            None
        };
        st.connection_broker
            .create_connection(
                &org,
                CreateConnection {
                    provider_id: provider_id.into(),
                    integration_id,
                    owner_subject: Some("principal:attach-tester".into()),
                    display_name: Some(provider_id.into()),
                    logical_name: None,
                    project_id: None,
                    scopes: None,
                    shareability: Some(Shareability::Private),
                },
            )
            .await
            .unwrap()
            .connection_id
    }

    fn put_target_req(token: &str, body: serde_json::Value) -> Request<Body> {
        Request::builder()
            .method("PUT")
            .uri("/api/v1/attachments/target")
            .header("content-type", "application/json")
            .header("x-opensesame-operator", token)
            .body(Body::from(body.to_string()))
            .unwrap()
    }

    async fn body_json(res: axum::response::Response) -> serde_json::Value {
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap();
        serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null)
    }

    #[tokio::test]
    async fn target_round_trips_and_delete_clears_it() {
        let st = state_with_broker().await;
        let token = operator(&st);
        let connection = make_connection(&st, "dropbox").await;
        let app = app(st.clone());

        let res = app
            .clone()
            .oneshot(put_target_req(
                &token,
                json!({
                    "connection_id": connection,
                    "folder_path": "/OpenSesame/attachments"
                }),
            ))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);

        let res = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/v1/attachments/target")
                    .header("x-opensesame-operator", &token)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let got = body_json(res).await;
        assert_eq!(got["target"]["folder_path"], "/OpenSesame/attachments");
        assert_eq!(got["target"]["provider_id"], "dropbox");
        assert_eq!(got["target"]["enabled"], true);

        let res = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri("/api/v1/attachments/target")
                    .header("x-opensesame-operator", &token)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);

        let res = app
            .oneshot(
                Request::builder()
                    .uri("/api/v1/attachments/target")
                    .header("x-opensesame-operator", &token)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(body_json(res).await["target"].is_null());
    }

    #[tokio::test]
    async fn a_provider_with_no_uploader_is_refused_at_configuration_time() {
        // Failing here rather than on the first replicate call is the whole
        // point: the operator learns immediately, not after a partial sync.
        let st = state_with_broker().await;
        let token = operator(&st);
        let connection = make_connection(&st, "vercel").await;
        let res = app(st)
            .oneshot(put_target_req(
                &token,
                json!({"connection_id": connection, "folder_path": "/x"}),
            ))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(
            body_json(res).await["error"],
            "provider_unsupported_for_attachments"
        );
    }

    #[tokio::test]
    async fn a_traversing_folder_path_is_refused() {
        let st = state_with_broker().await;
        let token = operator(&st);
        let connection = make_connection(&st, "dropbox").await;
        let app = app(st);
        for bad in ["/has/../traversal", "relative", "", "/trailing/"] {
            let res = app
                .clone()
                .oneshot(put_target_req(
                    &token,
                    json!({"connection_id": connection, "folder_path": bad}),
                ))
                .await
                .unwrap();
            assert_eq!(
                res.status(),
                StatusCode::UNPROCESSABLE_ENTITY,
                "folder_path {bad:?} must be refused"
            );
        }
    }

    #[tokio::test]
    async fn an_unknown_connection_cannot_be_configured() {
        let st = state_with_broker().await;
        let token = operator(&st);
        let res = app(st)
            .oneshot(put_target_req(
                &token,
                json!({"connection_id": "connection:nope", "folder_path": "/x"}),
            ))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(body_json(res).await["error"], "connection_not_found");
    }

    #[tokio::test]
    async fn target_routes_are_operator_gated() {
        let st = state_with_broker().await;
        let app = app(st);
        let res = app
            .oneshot(
                Request::builder()
                    .uri("/api/v1/attachments/target")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_ne!(res.status(), StatusCode::OK, "must not answer unauthenticated");
    }

    #[tokio::test]
    async fn a_chunk_whose_body_does_not_match_its_digest_is_refused() {
        // The gateway forwards ciphertext it cannot read, but it can still tell
        // that an object filed under this digest would never reassemble.
        let st = state_with_broker().await;
        let token = operator(&st);
        let connection = make_connection(&st, "dropbox").await;
        let app = app(st);
        app.clone()
            .oneshot(put_target_req(
                &token,
                json!({"connection_id": connection, "folder_path": "/OpenSesame"}),
            ))
            .await
            .unwrap();

        let res = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!(
                        "/api/v1/attachments/replicate/chunk?digest={}",
                        "ab".repeat(32)
                    ))
                    .header("x-opensesame-operator", &token)
                    .header("content-type", "application/octet-stream")
                    .body(Body::from(b"not the bytes that hash to that".to_vec()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);
        assert_eq!(body_json(res).await["error"], "digest_mismatch");
    }

    #[tokio::test]
    async fn replicating_without_a_target_says_what_to_configure() {
        let st = state_with_broker().await;
        let token = operator(&st);
        let payload = b"sealed chunk bytes".to_vec();
        let digest = blake3::hash(&payload).to_hex().to_string();
        let res = app(st)
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/api/v1/attachments/replicate/chunk?digest={digest}"))
                    .header("x-opensesame-operator", &token)
                    .header("content-type", "application/octet-stream")
                    .body(Body::from(payload))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let got = body_json(res).await;
        assert_eq!(got["error"], "no_attachment_target");
        assert!(
            got["hint"].as_str().unwrap_or_default().contains("PUT"),
            "the refusal should name the fix: {got}"
        );
    }

    #[tokio::test]
    async fn a_traversing_manifest_path_is_refused() {
        let st = state_with_broker().await;
        let token = operator(&st);
        let res = app(st)
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/attachments/replicate/manifest?path=../../escape")
                    .header("x-opensesame-operator", &token)
                    .header("content-type", "application/octet-stream")
                    .body(Body::from(b"sealed manifest".to_vec()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(body_json(res).await["error"], "invalid_path");
    }

    #[test]
    fn folder_paths_must_be_absolute_and_traversal_free() {
        assert!(valid_folder_path("/OpenSesame/attachments"));
        assert!(valid_folder_path("/a"));
        // These all end up interpolated into an upload path.
        assert!(!valid_folder_path(""));
        assert!(!valid_folder_path("relative/path"));
        assert!(!valid_folder_path("/trailing/"));
        assert!(!valid_folder_path("/has/../traversal"));
        assert!(!valid_folder_path("/has//empty"));
        assert!(!valid_folder_path("/has/./dot"));
        assert!(!valid_folder_path("/has\\backslash"));
        assert!(!valid_folder_path("/has\u{0}nul"));
        assert!(!valid_folder_path(&format!("/{}", "a".repeat(600))));
    }

    #[test]
    fn logical_paths_are_relative_and_traversal_free() {
        assert!(valid_logical_path("Taxes/2025"));
        assert!(valid_logical_path("one"));
        assert!(!valid_logical_path("/absolute"));
        assert!(!valid_logical_path("../escape"));
        assert!(!valid_logical_path("has//empty"));
        assert!(!valid_logical_path("trailing/"));
        assert!(!valid_logical_path("has\\backslash"));
        assert!(!valid_logical_path(""));
    }

    #[test]
    fn digests_are_strict_hex() {
        assert!(valid_digest(&"a".repeat(64)));
        assert!(valid_digest(&"0123456789abcdef".repeat(4)));
        assert!(!valid_digest(&"a".repeat(63)));
        assert!(!valid_digest(&"a".repeat(65)));
        assert!(!valid_digest(&"g".repeat(64)));
        assert!(!valid_digest("../../etc/passwd"));
        assert!(!valid_digest(""));
    }

    #[test]
    fn dropbox_arg_overwrites_and_stays_quiet() {
        let arg = dropbox_arg("/OpenSesame/attachments/objects/ab/abcd.oschunk");
        assert!(arg.contains("\"mode\":\"overwrite\""), "{arg}");
        assert!(arg.contains("\"mute\":true"), "{arg}");
        assert!(arg.contains("/OpenSesame/attachments"), "{arg}");
    }
}
