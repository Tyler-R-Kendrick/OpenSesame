//! What a credential helper may mint on the Unix socket with no operator
//! token (ADR 0138 §2, as amended).
//!
//! Peer credentials say *who* is asking; they cannot say *what* that process
//! should get. Any process running as an allowed UID can reach the socket, an
//! agent run with the socket mounted included, so a mint by peer credentials
//! alone would make the socket an oracle for every opted-in connection. The
//! operator therefore grants each connection a helper may mint, and the list
//! starts empty. A grant is a pair: the connection, and the one GitHub App
//! installation the operator names for it (none for a connection that takes
//! no installation). A connection that is a GitHub App reaches every
//! installation of that App, each perhaps another account's repositories, so
//! a token-less mint must ask for exactly the installation granted.
//!
//! The list is written only through the operator-token routes below
//! (`opensesame daemon helpers allow|revoke|list`), and kept in the daemon's
//! state directory, owner-only, so it survives a restart. A file that cannot
//! be read, or one in any other shape (the connection-only list an earlier
//! build wrote included), is an empty list: the failure denies, it never admits.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use axum::{
    extract::{Path as UrlPath, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::{require_operator, App, UdsPeer};

/// The file, inside the daemon's state directory.
const FILE_NAME: &str = "helper-mints.json";
/// The file's shape; any other is refused.
const VERSION: u32 = 2;

/// One grant: a connection, and the installation it is bound to.
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct Grant {
    pub(crate) connection_id: String,
    pub(crate) installation_id: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct File {
    version: u32,
    grants: Vec<Grant>,
}

/// The grants by connection, and where they are kept (`None`: memory only).
pub(crate) struct HelperMints {
    path: Option<PathBuf>,
    grants: Mutex<BTreeMap<String, Option<String>>>,
}

impl HelperMints {
    /// The list kept under `state_dir`, read once now.
    pub(crate) fn open(state_dir: Option<&Path>) -> Self {
        let path = state_dir.map(|dir| dir.join(FILE_NAME));
        let grants = path.as_deref().map(read).unwrap_or_default();
        Self {
            path,
            grants: Mutex::new(grants),
        }
    }

    /// An empty list that is never written down.
    #[cfg(test)]
    pub(crate) fn in_memory() -> Self {
        Self::open(None)
    }

    /// Whether a token-less mint of `connection_id` for `installation_id` is
    /// granted: the connection, with exactly the installation granted.
    pub(crate) fn admits(&self, connection_id: &str, installation_id: Option<&str>) -> bool {
        self.lock()
            .get(connection_id)
            .is_some_and(|granted| granted.as_deref() == installation_id)
    }

    pub(crate) fn list(&self) -> Vec<Grant> {
        self.lock()
            .iter()
            .map(|(connection_id, installation_id)| Grant {
                connection_id: connection_id.clone(),
                installation_id: installation_id.clone(),
            })
            .collect()
    }

    /// Grant a connection, bound to one installation or none; a second grant
    /// of the same connection replaces the first.
    pub(crate) fn grant(
        &self,
        connection_id: &str,
        installation_id: Option<&str>,
    ) -> std::io::Result<()> {
        self.change(|grants| {
            grants.insert(connection_id.to_string(), installation_id.map(String::from));
        })
    }

    pub(crate) fn revoke(&self, connection_id: &str) -> std::io::Result<()> {
        self.change(|grants| {
            grants.remove(connection_id);
        })
    }

    /// The file is written before the list in memory changes, so a failed
    /// write leaves both as they were.
    fn change(
        &self,
        edit: impl FnOnce(&mut BTreeMap<String, Option<String>>),
    ) -> std::io::Result<()> {
        let mut current = self.lock();
        let mut next = current.clone();
        edit(&mut next);
        if let Some(path) = &self.path {
            write(path, &next)?;
        }
        *current = next;
        Ok(())
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, BTreeMap<String, Option<String>>> {
        self.grants
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

fn read(path: &Path) -> BTreeMap<String, Option<String>> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return BTreeMap::new();
    };
    match serde_json::from_str::<File>(&text) {
        Ok(file) if file.version == VERSION => file
            .grants
            .into_iter()
            .map(|grant| (grant.connection_id, grant.installation_id))
            .collect(),
        _ => {
            tracing::warn!(path = %path.display(), "helper mint grants unreadable or of another shape; treated as empty");
            BTreeMap::new()
        }
    }
}

/// Write the list beside its final name, owner-only, then rename over it.
fn write(path: &Path, grants: &BTreeMap<String, Option<String>>) -> std::io::Result<()> {
    use std::io::Write;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let file = File {
        version: VERSION,
        grants: grants
            .iter()
            .map(|(connection_id, installation_id)| Grant {
                connection_id: connection_id.clone(),
                installation_id: installation_id.clone(),
            })
            .collect(),
    };
    let staging = path.with_extension("json.tmp");
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let mut out = options.open(&staging)?;
    out.write_all(&serde_json::to_vec(&file).map_err(std::io::Error::other)?)?;
    out.sync_all()?;
    std::fs::rename(&staging, path)
}

/// `GET /v1/helper-mints`: the grants.
pub(crate) async fn list(State(st): State<App>, uds: UdsPeer, headers: HeaderMap) -> Response {
    if let Err(resp) = require_operator(&st, &headers, &uds) {
        return resp;
    }
    Json(json!({ "grants": st.helper_mints.list() })).into_response()
}

/// What `PUT /v1/helper-mints/{connection_id}` may say: the installation the
/// grant is bound to, for a GitHub App connection.
#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct AllowBody {
    installation_id: Option<String>,
}

/// `PUT /v1/helper-mints/{connection_id}`: let helpers mint this connection,
/// for the installation named in the body or for none.
pub(crate) async fn allow(
    State(st): State<App>,
    uds: UdsPeer,
    headers: HeaderMap,
    UrlPath(connection_id): UrlPath<String>,
    body: String,
) -> Response {
    if let Err(resp) = admitted(&st, &uds, &headers, &connection_id) {
        return resp;
    }
    let body = if body.trim().is_empty() {
        AllowBody::default()
    } else {
        match serde_json::from_str::<AllowBody>(&body) {
            Ok(body) => body,
            Err(_) => return bad_request("invalid_body"),
        }
    };
    let installation = body.installation_id.as_deref();
    if installation
        .is_some_and(|id| id.is_empty() || id.len() > 20 || !id.bytes().all(|b| b.is_ascii_digit()))
    {
        return bad_request("invalid_installation_id");
    }
    written(
        st.helper_mints.grant(&connection_id, installation),
        json!({ "connection_id": connection_id, "installation_id": installation, "allowed": true }),
    )
}

/// `DELETE /v1/helper-mints/{connection_id}`: stop helpers minting it.
pub(crate) async fn revoke(
    State(st): State<App>,
    uds: UdsPeer,
    headers: HeaderMap,
    UrlPath(connection_id): UrlPath<String>,
) -> Response {
    if let Err(resp) = admitted(&st, &uds, &headers, &connection_id) {
        return resp;
    }
    written(
        st.helper_mints.revoke(&connection_id),
        json!({ "connection_id": connection_id, "allowed": false }),
    )
}

/// The operator token, on every transport, and a well-formed connection id.
#[allow(clippy::result_large_err)] // axum::Response is intentionally the Err payload
fn admitted(
    st: &App,
    uds: &UdsPeer,
    headers: &HeaderMap,
    connection_id: &str,
) -> Result<(), Response> {
    require_operator(st, headers, uds)?;
    if opensesame_host_core::http_security::is_safe_path_id(connection_id) {
        Ok(())
    } else {
        Err(bad_request("invalid_connection_id"))
    }
}

fn bad_request(error: &str) -> Response {
    (StatusCode::BAD_REQUEST, Json(json!({ "error": error }))).into_response()
}

fn written(result: std::io::Result<()>, answer: serde_json::Value) -> Response {
    if let Err(error) = result {
        tracing::warn!(kind = ?error.kind(), "helper mint grants unwritable");
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": "helper_mint_allowlist_unwritable"})),
        )
            .into_response();
    }
    tracing::info!(change = %answer, "helper mint grants changed");
    Json(answer).into_response()
}

#[cfg(test)]
#[path = "helper_mints_tests.rs"]
mod tests;
