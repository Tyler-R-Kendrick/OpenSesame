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
//! state directory, owner-only, so it survives a restart. Owner-only does not
//! keep out a process running as that owner, so the file carries an HMAC
//! under a key derived from the operator token (`helper_mints_key.rs`): only
//! the holder of the token can write grants that are read back. A file that
//! cannot be read, one in any other shape, and one whose tag is missing or
//! does not verify (edited by hand, or written under an earlier operator
//! token) is an empty list: the failure denies, it never admits.

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

#[path = "helper_mints_key.rs"]
mod key;
use key::GrantKey;

/// The file, inside the daemon's state directory.
const FILE_NAME: &str = "helper-mints.json";
/// The file's shape; any other is refused. Version 3 added the tag.
const VERSION: u32 = 3;

type Grants = BTreeMap<String, Option<String>>;

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
    /// HMAC-SHA256 of the grants, hex; absent in files from earlier builds.
    #[serde(default)]
    mac: Option<String>,
}

/// What the daemon found in the grant file when it started, or `Authenticated`
/// once it has written one.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Stored {
    /// No file, or a daemon that keeps the list in memory only.
    Absent,
    Authenticated,
    /// A tag that is missing or does not verify under this operator token.
    Unauthenticated,
    /// A file that cannot be read or parsed.
    Unreadable,
}

impl Stored {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Absent => "none",
            Self::Authenticated => "authenticated",
            Self::Unauthenticated => "unauthenticated",
            Self::Unreadable => "unreadable",
        }
    }
}

struct Loaded {
    grants: Grants,
    stored: Stored,
}

/// The grants by connection, where they are kept (`None`: memory only), and
/// the key their file is authenticated under (`None`: no operator token).
pub(crate) struct HelperMints {
    path: Option<PathBuf>,
    key: Option<GrantKey>,
    loaded: Mutex<Loaded>,
}

impl HelperMints {
    /// The list kept under `state_dir`, read once now and believed only when
    /// its tag verifies under a key derived from `operator_token`.
    pub(crate) fn open(state_dir: Option<&Path>, operator_token: &str) -> Self {
        let path = state_dir.map(|dir| dir.join(FILE_NAME));
        let key = GrantKey::derive(operator_token);
        let (grants, stored) = match path.as_deref() {
            Some(path) => read(path, key.as_ref()),
            None => (Grants::new(), Stored::Absent),
        };
        Self {
            path,
            key,
            loaded: Mutex::new(Loaded { grants, stored }),
        }
    }

    /// An empty list that is never written down.
    #[cfg(test)]
    pub(crate) fn in_memory() -> Self {
        Self::open(None, "")
    }

    /// Whether a token-less mint of `connection_id` for `installation_id` is
    /// granted: the connection, with exactly the installation granted.
    pub(crate) fn admits(&self, connection_id: &str, installation_id: Option<&str>) -> bool {
        self.lock()
            .grants
            .get(connection_id)
            .is_some_and(|granted| granted.as_deref() == installation_id)
    }

    pub(crate) fn list(&self) -> Vec<Grant> {
        self.lock()
            .grants
            .iter()
            .map(|(connection_id, installation_id)| Grant {
                connection_id: connection_id.clone(),
                installation_id: installation_id.clone(),
            })
            .collect()
    }

    pub(crate) fn stored(&self) -> Stored {
        self.lock().stored
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
    /// write leaves both as they were. With no operator token there is no key,
    /// and nothing is written: such a daemon holds no grants.
    fn change(&self, edit: impl FnOnce(&mut Grants)) -> std::io::Result<()> {
        let mut current = self.lock();
        let mut next = current.grants.clone();
        edit(&mut next);
        if let Some(path) = &self.path {
            let key = self.key.as_ref().ok_or_else(|| {
                std::io::Error::other("no operator token to authenticate grants with")
            })?;
            write(path, key, &next)?;
            current.stored = Stored::Authenticated;
        }
        current.grants = next;
        Ok(())
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Loaded> {
        self.loaded
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

/// The grants in `path` and what was found there. Anything but a readable
/// version-3 file whose tag verifies under `key` is no grants at all, said in
/// one log line that names no grant and no tag.
fn read(path: &Path, key: Option<&GrantKey>) -> (Grants, Stored) {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return (Grants::new(), Stored::Absent);
        }
        Err(_) => return refused(path, Stored::Unreadable),
    };
    let Ok(file) = serde_json::from_str::<File>(&text) else {
        return refused(path, Stored::Unreadable);
    };
    let count = file.grants.len();
    let grants: Grants = file
        .grants
        .into_iter()
        .map(|grant| (grant.connection_id, grant.installation_id))
        .collect();
    if grants.len() != count {
        return refused(path, Stored::Unreadable);
    }
    let verified = file.version == VERSION
        && key
            .zip(file.mac.as_deref())
            .is_some_and(|(key, tag)| key.verifies(VERSION, &grants, tag));
    if verified {
        (grants, Stored::Authenticated)
    } else {
        refused(path, Stored::Unauthenticated)
    }
}

fn refused(path: &Path, stored: Stored) -> (Grants, Stored) {
    tracing::warn!(
        path = %path.display(),
        stored = stored.as_str(),
        "helper mint grants not authenticated by the operator token, or unreadable; none are in force"
    );
    (Grants::new(), stored)
}

/// Write the list and its tag beside the final name, owner-only, then rename
/// over it.
fn write(path: &Path, key: &GrantKey, grants: &Grants) -> std::io::Result<()> {
    use std::io::Write;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mac = key
        .sign(VERSION, grants)
        .ok_or_else(|| std::io::Error::other("helper mint grants could not be tagged"))?;
    let file = File {
        version: VERSION,
        grants: grants
            .iter()
            .map(|(connection_id, installation_id)| Grant {
                connection_id: connection_id.clone(),
                installation_id: installation_id.clone(),
            })
            .collect(),
        mac: Some(mac),
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

/// `GET /v1/helper-mints`: the grants, and what was found in the file
/// (`stored`): `unauthenticated` or `unreadable` says the grants written there
/// are not in force, and the operator allows each again.
pub(crate) async fn list(State(st): State<App>, uds: UdsPeer, headers: HeaderMap) -> Response {
    if let Err(resp) = require_operator(&st, &headers, &uds) {
        return resp;
    }
    Json(json!({
        "grants": st.helper_mints.list(),
        "stored": st.helper_mints.stored().as_str(),
    }))
    .into_response()
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
