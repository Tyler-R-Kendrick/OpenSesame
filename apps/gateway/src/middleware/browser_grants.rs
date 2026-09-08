//! Every browser authority request proves possession before any route dispatch.
use crate::{
    app_state::AppState,
    browser_pairing_proof::{refusal, request_origin, validate},
    routes::browser_pairings::session_claims,
};
use axum::{
    extract::{Request, State},
    http::{header, HeaderMap, HeaderValue, Method, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};
use opensesame_claims::hash_secret;

fn required_capability(method: &str, path: &str) -> Option<&'static str> {
    match (method, path) {
        ("POST", "/api/v1/host-authorizations" | "/api/v1/host-authorizations/verify") => Some(""),
        ("GET", "/api/v1/agent/runs") => Some("host.agent.observe"),
        ("GET", path) if agent_path(path, &["", "observe", "log"]) => Some("host.agent.observe"),
        ("POST", path) if agent_path(path, &["handoff", "control", "release"]) => {
            Some("host.agent.control")
        }
        ("POST", path) if driver_path(path) => Some("host.agent.control"),
        (
            "POST",
            "/api/v1/sync/pull" | "/api/v1/sync/pull-page" | "/api/v1/sync/blobs/snapshot",
        ) => Some("host.sync.read"),
        ("POST", "/api/v1/sync/push" | "/api/v1/sync/blobs/push") => Some("host.sync.write"),
        ("GET", "/api/v1/session" | "/api/v1/whoami" | "/api/v1/browser-clients") => Some(""),
        ("DELETE", path)
            if path
                .strip_prefix("/api/v1/browser-clients/")
                .is_some_and(|id| uuid::Uuid::parse_str(id).is_ok()) =>
        {
            Some("")
        }
        _ => super::browser_user_routes::required_capability(method, path),
    }
}

fn agent_path(path: &str, operations: &[&str]) -> bool {
    let Some(tail) = path.strip_prefix("/api/v1/agent/runs/") else {
        return false;
    };
    let mut parts = tail.split('/');
    let id = parts.next().unwrap_or("");
    let operation = parts.next().unwrap_or("");
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_:".contains(&b))
        && parts.next().is_none()
        && operations.contains(&operation)
}

fn driver_path(path: &str) -> bool {
    let Some((run, step)) = path.split_once("/steps/") else {
        return false;
    };
    if !agent_path(run, &[""]) {
        return false;
    }
    if step == "claim" {
        return true;
    }
    step.strip_suffix("/outcome").is_some_and(|raw| {
        raw.parse::<i64>()
            .is_ok_and(|seq| seq >= 0 && seq.to_string() == raw)
    })
}

fn pairing_path(path: &str) -> bool {
    matches!(
        path,
        "/api/v1/browser-pairings" | "/api/v1/browser-pairings/token"
    )
}

fn public_path(method: &Method, path: &str) -> bool {
    method == Method::GET
        && matches!(
            path,
            "/health/live" | "/health/ready" | "/pair" | "/.well-known/oauth-protected-resource"
        )
}

fn cors_headers(headers: &mut HeaderMap, origin: &str) {
    if let Ok(origin) = HeaderValue::from_str(origin) {
        headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
    }
    headers.append(header::VARY, HeaderValue::from_static("Origin"));
}

