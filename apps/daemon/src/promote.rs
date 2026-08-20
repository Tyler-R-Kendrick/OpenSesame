//! Promotion handshake (ADR 0048 D4): `POST /v1/promote` turns one discovery
//! offer into a broker connection under an explicit acquisition mode.
//!
//! Discovery offers; this route acts — and only on explicit confirmation:
//!
//! - **confirm is the gate.** `confirm != true` is a 400 and nothing is read,
//!   probed, or forwarded. No confirm, no read.
//! - **The offer is re-derived, never trusted.** The requested
//!   `(provider_id, source)` pair is matched against a fresh, value-blind probe
//!   walk, so a stale or fabricated source fails closed with 404
//!   `offer_not_found`, and a mode the offer does not carry is 422
//!   `mode_not_viable`.
//! - **import** reads exactly the named source — one env var, one dotfile, one
//!   MCP env *value* (the only place an MCP value is ever read, and only
//!   post-confirm) — and seals it through the gateway's
//!   `POST /api/v1/connections/{id}/credential`. Keychain and CLI-tool sources
//!   have no readable material in v1 (keychain value reads need OS-specific
//!   ACL mediation, deferred per ADR 0048 §3c) and answer 422
//!   `source_not_readable`. The material lives in a [`Zeroizing`] string for
//!   its short stay and is never logged; the gateway-side connection events
//!   (create/credential-set) already cover the seal itself.
//! - **mint** creates-or-reuses the connection and opts it into
//!   `materialization = derived_short_lived` (ADR 0049), preserving the
//!   existing shareability/invoke-level policy. The daemon does not mint here:
//!   GitHub App minting needs an `installation_id` the daemon cannot know, so
//!   the response carries `next.mint.installation_id_required` and the operator
//!   supplies it per `POST /api/v1/connections/{id}/mint` call.
//! - **invoke_through** is stateless by design (ADR 0048 D7): the daemon
//!   brokers the call at invocation time and holds no credential, so there is
//!   no connection policy to persist and no gateway call to make.
//!
//! Fail closed everywhere: any gateway non-2xx on the create/seal/policy path
//! is a 502, no wipe runs, and no partial state is claimed. A wipe
//! (`wipe_after_import`) happens only *after* the gateway confirms the seal
//! with 2xx; env vars cannot be wiped by the daemon and say so in the
//! response.

use axum::{
    extract::{ConnectInfo, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Extension, Json,
};
use opensesame_connection_detect::{
    OfferItem, ProbeContext, ProbeSource, PromoteRequest, PromotionMode,
};
use serde_json::{json, Value};
use std::path::PathBuf;
use zeroize::Zeroizing;

use crate::{operator_forward_method, rate_limited, require_operator, App, RateKey, UdsPeer};

/// Body cap for this route, matching the gateway's connection-route budget
/// scaled to the largest field we carry (a dotfile path).
pub const MAX_BODY_BYTES: usize = 16 * 1024;

/// `POST /v1/promote` — operator-gated exactly like `/v1/discover`, but
/// mutating, so it spends from its own stricter bucket rather than the
/// discovery one.
pub async fn promote(
    State(st): State<App>,
    uds: UdsPeer,
    headers: HeaderMap,
    Json(req): Json<PromoteRequest>,
) -> Response {
    if let Err(resp) = require_operator(&st, &headers, &uds) {
        return resp;
    }
    let key = match uds.and_then(|Extension(ConnectInfo(info))| info.0) {
        Some(cred) => RateKey::Uid(cred.uid),
        None => RateKey::TcpOperator,
    };
    if let Err(retry_after) = st.promote_limiter.check(key) {
        return rate_limited(retry_after);
    }
    if !req.confirm {
        refused(&req, "not_confirmed");
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "error": "promotion_not_confirmed",
                "hint": "promotion may read credential material; pass confirm: true"
            })),
        )
            .into_response();
    }
    // Re-derive the offer set rather than trusting the client's claim about
    // what this machine holds. The walk spawns processes and talks to the
    // platform keychain — blocking work, off the async driver threads.
    let derived = tokio::task::spawn_blocking(|| {
        let ctx = crate::discovery::probe_context();
        let items = crate::discovery::offers(&ctx);
        (ctx, items)
    })
    .await;
    let (ctx, items) = match derived {
        Ok(derived) => derived,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    promote_with(&st, &ctx, &items, req).await
}

/// The promote decision with the offer set and probe context injected, so
/// tests drive it hermetically.
async fn promote_with(
    st: &App,
    ctx: &ProbeContext,
    items: &[OfferItem],
    req: PromoteRequest,
) -> Response {
    let Some(offer) = items.iter().find(|item| {
        item.provider_id == req.provider_id && source_matches(&item.source, &req.source)
    }) else {
        refused(&req, "offer_not_found");
        return (
            StatusCode::NOT_FOUND,
            Json(json!({
                "error": "offer_not_found",
                "hint": "this provider+source pair is not currently offered; re-run /v1/discover"
            })),
        )
            .into_response();
    };
    if !offer.capabilities.contains(&req.mode.capability()) {
        refused(&req, "mode_not_viable");
        return (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(json!({
                "error": "mode_not_viable",
                "capabilities": offer.capabilities,
            })),
        )
            .into_response();
    }
    tracing::info!(
        provider_id = %req.provider_id,
        source_kind = source_kind(&req.source),
        mode = req.mode.name(),
        "promotion.confirmed"
    );
    match req.mode {
        PromotionMode::Import => import(st, ctx, &req, offer).await,
        PromotionMode::Mint => mint(st, &req).await,
        PromotionMode::InvokeThrough => invoke_through(&req),
    }
}

