//! The connections a credential helper may mint on the Unix socket with no
//! operator token (ADR 0138 §2, as amended).
//!
//! Peer credentials say *who* is asking; they cannot say *what* that process
//! should get. Any process running as an allowed UID can reach the socket, an
//! agent run with the socket mounted included, so a mint by peer credentials
//! alone would make the socket an oracle for every opted-in connection. The
//! operator therefore names each connection a helper may mint, and the list
//! starts empty. It is written only through the operator-token routes below
//! (`opensesame helpers allow|revoke|list`), and kept in the daemon's state
//! directory, owner-only, so it survives a restart. A file that cannot be read
//! is treated as an empty list: the failure denies, it never admits.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use axum::{
    extract::{Path as UrlPath, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;

use crate::{require_operator, App, UdsPeer};

/// The file, inside the daemon's state directory.
const FILE_NAME: &str = "helper-mints.json";

/// The allowlist, and where it is kept (`None`: memory only).
pub(crate) struct HelperMints {
    path: Option<PathBuf>,
    allowed: Mutex<BTreeSet<String>>,
}

impl HelperMints {
    /// The list kept under `state_dir`, read once now.
    pub(crate) fn open(state_dir: Option<&Path>) -> Self {
        let path = state_dir.map(|dir| dir.join(FILE_NAME));
        let allowed = path.as_deref().map(read).unwrap_or_default();
        Self {
            path,
            allowed: Mutex::new(allowed),
        }
    }

    /// An empty list that is never written down.
    #[cfg(test)]
    pub(crate) fn in_memory() -> Self {
        Self::open(None)
    }

    pub(crate) fn allows(&self, connection_id: &str) -> bool {
        self.lock().contains(connection_id)
    }

    pub(crate) fn list(&self) -> Vec<String> {
        self.lock().iter().cloned().collect()
    }

    /// Add or remove one connection. The file is written before the list in
    /// memory changes, so a failed write leaves both as they were.
    pub(crate) fn set(&self, connection_id: &str, allowed: bool) -> std::io::Result<()> {
        let mut current = self.lock();
        let mut next = current.clone();
        if allowed {
            next.insert(connection_id.to_string());
        } else {
            next.remove(connection_id);
        }
        if let Some(path) = &self.path {
            write(path, &next)?;
        }
        *current = next;
        Ok(())
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, BTreeSet<String>> {
        self.allowed
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

fn read(path: &Path) -> BTreeSet<String> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return BTreeSet::new();
    };
    let parsed = serde_json::from_str::<serde_json::Value>(&text)
        .ok()
        .and_then(|value| value.get("connections").cloned())
        .and_then(|value| serde_json::from_value::<BTreeSet<String>>(value).ok());
    parsed.unwrap_or_else(|| {
        tracing::warn!(path = %path.display(), "helper mint allowlist unreadable; treated as empty");
        BTreeSet::new()
    })
}

/// Write the list beside its final name, owner-only, then rename over it.
fn write(path: &Path, allowed: &BTreeSet<String>) -> std::io::Result<()> {
    use std::io::Write;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let staging = path.with_extension("json.tmp");
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let mut file = options.open(&staging)?;
    file.write_all(json!({ "connections": allowed }).to_string().as_bytes())?;
    file.sync_all()?;
    std::fs::rename(&staging, path)
}

/// `GET /v1/helper-mints`: the connections a helper may mint.
pub(crate) async fn list(State(st): State<App>, uds: UdsPeer, headers: HeaderMap) -> Response {
    if let Err(resp) = require_operator(&st, &headers, &uds) {
        return resp;
    }
    Json(json!({ "connections": st.helper_mints.list() })).into_response()
}

/// `PUT /v1/helper-mints/{connection_id}`: let helpers mint this connection.
pub(crate) async fn allow(
    State(st): State<App>,
    uds: UdsPeer,
    headers: HeaderMap,
    UrlPath(connection_id): UrlPath<String>,
) -> Response {
    change(&st, &uds, &headers, &connection_id, true)
}

/// `DELETE /v1/helper-mints/{connection_id}`: stop helpers minting it.
pub(crate) async fn revoke(
    State(st): State<App>,
    uds: UdsPeer,
    headers: HeaderMap,
    UrlPath(connection_id): UrlPath<String>,
) -> Response {
    change(&st, &uds, &headers, &connection_id, false)
}

fn change(
    st: &App,
    uds: &UdsPeer,
    headers: &HeaderMap,
    connection_id: &str,
    allowed: bool,
) -> Response {
    if let Err(resp) = require_operator(st, headers, uds) {
        return resp;
    }
    if !opensesame_host_core::http_security::is_safe_path_id(connection_id) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "invalid_connection_id"})),
        )
            .into_response();
    }
    match st.helper_mints.set(connection_id, allowed) {
        Ok(()) => {
            tracing::info!(connection_id, allowed, "helper mint allowlist changed");
            Json(json!({ "connection_id": connection_id, "allowed": allowed })).into_response()
        }
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": "helper_mint_allowlist_unwritable"})),
        )
            .into_response(),
    }
}

#[cfg(test)]
#[path = "helper_mints_tests.rs"]
mod tests;