async fn preflight(st: &AppState, headers: &HeaderMap, path: &str, origin: &str) -> Response {
    let method = headers
        .get(header::ACCESS_CONTROL_REQUEST_METHOD)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let creating = method == "POST" && pairing_path(path);
    let paired = st
        .db
        .active_browser_origin(origin, chrono::Utc::now().timestamp())
        .await
        .unwrap_or(false);
    if !(creating || paired && required_capability(method, path).is_some()) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let allowed = [
        "authorization",
        "dpop",
        "content-type",
        "idempotency-key",
        "x-request-id",
    ];
    let requested = headers
        .get(header::ACCESS_CONTROL_REQUEST_HEADERS)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if requested
        .split(',')
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .any(|name| {
            !allowed
                .iter()
                .any(|allowed| name.eq_ignore_ascii_case(allowed))
        })
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    let mut response = StatusCode::NO_CONTENT.into_response();
    cors_headers(response.headers_mut(), origin);
    response.headers_mut().insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_str(method).unwrap_or(HeaderValue::from_static("POST")),
    );
    response.headers_mut().insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static(
            "Authorization, DPoP, Content-Type, Idempotency-Key, X-Request-Id",
        ),
    );
    response.headers_mut().append(
        header::VARY,
        HeaderValue::from_static("Access-Control-Request-Method, Access-Control-Request-Headers"),
    );
    // The explicit eligible-origin pairing route is unprivileged and proof-bound;
    // authority routes additionally require an active client and actual grant proof.
    if headers
        .get("access-control-request-private-network")
        .is_some_and(|value| value == "true")
    {
        response.headers_mut().insert(
            "access-control-allow-private-network",
            HeaderValue::from_static("true"),
        );
    }
    response
}

async fn authenticate(
    st: &AppState,
    headers: &HeaderMap,
    method: &str,
    path: &str,
    origin: &str,
) -> Result<(), Response> {
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|value| value.strip_prefix("DPoP "))
        .ok_or_else(|| refusal("dpop_token_required"))?;
    let raw = token
        .strip_prefix("opaque-session:")
        .filter(|value| value.len() == 64)
        .ok_or_else(|| refusal("invalid_grant"))?;
    let digest = hash_secret(raw);
    let now = chrono::Utc::now();
    let grant = st
        .db
        .browser_grant(&digest, now.timestamp())
        .await
        .map_err(|_| refusal("grant_store_unavailable"))?
        .ok_or_else(|| refusal("invalid_grant"))?;
    if grant.origin != origin || grant.audience != st.resource {
        return Err(refusal("invalid_grant"));
    }
    let claims = session_claims(&grant)?;
    let capability =
        required_capability(method, path).ok_or_else(|| refusal("capability_denied"))?;
    if !claims.valid_for(&st.resource, now)
        || (!capability.is_empty()
            && !claims
                .capability_ceiling
                .iter()
                .any(|cap| cap == capability))
    {
        return Err(refusal("capability_denied"));
    }
    validate(
        st,
        headers,
        method,
        path,
        Some(token),
        Some(&grant.dpop_jkt),
    )
    .await?;
    let mut sessions = st
        .sessions
        .lock()
        .map_err(|_| refusal("session_store_unavailable"))?;
    sessions.retain(|_, claims| claims.expires_at > now);
    if sessions.len() >= 4096 && !sessions.contains_key(&digest) {
        return Err(refusal("session_capacity"));
    }
    sessions.insert(digest, claims);
    Ok(())
}

pub async fn guard(State(st): State<AppState>, req: Request, next: Next) -> Response {
    let carries_dpop = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|value| value.starts_with("DPoP "));
    if !req.headers().contains_key(header::ORIGIN) && !carries_dpop {
        return next.run(req).await;
    }
    if public_path(req.method(), req.uri().path()) {
        return next.run(req).await;
    }
    let origin = match request_origin(req.headers()) {
        Ok(origin) => origin,
        Err(response) => return response,
    };
    let headers = req.headers().clone();
    let path = req.uri().path().to_owned();
    let method = req.method().as_str().to_owned();
    if req.method() == Method::OPTIONS {
        return preflight(&st, &headers, &path, &origin).await;
    }
    if !(req.method() == Method::POST && pairing_path(req.uri().path())) {
        if let Err(response) = authenticate(&st, &headers, &method, &path, &origin).await {
            return response;
        }
    }
    let mut response = next.run(req).await;
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    cors_headers(response.headers_mut(), &origin);
    response
}

#[cfg(test)]
#[path = "browser_grants_tests.rs"]
mod tests;