/// Match the requested source against an offered one by *identity* — the same
/// rule the offer merge uses — so a client that echoes `/v1/discover` output
/// matches, and anything else fails closed. MCP env keys and CLI versions do
/// not distinguish an offer; the env key to import is resolved separately.
fn source_matches(offered: &ProbeSource, requested: &ProbeSource) -> bool {
    match (offered, requested) {
        (ProbeSource::EnvVar { name: a }, ProbeSource::EnvVar { name: b }) => a == b,
        (ProbeSource::DotFile { path: a }, ProbeSource::DotFile { path: b }) => a == b,
        (
            ProbeSource::Keychain {
                store: a,
                item_label: la,
            },
            ProbeSource::Keychain {
                store: b,
                item_label: lb,
            },
        ) => a == b && la == lb,
        (
            ProbeSource::McpConfig {
                path: pa,
                server_name: sa,
                ..
            },
            ProbeSource::McpConfig {
                path: pb,
                server_name: sb,
                ..
            },
        ) => pa == pb && sa == sb,
        (ProbeSource::CliTool { binary: a, .. }, ProbeSource::CliTool { binary: b, .. }) => a == b,
        _ => false,
    }
}

fn source_kind(source: &ProbeSource) -> &'static str {
    match source {
        ProbeSource::EnvVar { .. } => "env_var",
        ProbeSource::DotFile { .. } => "dot_file",
        ProbeSource::Keychain { .. } => "keychain",
        ProbeSource::McpConfig { .. } => "mcp_config",
        ProbeSource::CliTool { .. } => "cli_tool",
    }
}

/// I9 audit: a refused promotion is as worth answering for as a granted one.
/// Fields name the provider, source *kind*, and mode — never the source's
/// value-bearing details, and never a value.
fn refused(req: &PromoteRequest, reason: &'static str) {
    tracing::info!(
        provider_id = %req.provider_id,
        source_kind = source_kind(&req.source),
        mode = req.mode.name(),
        reason,
        "promotion.refused"
    );
}

// ——— import ———————————————————————————————————————————————————————

/// What a successful import read leaves behind for the wipe step.
enum ImportTarget {
    /// Env vars cannot be wiped by the daemon; the response says so.
    EnvVar,
    DotFile(PathBuf),
    McpConfig {
        path: PathBuf,
        server_name: String,
        key: String,
    },
}

async fn import(st: &App, ctx: &ProbeContext, req: &PromoteRequest, offer: &OfferItem) -> Response {
    let (material, target) = match read_source_material(&req.source, ctx, offer) {
        Ok(read) => read,
        Err(resp) => {
            refused(req, "source_not_readable");
            return resp;
        }
    };
    let connection = match ensure_connection(st, &req.provider_id).await {
        Ok(connection) => connection,
        Err(resp) => return resp,
    };
    // The gateway records its own connection events for the seal (credential
    // set), so the daemon's audit stays at the promotion level and never
    // touches the value.
    let url = format!(
        "{}/api/v1/connections/{}/credential",
        st.host_api, connection.id
    );
    let forward = match operator_forward_method(st, reqwest::Method::POST, &url) {
        Ok(forward) => forward,
        Err(resp) => return resp,
    };
    // The serde_json body necessarily holds a second copy of the material for
    // the duration of the request; the canonical copy stays Zeroizing and the
    // body is dropped with the response.
    let sealed = match forward
        .json(&json!({"value": material.as_str()}))
        .send()
        .await
    {
        Ok(response) if response.status().is_success() => true,
        Ok(response) => {
            return gateway_failure("seal", Some(response.status().as_u16()));
        }
        Err(_) => {
            return gateway_failure("seal", None);
        }
    };
    debug_assert!(sealed);
    drop(material);
    // The seal is confirmed — only now may a requested wipe run.
    let (wiped, wipe_note) = wipe_after_import(req, &target);
    tracing::info!(
        provider_id = %req.provider_id,
        source_kind = source_kind(&req.source),
        mode = req.mode.name(),
        wiped,
        "promotion.imported"
    );
    let mut body = json!({
        "provider_id": req.provider_id,
        "mode": "import",
        "connection_id": connection.id,
        "connection_ref": connection.connection_ref,
        "wiped": wiped,
    });
    if let Some(note) = wipe_note {
        body["wipe_note"] = json!(note);
    }
    Json(body).into_response()
}

