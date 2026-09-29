//! Who may ask for a fill: a browser extension, on loopback, holding a
//! paired token.
//!
//! Three things are read off the request, and each is refused on its own:
//!
//! - **Loopback.** The `Host` the client addressed must be `127.0.0.1`,
//!   `localhost` or `[::1]`, and nothing may say the request was forwarded.
//!   A browser always sends the host it dialled, so a page that rebinds a
//!   DNS name to loopback, and a request that arrives through Tailscale
//!   Serve or the WSL bridge, are both turned away before anything else.
//! - **An extension origin.** A browser stamps `Origin` itself and page
//!   script cannot set it; only an extension's own pages and service worker
//!   carry `chrome-extension://<id>` or `moz-extension://<uuid>`. Web pages,
//!   and anything claiming no origin at all, never get further.
//! - **A paired token**, as `Authorization: Bearer`, checked against the
//!   digest the pairing ceremony recorded for exactly that origin.
//!
//! A local process can forge the first two; it cannot forge the third
//! without the extension's storage, which is the same-user boundary
//! ADR 0150 §7 and ADR 0048 already draw.

use axum::{
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;

/// A caller that passed the loopback and origin checks, token not yet
/// verified. `Debug` never prints the token.
pub(crate) struct Caller {
    pub(crate) origin: String,
    pub(crate) token: String,
}

impl std::fmt::Debug for Caller {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Caller")
            .field("origin", &self.origin)
            .field("token", &"[redacted]")
            .finish()
    }
}

pub(crate) fn refuse(status: StatusCode, code: &str) -> Response {
    (status, Json(json!({ "error": code }))).into_response()
}

/// Headers a proxy adds; any of them means the request did not start here.
const FORWARDING_HEADERS: [&str; 5] = [
    "forwarded",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-proto",
    "x-real-ip",
];

/// Whether `Host` names this machine's loopback, with or without a port.
pub(crate) fn host_is_loopback(headers: &HeaderMap) -> bool {
    let Some(host) = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
    else {
        return false;
    };
    // `[::1]:18790` keeps its brackets; `127.0.0.1:18790` splits at its colon.
    let (name, rest) = match host.find(']') {
        Some(end) if host.starts_with('[') => host.split_at(end + 1),
        _ => host.split_at(host.find(':').unwrap_or(host.len())),
    };
    let port_ok = match rest.strip_prefix(':') {
        Some(port) => !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()),
        None => rest.is_empty(),
    };
    port_ok && matches!(name, "127.0.0.1" | "localhost" | "[::1]")
}

/// `chrome-extension://` and 32 letters `a`–`p` (Chromium's id alphabet), or
/// `moz-extension://` and a lower-case UUID (Firefox's per-profile id).
pub(crate) fn is_extension_origin(origin: &str) -> bool {
    if let Some(id) = origin.strip_prefix("chrome-extension://") {
        return id.len() == 32 && id.bytes().all(|b| (b'a'..=b'p').contains(&b));
    }
    if let Some(id) = origin.strip_prefix("moz-extension://") {
        let groups: Vec<&str> = id.split('-').collect();
        return groups.iter().map(|g| g.len()).eq([8, 4, 4, 4, 12])
            && groups.iter().all(|g| {
                g.bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            });
    }
    false
}

/// The pairing token: 43–128 URL-safe characters (the extension sends 32
/// random bytes as unpadded base64url, which is 43).
fn bearer(headers: &HeaderMap) -> Option<&str> {
    let value = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let token = value.strip_prefix("Bearer ")?;
    let shaped = (43..=128).contains(&token.len())
        && token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    shaped.then_some(token)
}

/// Read the caller off `headers`, refusing a request that is not loopback,
/// not from an extension, or carries no well-formed token.
pub(crate) fn extension_caller(headers: &HeaderMap) -> Result<Caller, Response> {
    let forwarded = FORWARDING_HEADERS
        .iter()
        .any(|name| headers.contains_key(*name));
    if forwarded || !host_is_loopback(headers) {
        return Err(refuse(StatusCode::FORBIDDEN, "loopback_only"));
    }
    let origin = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .filter(|origin| is_extension_origin(origin))
        .ok_or_else(|| refuse(StatusCode::FORBIDDEN, "extension_origin_required"))?;
    let token = bearer(headers)
        .ok_or_else(|| refuse(StatusCode::UNAUTHORIZED, "pairing_token_required"))?;
    Ok(Caller {
        origin: origin.to_string(),
        token: token.to_string(),
    })
}
