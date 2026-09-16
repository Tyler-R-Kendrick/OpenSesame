//! A loopback Discord v10 fixture, and the transport that reaches it.
//!
//! Not a mock of this crate's calls — a small **stateful** implementation of the
//! subset of Discord's guild API the adapter uses. It creates roles with new
//! snowflakes, tracks which roles a member holds, answers `204 No Content` where
//! Discord does, serializes permission bitfields as decimal strings, and 404s
//! any path outside that subset. That last part is the point of using a server
//! instead of asserting on request structs: "the adapter called the wrong
//! endpoint" shows up as a test failure rather than passing unnoticed.
//!
//! No test in this crate touches the network. The listener binds
//! `127.0.0.1:0`, and the adapter is pointed at it by
//! `TargetSpec::base_url` — the same override `Registration::register` checks is
//! loopback before it accepts plaintext.
#![allow(dead_code)]

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use http_body_util::{BodyExt, Full};
use hyper::body::Bytes;
use hyper::service::service_fn;
use hyper_util::rt::TokioIo;
use serde_json::{json, Value};

pub mod routes;
pub mod scenario;
pub mod transport;

use routes::route;

pub const GUILD_ID: &str = "700000000000000001";
pub const CHANNEL_ID: &str = "700000000000000002";
pub const OTHER_CHANNEL_ID: &str = "700000000000000003";
pub const SUBJECT_ID: &str = "800000000000000001";
pub const BOT_USER_ID: &str = "900000000000000001";

pub const EVERYONE_ROLE_ID: &str = "700000000000000001";
pub const BOT_ROLE_ID: &str = "710000000000000009";
pub const MODERATOR_ROLE_ID: &str = "710000000000000005";
pub const BOOSTER_ROLE_ID: &str = "710000000000000003";

/// The bot's own role sits at 9, so anything below 9 is mutable and the
/// moderator role at 5 is deliberately *below* it — proving the reconciler
/// leaves that role alone because it does not own it, not because it could not
/// reach it.
pub const BOT_ROLE_POSITION: u32 = 9;

/// One recorded request.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Hit {
    pub method: String,
    pub path: String,
    pub authorization: Option<String>,
    pub audit_reason: Option<String>,
    pub body: Option<Value>,
}

/// A scripted non-success answer, consumed `remaining` times.
#[derive(Clone, Debug)]
pub struct Scripted {
    /// Matched exactly against the request method. A read and the mutation it
    /// precedes share a path — `GET /guilds/{id}/roles` and
    /// `POST /guilds/{id}/roles` differ only by verb — so a script that named
    /// the path alone would be spent on the observation and never reach the
    /// step under test.
    pub method: String,
    /// Matched as a suffix of the request path, so a caller can name
    /// `/roles` without spelling the guild id.
    pub path_suffix: String,
    pub status: u16,
    pub body: String,
    pub remaining: u32,
}

impl Scripted {
    /// Discord's 429: the wait is a **float of seconds** in the body.
    #[must_use]
    pub fn rate_limit(method: &str, path_suffix: &str, times: u32) -> Self {
        Self {
            method: method.to_owned(),
            path_suffix: path_suffix.to_owned(),
            status: 429,
            body: json!({
                "message": "You are being rate limited.",
                "retry_after": 0.25,
                "global": false,
            })
            .to_string(),
            remaining: times,
        }
    }

    /// Discord's 403 for touching a role at or above the bot's own.
    #[must_use]
    pub fn missing_permissions(method: &str, path_suffix: &str) -> Self {
        Self {
            method: method.to_owned(),
            path_suffix: path_suffix.to_owned(),
            status: 403,
            body: json!({ "message": "Missing Permissions", "code": 50_013 }).to_string(),
            remaining: 1,
        }
    }
}

/// The guild, as the fixture believes it to be.
#[derive(Clone, Debug)]
pub struct GuildState {
    pub roles: Vec<Value>,
    pub member_roles: BTreeMap<String, Vec<String>>,
    /// Channel id → its `permission_overwrites`, so a channel read reflects what
    /// a previous `PUT` wrote. Without this the fixture could not show
    /// convergence: a re-apply would keep seeing an empty overwrite list.
    pub channel_overwrites: BTreeMap<String, Vec<Value>>,
    pub next_role_id: u64,
}

impl GuildState {
    /// A guild with `@everyone`, a moderator role, an integration-managed
    /// booster role, and the bot's own role.
    #[must_use]
    pub fn new() -> Self {
        Self {
            roles: vec![
                role_json(EVERYONE_ROLE_ID, "@everyone", "0", 0, false),
                role_json(BOOSTER_ROLE_ID, "Server Booster", "0", 3, true),
                role_json(MODERATOR_ROLE_ID, "moderator", "8", 5, false),
                role_json(
                    BOT_ROLE_ID,
                    "OpenSesame Bot",
                    "268435456",
                    BOT_ROLE_POSITION,
                    true,
                ),
            ],
            member_roles: BTreeMap::from([
                (
                    SUBJECT_ID.to_owned(),
                    vec![MODERATOR_ROLE_ID.to_owned(), BOOSTER_ROLE_ID.to_owned()],
                ),
                (BOT_USER_ID.to_owned(), vec![BOT_ROLE_ID.to_owned()]),
            ]),
            channel_overwrites: BTreeMap::from([
                (CHANNEL_ID.to_owned(), Vec::new()),
                (OTHER_CHANNEL_ID.to_owned(), Vec::new()),
            ]),
            next_role_id: 720_000_000_000_000_100,
        }
    }