/// Read exactly the material the confirmed source names. This is the only
/// value-reading code on the promote path, and it runs only post-confirm:
/// one env var from the probe snapshot, one dotfile under the read cap, or
/// one named MCP env value. Keychain and CLI-tool sources carry no readable
/// material in v1.
fn read_source_material(
    source: &ProbeSource,
    ctx: &ProbeContext,
    offer: &OfferItem,
) -> Result<(Zeroizing<String>, ImportTarget), Response> {
    match source {
        ProbeSource::EnvVar { name } => ctx
            .env
            .get(name)
            .filter(|value| !value.is_empty())
            .map(|value| (Zeroizing::new(value.clone()), ImportTarget::EnvVar))
            .ok_or_else(|| source_changed("environment variable is no longer set")),
        ProbeSource::DotFile { path } => {
            let raw = read_capped(path, ctx.max_read_bytes)?;
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                return Err(source_changed("file is now empty"));
            }
            Ok((
                Zeroizing::new(trimmed.to_string()),
                ImportTarget::DotFile(path.clone()),
            ))
        }
        ProbeSource::McpConfig {
            path,
            server_name,
            env_keys,
        } => {
            let key = resolve_mcp_key(env_keys, offer)?;
            let raw = read_capped(path, ctx.max_read_bytes)?;
            let parsed: Value = serde_json::from_str(&raw)
                .map_err(|_| source_changed("MCP config no longer parses"))?;
            let value = parsed
                .get("mcpServers")
                .and_then(|servers| servers.get(server_name))
                .and_then(|server| server.get("env"))
                .and_then(|env| env.get(&key))
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| source_changed("the named MCP env key is no longer set"))?;
            Ok((
                Zeroizing::new(value.to_string()),
                ImportTarget::McpConfig {
                    path: path.clone(),
                    server_name: server_name.clone(),
                    key,
                },
            ))
        }
        ProbeSource::Keychain { .. } => Err(source_not_readable(
            "keychain value reads need OS-specific ACL mediation; deferred in v1 (ADR 0048 §3c)",
        )),
        ProbeSource::CliTool { .. } => Err(source_not_readable(
            "a CLI binary carries no importable material; promote with invoke_through or mint",
        )),
    }
}

/// Read a dotfile under the probe cap: oversized files are refused, not
/// truncated (a truncated credential file is worse than none).
fn read_capped(path: &std::path::Path, max_read_bytes: usize) -> Result<String, Response> {
    let len = std::fs::metadata(path)
        .map_err(|_| source_changed("file is no longer readable"))?
        .len();
    if len > max_read_bytes as u64 {
        return Err(source_not_readable("file exceeds the read cap"));
    }
    std::fs::read_to_string(path).map_err(|_| source_changed("file is no longer readable"))
}

/// The single MCP env key to import. The request must name exactly one, and
/// it must be among the keys the offer reported — a bulk import of every env
/// value in a server stanza is deliberately not a shape this route accepts.
fn resolve_mcp_key(requested: &[String], offer: &OfferItem) -> Result<String, Response> {
    let offered: &[String] = match &offer.source {
        ProbeSource::McpConfig { env_keys, .. } => env_keys,
        _ => &[],
    };
    match requested {
        [only] if offered.contains(only) => Ok(only.clone()),
        [only] => Err((
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(json!({
                "error": "env_key_not_offered",
                "hint": format!("`{only}` is not among the offered env keys")
            })),
        )
            .into_response()),
        _ => Err((
            StatusCode::BAD_REQUEST,
            Json(json!({
                "error": "env_key_required",
                "hint": "name exactly one env key in source.env_keys to import"
            })),
        )
            .into_response()),
    }
}

/// Wipe the source after a confirmed seal. A failed wipe is reported, not
/// hidden — the credential is sealed either way, and claiming `wiped: true`
/// would be a lie.
fn wipe_after_import(req: &PromoteRequest, target: &ImportTarget) -> (bool, Option<String>) {
    if !req.wipe_after_import {
        return (false, None);
    }
    match target {
        ImportTarget::EnvVar => (
            false,
            Some(
                "environment variables cannot be wiped by the daemon; unset it in your shell startup"
                    .to_string(),
            ),
        ),
        ImportTarget::DotFile(path) => match std::fs::remove_file(path) {
            Ok(()) => (true, None),
            Err(error) => (false, Some(format!("wipe failed: {error}"))),
        },
        ImportTarget::McpConfig {
            path,
            server_name,
            key,
        } => match wipe_mcp_key(path, server_name, key) {
            Ok(()) => (true, None),
            Err(error) => (false, Some(format!("wipe failed: {error}"))),
        },
    }
}

/// Rewrite an MCP config with one env key removed, preserving the rest of the
/// document. Refuses to touch a file that no longer parses.
fn wipe_mcp_key(path: &std::path::Path, server_name: &str, key: &str) -> Result<(), String> {
    let raw = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    let mut parsed: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    let Some(env) = parsed
        .get_mut("mcpServers")
        .and_then(|servers| servers.get_mut(server_name))
        .and_then(|server| server.get_mut("env"))
        .and_then(Value::as_object_mut)
    else {
        return Err("the server stanza is gone".to_string());
    };
    env.remove(key);
    let rendered = serde_json::to_string_pretty(&parsed).map_err(|e| e.to_string())?;
    std::fs::write(path, format!("{rendered}\n")).map_err(|e| e.to_string())
}

// ——— mint —————————————————————————————————————————————————————————

