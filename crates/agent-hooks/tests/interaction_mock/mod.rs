//! A scripted stand-in for the Identity API's interaction routes, served on
//! loopback. It answers the routes the approver speaks with the shapes
//! `packages/control-plane` answers them with, and records every request.
//! The request digest it reports is really computed
//! (`interaction::digest`, held to `spec/conformance` by its own test), so a
//! consumed interaction hashes to what the create answered — unless a test
//! says otherwise.

#![allow(dead_code)]

mod handlers;
mod ledger;

use std::collections::{HashMap, HashSet};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use opensesame_agent_hooks::interaction::DEFAULT_POLL_INTERVAL;
use opensesame_agent_hooks::{InteractionApprover, InteractionApproverConfig};
use serde_json::Value;

pub const BEARER: &str = "test-requester-bearer";
pub const APPROVER_REF: &str = "inbox_YXBwcm92ZXI.test-tag";
pub const REF: &str = "ixn_aWQtMQ.tag-1";
/// A `context_identity`-shaped value for tests that ask the approver directly.
pub const DIGEST: &str = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
pub const REQUESTER_REF: &str = "req_abcdefghijklmnopqrstuvwx";
pub const BINDING_MESSAGE: &str = "pre_tool_call on deploy";
pub const EXPIRES_AT: &str = "2026-09-28T12:05:00.000Z";
pub const SUBJECT_ID: &str = "areq_1";
pub const OTHER_DIGEST: &str =
    "sha256:2222222222222222222222222222222222222222222222222222222222222222";
/// A server-written string that must never reach a verdict.
pub const SERVER_PROSE: &str = "server-prose-that-must-not-echo";

/// How a consume attempt is answered.
#[derive(Clone, Debug)]
pub enum Step {
    /// `401 approval_required` — unanswered, or declined.
    Pending,
    /// `200` with the consumed detail echoing what was sent.
    Spend,
    /// `200` with a consumed detail altered by the closure.
    SpendAltered(fn(&mut Value)),
    /// Any other status and error code.
    Reply(u16, &'static str),
    /// A redirect to another route on the same server.
    Redirect,
    /// `200` with a body past the approver's read bound.
    Oversized,
    /// Hold the reply this long, then answer `200` with a clean spend.
    Stall(Duration),
}

/// A way the server misbehaves around creation.
#[derive(Clone, Copy, Debug, Default)]
pub enum Fault {
    #[default]
    None,
    /// The first authorization-request create is processed and recorded, but
    /// its reply never arrives.
    LoseFirstSubjectReply,
    /// The first interaction create is processed and recorded, but its reply
    /// never arrives.
    LoseFirstInteractionReply,
    /// The authorization-request create is processed, then answered this late.
    SlowSubject(Duration),
    /// The interaction create is processed, then answered this late.
    SlowInteraction(Duration),
    /// The server reports (and later attests) a digest over other content.
    WrongDigest,
    /// The server keeps rows, as the Identity API does: the authorization
    /// request create de-duplicates on the digest of (approver, requester,
    /// details, binding message) and answers `200` with the live row it
    /// already holds, an interaction is refused while one is live for its
    /// subject (`409 interaction_already_live`), and cancelling a request
    /// revokes the interaction fronting it. Each row is a subject of its own
    /// (`areq_1`, `areq_2`, ...) with its own interaction; one is approved by
    /// putting its subject id in [`Seen::approved`].
    DedupSubject,
    /// [`Fault::DedupSubject`], and the first authorization-request create is
    /// processed but its reply never arrives, and the server's idempotency
    /// cache does not hold it (per process, or full): the retry reaches the
    /// handler again and is answered `200` with the row the first attempt
    /// inserted.
    DedupAfterLostReply,
}

impl Fault {
    /// Whether the server keeps rows.
    pub fn keeps_rows(self) -> bool {
        matches!(self, Self::DedupSubject | Self::DedupAfterLostReply)
    }
}

/// What the mock saw.
#[derive(Default, Debug)]
pub struct Seen {
    pub auth_requests: Vec<Value>,
    pub interactions: Vec<Value>,
    pub consumes: usize,
    pub revokes: usize,
    /// The authorization requests withdrawn, by id.
    pub cancels: Vec<String>,
    pub redirected: usize,
    pub bearers: Vec<String>,
    /// The `Idempotency-Key` of every create request, in arrival order.
    pub subject_keys: Vec<String>,
    pub interaction_keys: Vec<String>,
    /// The status of every authorization-request create reply that was sent.
    pub subject_statuses: Vec<u16>,
    /// Subjects a person has approved, for [`Fault::DedupSubject`] servers.
    pub approved: HashSet<String>,
}

pub struct Server {
    pub base: String,
    pub seen: Arc<Mutex<Seen>>,
}

/// Serve the mock with `script` for consume and `create_status` for
/// `POST /v1/interactions`.
pub async fn serve(script: Vec<Step>, create_status: u16) -> Server {
    serve_with(script, create_status, Fault::None).await
}

/// [`serve`], with the server misbehaving as `fault` says.
pub async fn serve_with(script: Vec<Step>, create_status: u16, fault: Fault) -> Server {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let seen = Arc::new(Mutex::new(Seen::default()));
    let mock = handlers::Mock {
        seen: seen.clone(),
        script: Arc::new(Mutex::new(script.into())),
        create_status,
        base: base.clone(),
        fault,
        replayed: Arc::new(Mutex::new(HashMap::new())),
        rows: Arc::new(Mutex::new(Vec::new())),
        digest: Arc::new(Mutex::new(DIGEST.to_owned())),
        lost: Arc::new(AtomicBool::new(false)),
    };
    let app = handlers::router(mock);
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    Server { base, seen }
}

/// [`serve`], with every route mounted under `prefix` (an Identity API behind
/// a path-prefixing proxy). `base` is the URL to configure, `prefix` included.
pub async fn serve_under(prefix: &str, script: Vec<Step>, create_status: u16) -> Server {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let base = format!("{origin}{prefix}");
    let seen = Arc::new(Mutex::new(Seen::default()));
    let mock = handlers::Mock {
        seen: seen.clone(),
        script: Arc::new(Mutex::new(script.into())),
        create_status,
        base: base.clone(),
        fault: Fault::None,
        replayed: Arc::new(Mutex::new(HashMap::new())),
        rows: Arc::new(Mutex::new(Vec::new())),
        digest: Arc::new(Mutex::new(DIGEST.to_owned())),
        lost: Arc::new(AtomicBool::new(false)),
    };
    let app = axum::Router::new().nest(prefix.trim_end_matches('/'), handlers::router(mock));
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    Server { base, seen }
}

/// Wait (bounded) until `ready` holds of what the mock has seen.
pub async fn until(server: &Server, ready: impl Fn(&Seen) -> bool) {
    for _ in 0..300 {
        if ready(&server.seen.lock().unwrap()) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("the server never saw what the test waited for");
}

/// The approver configuration the tests use against `base`.
pub fn config(base: &str, deadline: Duration) -> InteractionApproverConfig {
    InteractionApproverConfig {
        identity_api_url: base.to_owned(),
        bearer: BEARER.to_owned().into(),
        approver_ref: APPROVER_REF.to_owned(),
        ttl: Duration::from_secs(300),
        poll_interval: Duration::from_millis(10).min(DEFAULT_POLL_INTERVAL),
        deadline,
    }
}

pub fn approver(base: &str) -> InteractionApprover {
    InteractionApprover::new(config(base, Duration::from_secs(5))).expect("config is valid")
}