    #[must_use]
    pub fn overwrites(&self, channel: &str) -> Vec<Value> {
        self.channel_overwrites
            .get(channel)
            .cloned()
            .unwrap_or_default()
    }

    /// Add an already-existing role, for a test that starts mid-lifecycle.
    pub fn push_role(&mut self, id: &str, name: &str, permissions: &str, position: u32) {
        self.roles
            .push(role_json(id, name, permissions, position, false));
    }

    pub fn give_member_role(&mut self, user: &str, role: &str) {
        self.member_roles
            .entry(user.to_owned())
            .or_default()
            .push(role.to_owned());
    }

    #[must_use]
    pub fn role_names(&self) -> Vec<String> {
        self.roles
            .iter()
            .filter_map(|role| role["name"].as_str().map(str::to_owned))
            .collect()
    }

    #[must_use]
    pub fn member_role_ids(&self, user: &str) -> Vec<String> {
        self.member_roles.get(user).cloned().unwrap_or_default()
    }
}

impl Default for GuildState {
    fn default() -> Self {
        Self::new()
    }
}

/// A role in Discord's own shape — note `permissions` as a decimal **string**.
#[must_use]
pub fn role_json(id: &str, name: &str, permissions: &str, position: u32, managed: bool) -> Value {
    json!({
        "id": id,
        "name": name,
        "permissions": permissions,
        "position": position,
        "managed": managed,
        "color": 0,
        "hoist": false,
        "mentionable": false,
    })
}

/// A running fixture: its base URL, the guild it is pretending to be, and what
/// it was asked.
pub struct Fixture {
    pub base_url: String,
    pub hits: Arc<Mutex<Vec<Hit>>>,
    pub state: Arc<Mutex<GuildState>>,
    pub scripted: Arc<Mutex<Vec<Scripted>>>,
}

impl Fixture {
    #[must_use]
    pub fn paths(&self) -> Vec<String> {
        self.hits
            .lock()
            .unwrap()
            .iter()
            .map(|hit| format!("{} {}", hit.method, hit.path))
            .collect()
    }

    /// Mutating requests only — the reads are uninteresting to an ordering
    /// assertion and would swamp it.
    #[must_use]
    pub fn mutations(&self) -> Vec<String> {
        self.hits
            .lock()
            .unwrap()
            .iter()
            .filter(|hit| hit.method != "GET")
            .map(|hit| format!("{} {}", hit.method, hit.path))
            .collect()
    }

    #[must_use]
    pub fn hits(&self) -> Vec<Hit> {
        self.hits.lock().unwrap().clone()
    }

    pub fn script(&self, scripted: Scripted) {
        self.scripted.lock().unwrap().push(scripted);
    }
}

/// Start a fixture on an ephemeral loopback port.
pub async fn spawn(state: GuildState) -> Fixture {
    let hits = Arc::new(Mutex::new(Vec::new()));
    let state = Arc::new(Mutex::new(state));
    let scripted = Arc::new(Mutex::new(Vec::new()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();

    let server = Server {
        hits: hits.clone(),
        state: state.clone(),
        scripted: scripted.clone(),
    };
    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                return;
            };
            tokio::spawn(serve_connection(stream, server.clone()));
        }
    });

    Fixture {
        base_url: format!("http://127.0.0.1:{port}/api/v10"),
        hits,
        state,
        scripted,
    }
}

async fn serve_connection(stream: tokio::net::TcpStream, server: Server) {
    let service = service_fn(move |req| {
        let server = server.clone();
        async move { server.respond(req).await }
    });
    let _ = hyper::server::conn::http1::Builder::new()
        .serve_connection(TokioIo::new(stream), service)
        .await;
}

#[derive(Clone)]
pub struct Server {
    hits: Arc<Mutex<Vec<Hit>>>,
    state: Arc<Mutex<GuildState>>,
    scripted: Arc<Mutex<Vec<Scripted>>>,
}

impl Server {
    async fn respond(
        self,
        req: hyper::Request<hyper::body::Incoming>,
    ) -> Result<hyper::Response<Full<Bytes>>, std::convert::Infallible> {
        let method = req.method().to_string();
        let path = req.uri().path().to_string();
        let header = |name: &str| {
            req.headers()
                .get(name)
                .and_then(|value| value.to_str().ok())
                .map(str::to_owned)
        };
        let authorization = header("authorization");
        let audit_reason = header("x-audit-log-reason");
        let raw = req
            .into_body()
            .collect()
            .await
            .map(http_body_util::Collected::to_bytes);
        let body = raw
            .ok()
            .filter(|bytes| !bytes.is_empty())
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
        self.hits.lock().unwrap().push(Hit {
            method: method.clone(),
            path: path.clone(),
            authorization,
            audit_reason,
            body: body.clone(),
        });

        let (status, payload) = self
            .scripted_answer(&method, &path)
            .unwrap_or_else(|| route(&self, &method, &path, body.as_ref()));
        Ok(hyper::Response::builder()
            .status(status)
            .header("content-type", "application/json")
            .header("x-ratelimit-remaining", "4")
            .body(Full::new(Bytes::from(payload)))
            .unwrap())
    }

    fn scripted_answer(&self, method: &str, path: &str) -> Option<(u16, String)> {
        let mut scripted = self.scripted.lock().unwrap();
        let entry = scripted
            .iter_mut()
            .find(|s| s.remaining > 0 && s.method == method && path.ends_with(&s.path_suffix))?;
        entry.remaining -= 1;
        Some((entry.status, entry.body.clone()))
    }
}