/// Opt the connection into derived short-lived materialization (ADR 0049).
/// The daemon cannot mint by itself: GitHub's mint path needs the App
/// `installation_id`, which is operator knowledge, so the response names the
/// mint endpoint and flags `installation_id_required` instead of pretending.
async fn mint(st: &App, req: &PromoteRequest) -> Response {
    let connection = match ensure_connection(st, &req.provider_id).await {
        Ok(connection) => connection,
        Err(resp) => return resp,
    };
    let (Some(shareability), Some(max_invoke_level)) =
        (connection.shareability, connection.max_invoke_level)
    else {
        return gateway_failure("policy", None);
    };
    let url = format!("{}/api/v1/connections/{}", st.host_api, connection.id);
    let forward = match operator_forward_method(st, reqwest::Method::PATCH, &url) {
        Ok(forward) => forward,
        Err(resp) => return resp,
    };
    // PATCH replaces the full policy on this gateway route, so the existing
    // shareability and invoke level are read back and carried through
    // unchanged; only materialization moves.
    let policy = json!({
        "shareability": shareability,
        "max_invoke_level": max_invoke_level,
        "materialization": "derived_short_lived",
    });
    match forward.json(&policy).send().await {
        Ok(response) if response.status().is_success() => {}
        Ok(response) => return gateway_failure("policy", Some(response.status().as_u16())),
        Err(_) => return gateway_failure("policy", None),
    }
    tracing::info!(
        provider_id = %req.provider_id,
        source_kind = source_kind(&req.source),
        mode = req.mode.name(),
        materialization = "derived_short_lived",
        "promotion.imported"
    );
    Json(json!({
        "provider_id": req.provider_id,
        "mode": "mint",
        "connection_id": connection.id,
        "connection_ref": connection.connection_ref,
        "materialization": "derived_short_lived",
        "next": {
            "mint": {
                "endpoint": format!("/api/v1/connections/{}/mint", connection.id),
                "installation_id_required": req.provider_id == "github",
            }
        }
    }))
    .into_response()
}

// ——— invoke-through ————————————————————————————————————————————————

/// Stateless by design (ADR 0048 D7): invoke-through holds no credential and
/// brokers the upstream call at invocation time, so promotion records nothing
/// — there is no policy field that would make the later call more correct.
fn invoke_through(req: &PromoteRequest) -> Response {
    tracing::info!(
        provider_id = %req.provider_id,
        source_kind = source_kind(&req.source),
        mode = req.mode.name(),
        "promotion.imported"
    );
    Json(json!({
        "provider_id": req.provider_id,
        "mode": "invoke_through",
        "persisted": false,
        "note": "invoke-through needs no stored credential or policy; \
                 the daemon brokers the call at invocation time",
    }))
    .into_response()
}

// ——— gateway plumbing ——————————————————————————————————————————————

/// The gateway identity of a connection this daemon created or adopted.
struct ConnectionHandle {
    id: String,
    connection_ref: Option<String>,
    shareability: Option<String>,
    max_invoke_level: Option<u64>,
}

fn parse_connection_view(view: &Value) -> Option<ConnectionHandle> {
    Some(ConnectionHandle {
        id: view.get("connection_id")?.as_str()?.to_string(),
        connection_ref: view
            .get("connection_ref")
            .and_then(Value::as_str)
            .map(str::to_string),
        shareability: view
            .get("shareability")
            .and_then(Value::as_str)
            .map(str::to_string),
        max_invoke_level: view.get("max_invoke_level").and_then(Value::as_u64),
    })
}

/// Reuse the first connection this organization already has for the provider,
/// or create one. Listing first keeps repeated promotions idempotent instead
/// of growing a connection per call.
async fn ensure_connection(st: &App, provider_id: &str) -> Result<ConnectionHandle, Response> {
    let url = format!("{}/api/v1/connections", st.host_api);
    let list = match operator_forward_method(st, reqwest::Method::GET, &url) {
        Ok(forward) => forward,
        Err(resp) => return Err(resp),
    };
    let listed = match list.send().await {
        Ok(response) if response.status().is_success() => response,
        Ok(response) => return Err(gateway_failure("list", Some(response.status().as_u16()))),
        Err(_) => return Err(gateway_failure("list", None)),
    };
    let body: Value = listed
        .json()
        .await
        .map_err(|_| gateway_failure("list", None))?;
    if let Some(existing) =
        body.get("connections")
            .and_then(Value::as_array)
            .and_then(|connections| {
                connections
                    .iter()
                    .filter(|view| {
                        view.get("provider_id").and_then(Value::as_str) == Some(provider_id)
                    })
                    .find_map(parse_connection_view)
            })
    {
        return Ok(existing);
    }
    let create = match operator_forward_method(st, reqwest::Method::POST, &url) {
        Ok(forward) => forward,
        Err(resp) => return Err(resp),
    };
    let created = match create
        .json(&json!({"provider_id": provider_id}))
        .send()
        .await
    {
        Ok(response) if response.status().is_success() => response,
        Ok(response) => return Err(gateway_failure("create", Some(response.status().as_u16()))),
        Err(_) => return Err(gateway_failure("create", None)),
    };
    let view: Value = created
        .json()
        .await
        .map_err(|_| gateway_failure("create", None))?;
    parse_connection_view(&view).ok_or_else(|| gateway_failure("create", None))
}

fn source_changed(detail: &'static str) -> Response {
    (
        StatusCode::CONFLICT,
        Json(json!({
            "error": "source_changed",
            "hint": format!("{detail}; re-run /v1/discover")
        })),
    )
        .into_response()
}

fn source_not_readable(detail: &'static str) -> Response {
    (
        StatusCode::UNPROCESSABLE_ENTITY,
        Json(json!({"error": "source_not_readable", "hint": detail})),
    )
        .into_response()
}

/// Any gateway non-2xx on the promotion path is a 502 with no partial-state
/// claims: the caller learns the stage and the upstream status, nothing more.
fn gateway_failure(stage: &'static str, status: Option<u16>) -> Response {
    (
        StatusCode::BAD_GATEWAY,
        Json(json!({
            "error": "gateway_failure",
            "stage": stage,
            "gateway_status": status,
        })),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::test_state;
    use axum::{routing::get, routing::patch, routing::post, Router};
    use opensesame_connection_detect::{
        CapabilityClass, Confidence, KeychainStore, MockCommandRunner, MockKeychain,
    };
    use std::collections::BTreeMap;
    use std::sync::{Arc, Mutex};

    const CANARY: &str = "PLANTED-PROMOTE-VALUE-MUST-NOT-ESCAPE";
    const OTHER: &str = "PLANTED-OTHER-MCP-VALUE-MUST-NOT-ESCAPE";

    /// Runs inside the stub's credential handler, so a test can assert on
    /// filesystem state at the moment the seal arrives.
    type SealGate = Arc<Mutex<Option<Box<dyn Fn() + Send>>>>;

    /// A stub Host API that records every call and can be told to fail the
    /// seal.
    #[derive(Clone, Default)]
    struct Stub {
        calls: Arc<Mutex<Vec<(String, String, Value)>>>,
        fail_seal: Arc<Mutex<bool>>,
        seal_gate: SealGate,
    }

    impl Stub {
        fn record(&self, method: &str, path: &str, body: Value) {
            self.calls
                .lock()
                .unwrap()
                .push((method.to_string(), path.to_string(), body));
        }

        fn calls(&self) -> Vec<(String, String, Value)> {
            self.calls.lock().unwrap().clone()
        }
    }

    fn connection_view(provider: &str) -> Value {
        json!({
            "connection_id": "conn_stub",
            "connection_ref": "opensesame://connection/conn_stub",
            "provider_id": provider,
            "shareability": "private",
            "max_invoke_level": 2,
        })
    }

    async fn spawn_stub(stub: Stub) -> String {
        let list_stub = stub.clone();
        let create_stub = stub.clone();
        let seal_stub = stub.clone();
        let policy_stub = stub;
        let app = Router::new()
            .route(
                "/api/v1/connections",
                get(move || {
                    let stub = list_stub.clone();
                    async move {
                        stub.record("GET", "/api/v1/connections", Value::Null);
                        Json(json!({"connections": []}))
                    }
                })
                .post(move |Json(body): Json<Value>| {
                    let stub = create_stub.clone();
                    async move {
                        stub.record("POST", "/api/v1/connections", body.clone());
                        let provider = body
                            .get("provider_id")
                            .and_then(Value::as_str)
                            .unwrap_or("unknown");
                        (StatusCode::CREATED, Json(connection_view(provider)))
                    }
                }),
            )
            .route(
                "/api/v1/connections/{id}/credential",
                post(
                    move |axum::extract::Path(id): axum::extract::Path<String>,
                          Json(body): Json<Value>| {
                        let stub = seal_stub.clone();
                        async move {
                            if let Some(gate) = stub.seal_gate.lock().unwrap().as_ref() {
                                gate();
                            }
                            stub.record(
                                "POST",
                                &format!("/api/v1/connections/{id}/credential"),
                                body,
                            );
                            if *stub.fail_seal.lock().unwrap() {
                                return StatusCode::INTERNAL_SERVER_ERROR.into_response();
                            }
                            Json(connection_view("github")).into_response()
                        }
                    },
                ),
            )
            .route(
                "/api/v1/connections/{id}",
                patch(
                    move |axum::extract::Path(id): axum::extract::Path<String>,
                          Json(body): Json<Value>| {
                        let stub = policy_stub.clone();
                        async move {
                            stub.record("PATCH", &format!("/api/v1/connections/{id}"), body);
                            Json(connection_view("github"))
                        }
                    },
                ),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        format!("http://{addr}")
    }

    struct Fixture {
        home: tempfile::TempDir,
    }

    impl Fixture {
        fn new() -> Self {
            Self {
                home: tempfile::tempdir().expect("tempdir"),
            }
        }

        fn write_home_file(&self, relative: &str, contents: &str) -> PathBuf {
            let path = self.home.path().join(relative);
            std::fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
            std::fs::write(&path, contents).expect("write fixture");
            path
        }

        fn ctx(&self, vars: &[(&str, &str)]) -> ProbeContext {
            let env: BTreeMap<String, String> = vars
                .iter()
                .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
                .collect();
            ProbeContext {
                home_dir: self.home.path().to_path_buf(),
                env,
                keychain: Arc::new(MockKeychain::new()),
                commands: Arc::new(MockCommandRunner::new()),
                max_read_bytes: 8 * 1024,
            }
        }
    }

    fn offer(provider: &str, source: ProbeSource, capabilities: Vec<CapabilityClass>) -> OfferItem {
        OfferItem {
            provider_id: provider.to_string(),
            source,
            capabilities,
            confidence: Confidence::Medium,
            registry_hint: None,
        }
    }

    fn request(source: ProbeSource, mode: PromotionMode) -> PromoteRequest {
        PromoteRequest {
            provider_id: "github".to_string(),
            source,
            mode,
            confirm: true,
            wipe_after_import: false,
        }
    }

    async fn body_json(res: Response) -> Value {
        let bytes = axum::body::to_bytes(res.into_body(), 64 * 1024)
            .await
            .unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[tokio::test]
    async fn unconfirmed_promotion_reads_and_forwards_nothing() {
        let stub = Stub::default();
        let url = spawn_stub(stub.clone()).await;
        let st = test_state(&url);
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-opensesame-operator",
            crate::DEV_OPERATOR_TOKEN.parse().unwrap(),
        );
        let req = PromoteRequest {
            provider_id: "github".into(),
            source: ProbeSource::EnvVar {
                name: "GITHUB_TOKEN".into(),
            },
            mode: PromotionMode::Import,
            confirm: false,
            wipe_after_import: false,
        };
        let res = promote(State(st), None, headers, Json(req)).await;
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);
        let body = body_json(res).await;
        assert_eq!(body["error"], "promotion_not_confirmed");
        assert!(stub.calls().is_empty(), "{:?}", stub.calls());
    }

    #[tokio::test]
    async fn unoffered_pair_fails_closed() {
        let stub = Stub::default();
        let url = spawn_stub(stub.clone()).await;
        let st = test_state(&url);
        let fixture = Fixture::new();
        let ctx = fixture.ctx(&[("GITHUB_TOKEN", CANARY)]);
        let req = request(
            ProbeSource::EnvVar {
                name: "GITHUB_TOKEN".into(),
            },
            PromotionMode::Import,
        );
        // The env var exists but no offer covers it — the report is the
        // authority, not the request.
        let res = promote_with(&st, &ctx, &[], req).await;
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
        let body = body_json(res).await;
        assert_eq!(body["error"], "offer_not_found");
        assert!(stub.calls().is_empty());
    }

    #[tokio::test]
    async fn a_mode_the_offer_does_not_carry_is_not_viable() {
        let url = spawn_stub(Stub::default()).await;
        let st = test_state(&url);
        let fixture = Fixture::new();
        let ctx = fixture.ctx(&[]);
        let source = ProbeSource::CliTool {
            binary: "gh".into(),
            version: None,
        };
        let items = vec![offer(
            "github",
            source.clone(),
            vec![CapabilityClass::InvokeThrough, CapabilityClass::Mintable],
        )];
        let res = promote_with(&st, &ctx, &items, request(source, PromotionMode::Import)).await;
        assert_eq!(res.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let body = body_json(res).await;
        assert_eq!(body["error"], "mode_not_viable");
    }

    #[tokio::test]
    async fn import_seals_a_dotfile_exactly_once_and_leaks_nothing() {
        let stub = Stub::default();
        let url = spawn_stub(stub.clone()).await;
        let st = test_state(&url);
        let fixture = Fixture::new();
        let path = fixture.write_home_file(".vault-token", &format!("{CANARY}\n"));
        let ctx = fixture.ctx(&[]);
        let source = ProbeSource::DotFile { path: path.clone() };
        let items = vec![offer(
            "github",
            source.clone(),
            vec![CapabilityClass::Importable],
        )];
        let res = promote_with(&st, &ctx, &items, request(source, PromotionMode::Import)).await;
        assert_eq!(res.status(), StatusCode::OK);
        let rendered = {
            let bytes = axum::body::to_bytes(res.into_body(), 64 * 1024)
                .await
                .unwrap();
            String::from_utf8(bytes.to_vec()).unwrap()
        };
        let body: Value = serde_json::from_str(&rendered).unwrap();
        assert_eq!(body["mode"], "import");
        assert_eq!(body["connection_id"], "conn_stub");
        assert_eq!(body["wiped"], false);
        assert!(!rendered.contains(CANARY), "{rendered}");
        // The value crossed to the gateway exactly once, trimmed, and the
        // file stays put without wipe_after_import.
        let seals: Vec<_> = stub
            .calls()
            .into_iter()
            .filter(|(method, path, _)| method == "POST" && path.ends_with("/credential"))
            .collect();
        assert_eq!(seals.len(), 1, "{seals:?}");
        assert_eq!(seals[0].2["value"], CANARY);
        assert!(path.exists());
    }

    #[tokio::test]
    async fn wipe_runs_only_after_a_confirmed_seal() {
        let stub = Stub::default();
        let path_holder: Arc<Mutex<Option<PathBuf>>> = Arc::new(Mutex::new(None));
        let gate_holder = path_holder.clone();
        *stub.seal_gate.lock().unwrap() = Some(Box::new(move || {
            // At seal time the source file must still be there: wiping first
            // would destroy the only copy if the gateway then fails.
            assert!(
                gate_holder.lock().unwrap().as_ref().unwrap().exists(),
                "source wiped before the seal was confirmed"
            );
        }));
        let url = spawn_stub(stub.clone()).await;
        let st = test_state(&url);
        let fixture = Fixture::new();
        let path = fixture.write_home_file(".vault-token", CANARY);
        *path_holder.lock().unwrap() = Some(path.clone());
        let ctx = fixture.ctx(&[]);
        let source = ProbeSource::DotFile { path: path.clone() };
        let items = vec![offer(
            "github",
            source.clone(),
            vec![CapabilityClass::Importable],
        )];
        let mut req = request(source, PromotionMode::Import);
        req.wipe_after_import = true;
        let res = promote_with(&st, &ctx, &items, req).await;
        assert_eq!(res.status(), StatusCode::OK);
        let body = body_json(res).await;
        assert_eq!(body["wiped"], true);
        assert!(!path.exists());
    }

    #[tokio::test]
    async fn a_failed_seal_never_wipes() {
        let stub = Stub::default();
        *stub.fail_seal.lock().unwrap() = true;
        let url = spawn_stub(stub.clone()).await;
        let st = test_state(&url);
        let fixture = Fixture::new();
        let path = fixture.write_home_file(".vault-token", CANARY);
        let ctx = fixture.ctx(&[]);
        let source = ProbeSource::DotFile { path: path.clone() };
        let items = vec![offer(
            "github",
            source.clone(),
            vec![CapabilityClass::Importable],
        )];
        let mut req = request(source, PromotionMode::Import);
        req.wipe_after_import = true;
        let res = promote_with(&st, &ctx, &items, req).await;
        assert_eq!(res.status(), StatusCode::BAD_GATEWAY);
        let body = body_json(res).await;
        assert_eq!(body["error"], "gateway_failure");
        assert_eq!(body["stage"], "seal");
        assert!(path.exists(), "a failed seal must not wipe the source");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), CANARY);
    }

    #[tokio::test]
    async fn mcp_import_reads_only_the_named_key() {
        let stub = Stub::default();
        let url = spawn_stub(stub.clone()).await;
        let st = test_state(&url);
        let fixture = Fixture::new();
        let path = fixture.write_home_file(
            ".mcp.json",
            &format!(
                r#"{{"mcpServers": {{"github": {{"command": "npx", "env": {{"GITHUB_TOKEN": "{CANARY}", "OTHER_KEY": "{OTHER}"}}}}}}}}"#
            ),
        );
        let ctx = fixture.ctx(&[]);
        let source = ProbeSource::McpConfig {
            path: path.clone(),
            server_name: "github".into(),
            env_keys: vec!["GITHUB_TOKEN".into()],
        };
        let offered = ProbeSource::McpConfig {
            path: path.clone(),
            server_name: "github".into(),
            env_keys: vec!["GITHUB_TOKEN".into(), "OTHER_KEY".into()],
        };
        let items = vec![offer("github", offered, vec![CapabilityClass::Importable])];
        let res = promote_with(&st, &ctx, &items, request(source, PromotionMode::Import)).await;
        assert_eq!(res.status(), StatusCode::OK);
        let rendered = {
            let bytes = axum::body::to_bytes(res.into_body(), 64 * 1024)
                .await
                .unwrap();
            String::from_utf8(bytes.to_vec()).unwrap()
        };
        // Two planted values in the file; the response names the connection,
        // never either value.
        assert!(!rendered.contains(CANARY), "{rendered}");
        assert!(!rendered.contains(OTHER), "{rendered}");
        let seals: Vec<_> = stub
            .calls()
            .into_iter()
            .filter(|(method, path, _)| method == "POST" && path.ends_with("/credential"))
            .collect();
        assert_eq!(seals.len(), 1, "{seals:?}");
        assert_eq!(seals[0].2["value"], CANARY);
        assert_ne!(seals[0].2["value"], OTHER);
    }

    #[tokio::test]
    async fn mcp_import_requires_one_offered_key() {
        let url = spawn_stub(Stub::default()).await;
        let st = test_state(&url);
        let fixture = Fixture::new();
        let path = fixture.write_home_file(
            ".mcp.json",
            &format!(
                r#"{{"mcpServers": {{"github": {{"env": {{"GITHUB_TOKEN": "{CANARY}"}}}}}}}}"#
            ),
        );
        let ctx = fixture.ctx(&[]);
        let offered = ProbeSource::McpConfig {
            path: path.clone(),
            server_name: "github".into(),
            env_keys: vec!["GITHUB_TOKEN".into()],
        };
        let items = vec![offer("github", offered, vec![CapabilityClass::Importable])];
        // Zero keys named: ambiguous, refused.
        let ambiguous = ProbeSource::McpConfig {
            path: path.clone(),
            server_name: "github".into(),
            env_keys: vec![],
        };
        let res = promote_with(&st, &ctx, &items, request(ambiguous, PromotionMode::Import)).await;
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);
        assert_eq!(body_json(res).await["error"], "env_key_required");
        // A key the offer did not report: refused.
        let foreign = ProbeSource::McpConfig {
            path,
            server_name: "github".into(),
            env_keys: vec!["NEVER_OFFERED".into()],
        };
        let res = promote_with(&st, &ctx, &items, request(foreign, PromotionMode::Import)).await;
        assert_eq!(res.status(), StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(body_json(res).await["error"], "env_key_not_offered");
    }

    #[tokio::test]
    async fn mcp_wipe_removes_only_the_named_key() {
        let stub = Stub::default();
        let url = spawn_stub(stub.clone()).await;
        let st = test_state(&url);
        let fixture = Fixture::new();
        let path = fixture.write_home_file(
            ".mcp.json",
            &format!(
                r#"{{"mcpServers": {{"github": {{"env": {{"GITHUB_TOKEN": "{CANARY}", "OTHER_KEY": "{OTHER}"}}}}}}}}"#
            ),
        );
        let ctx = fixture.ctx(&[]);
        let source = ProbeSource::McpConfig {
            path: path.clone(),
            server_name: "github".into(),
            env_keys: vec!["GITHUB_TOKEN".into()],
        };
        let offered = ProbeSource::McpConfig {
            path: path.clone(),
            server_name: "github".into(),
            env_keys: vec!["GITHUB_TOKEN".into(), "OTHER_KEY".into()],
        };
        let items = vec![offer("github", offered, vec![CapabilityClass::Importable])];
        let mut req = request(source, PromotionMode::Import);
        req.wipe_after_import = true;
        let res = promote_with(&st, &ctx, &items, req).await;
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(body_json(res).await["wiped"], true);
        let rewritten = std::fs::read_to_string(&path).unwrap();
        assert!(!rewritten.contains(CANARY), "{rewritten}");
        assert!(!rewritten.contains("GITHUB_TOKEN"), "{rewritten}");
        assert!(rewritten.contains(OTHER), "{rewritten}");
        assert!(rewritten.contains("OTHER_KEY"), "{rewritten}");
    }

    #[tokio::test]
    async fn env_var_import_cannot_be_wiped_and_says_so() {
        let stub = Stub::default();
        let url = spawn_stub(stub.clone()).await;
        let st = test_state(&url);
        let fixture = Fixture::new();
        let ctx = fixture.ctx(&[("GITHUB_TOKEN", CANARY)]);
        let source = ProbeSource::EnvVar {
            name: "GITHUB_TOKEN".into(),
        };
        let items = vec![offer(
            "github",
            source.clone(),
            vec![CapabilityClass::Importable, CapabilityClass::Mintable],
        )];
        let mut req = request(source, PromotionMode::Import);
        req.wipe_after_import = true;
        let res = promote_with(&st, &ctx, &items, req).await;
        assert_eq!(res.status(), StatusCode::OK);
        let body = body_json(res).await;
        assert_eq!(body["wiped"], false);
        assert!(body["wipe_note"].as_str().unwrap().contains("environment"));
        let seals: Vec<_> = stub
            .calls()
            .into_iter()
            .filter(|(method, path, _)| method == "POST" && path.ends_with("/credential"))
            .collect();
        assert_eq!(seals.len(), 1);
        assert_eq!(seals[0].2["value"], CANARY);
    }

    #[tokio::test]
    async fn keychain_and_cli_sources_have_nothing_to_import() {
        let url = spawn_stub(Stub::default()).await;
        let st = test_state(&url);
        let fixture = Fixture::new();
        let ctx = fixture.ctx(&[]);
        for source in [
            ProbeSource::Keychain {
                store: KeychainStore::SecretService,
                item_label: "gh:github.com".into(),
            },
            ProbeSource::CliTool {
                binary: "gh".into(),
                version: None,
            },
        ] {
            let items = vec![offer(
                "github",
                source.clone(),
                vec![CapabilityClass::Importable],
            )];
            let res = promote_with(&st, &ctx, &items, request(source, PromotionMode::Import)).await;
            assert_eq!(res.status(), StatusCode::UNPROCESSABLE_ENTITY);
            assert_eq!(body_json(res).await["error"], "source_not_readable");
        }
    }

    #[tokio::test]
    async fn mint_opts_the_connection_into_derived_materialization() {
        let stub = Stub::default();
        let url = spawn_stub(stub.clone()).await;
        let st = test_state(&url);
        let fixture = Fixture::new();
        let ctx = fixture.ctx(&[]);
        let source = ProbeSource::CliTool {
            binary: "gh".into(),
            version: None,
        };
        let items = vec![offer(
            "github",
            source.clone(),
            vec![CapabilityClass::InvokeThrough, CapabilityClass::Mintable],
        )];
        let res = promote_with(&st, &ctx, &items, request(source, PromotionMode::Mint)).await;
        assert_eq!(res.status(), StatusCode::OK);
        let body = body_json(res).await;
        assert_eq!(body["mode"], "mint");
        assert_eq!(body["materialization"], "derived_short_lived");
        assert_eq!(body["next"]["mint"]["installation_id_required"], true);
        let calls = stub.calls();
        let patch = calls
            .iter()
            .find(|(method, _, _)| method == "PATCH")
            .expect("policy PATCH");
        assert_eq!(patch.2["materialization"], "derived_short_lived");
        // The existing policy is carried through, not clobbered.
        assert_eq!(patch.2["shareability"], "private");
        assert_eq!(patch.2["max_invoke_level"], 2);
        // No credential is sealed on the mint path.
        assert!(!calls
            .iter()
            .any(|(_, path, _)| path.ends_with("/credential")));
    }

    #[tokio::test]
    async fn invoke_through_persists_nothing() {
        let stub = Stub::default();
        let url = spawn_stub(stub.clone()).await;
        let st = test_state(&url);
        let fixture = Fixture::new();
        let ctx = fixture.ctx(&[]);
        let source = ProbeSource::CliTool {
            binary: "gh".into(),
            version: None,
        };
        let items = vec![offer(
            "github",
            source.clone(),
            vec![CapabilityClass::InvokeThrough],
        )];
        let res = promote_with(
            &st,
            &ctx,
            &items,
            request(source, PromotionMode::InvokeThrough),
        )
        .await;
        assert_eq!(res.status(), StatusCode::OK);
        let body = body_json(res).await;
        assert_eq!(body["mode"], "invoke_through");
        assert_eq!(body["persisted"], false);
        assert!(stub.calls().is_empty(), "{:?}", stub.calls());
    }
}
