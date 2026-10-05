//! The tailnet routes against `spec/conformance/tailnet-admin-protocol.json`
//! (ADR 0169): every exchange replayed, in order, through the real router, a
//! real pairing store and a stub standing in for api.tailscale.com. The stub
//! holds the calls the spec says the daemon must make and answers each as
//! Tailscale did; a call it did not expect, a call missing, or an answer that
//! differs fails here. The Pages client is held to the same file.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use super::*;
use axum::{
    body::{to_bytes, Body, Bytes},
    http::{Method as HttpMethod, Request, Uri},
};
use opensesame_tailnet_admin::{Credential, CredentialKind};
use secrecy::SecretString;
use tower::ServiceExt;

const SPEC: &str = include_str!("../../../spec/conformance/tailnet-admin-protocol.json");
pub(super) const ORIGIN: &str = "https://ops.example.com";
pub(super) const API_TOKEN: &str = "tskey-api-kCONFORM1CNTRL-0123456789abcdef";

pub(super) struct Stub {
    pub(super) expected: VecDeque<Value>,
    pub(super) problems: Vec<String>,
    /// The credential every call must carry; `None` checks nothing.
    pub(super) bearer: Option<String>,
    /// Every call as `METHOD path` and its raw body.
    pub(super) seen: Vec<(String, String)>,
}

impl Default for Stub {
    fn default() -> Self {
        Self {
            expected: VecDeque::new(),
            problems: Vec::new(),
            bearer: Some(format!("Bearer {API_TOKEN}")),
            seen: Vec::new(),
        }
    }
}

fn answer(
    stub: &Mutex<Stub>,
    method: &HttpMethod,
    uri: &Uri,
    headers: &HeaderMap,
    body: &Bytes,
) -> Response {
    let mut stub = stub.lock().unwrap();
    let path = uri
        .path_and_query()
        .map(ToString::to_string)
        .unwrap_or_default();
    let auth = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string();
    stub.seen.push((
        format!("{method} {path}"),
        String::from_utf8_lossy(body).into_owned(),
    ));
    if stub.bearer.as_ref().is_some_and(|wanted| *wanted != auth) {
        stub.problems
            .push(format!("{method} {path}: wrong credential"));
    }
    let Some(call) = stub.expected.pop_front() else {
        stub.problems.push(format!("unexpected {method} {path}"));
        return StatusCode::IM_A_TEAPOT.into_response();
    };
    let sent: Value = serde_json::from_slice(body).unwrap_or(Value::Null);
    if call["method"] != method.as_str() || call["path"] != path.as_str() || call["body"] != sent {
        stub.problems.push(format!(
            "expected {} {} {}, got {method} {path} {sent}",
            call["method"], call["path"], call["body"]
        ));
    }
    let status =
        StatusCode::from_u16(u16::try_from(call["status"].as_u64().unwrap()).unwrap()).unwrap();
    if call["response"].is_null() {
        status.into_response()
    } else {
        (status, Json(call["response"].clone())).into_response()
    }
}

/// A stub for api.tailscale.com on a loopback port; its base URL and queue.
pub(super) async fn stub_upstream() -> (String, Arc<Mutex<Stub>>) {
    let stub = Arc::new(Mutex::new(Stub::default()));
    let shared = Arc::clone(&stub);
    let app = Router::new().fallback(move |method, uri, headers, body| {
        let response = answer(&shared, &method, &uri, &headers, &body);
        async move { response }
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (format!("http://127.0.0.1:{}", addr.port()), stub)
}

/// A daemon state connected to `tailnet` with an API token, and a bearer for
/// each role, paired from [`ORIGIN`].
pub(super) fn connected(
    base: &str,
    dir: &std::path::Path,
    tailnet: &str,
    at: u64,
) -> (App, String, String) {
    let store = AdminStore::at(dir);
    let credential = Credential {
        kind: CredentialKind::ApiKey,
        client_id: String::new(),
    };
    store
        .connect(
            tailnet,
            credential,
            &SecretString::from(API_TOKEN.to_string()),
            at,
        )
        .unwrap();
    let bearer = |role| {
        let (code, _) = store
            .pairings()
            .issue(ORIGIN, role, "Ops laptop", unix_now())
            .unwrap();
        store
            .pairings()
            .exchange(&code, ORIGIN, unix_now())
            .unwrap()
            .1
    };
    let (read, manage) = (bearer(Role::Read), bearer(Role::Manage));
    let mut state = crate::tests::test_state("http://127.0.0.1:1");
    state.tailnet = TailnetAdminHost::at(Some(store), Upstream::loopback(base).unwrap());
    (state, read, manage)
}

#[tokio::test]
async fn the_routes_answer_every_exchange_the_spec_records() {
    let spec: Value = serde_json::from_str(SPEC).expect("the spec is JSON");
    let tmp = tempfile::tempdir().unwrap();
    let (base, stub) = stub_upstream().await;
    let at = spec["connectedAt"].as_u64().unwrap();
    let (state, read, manage) = connected(&base, tmp.path(), spec["tailnet"].as_str().unwrap(), at);
    let store = state.tailnet.store.clone().unwrap();
    let app = routes(&state).with_state(state);

    for exchange in spec["exchanges"].as_array().unwrap() {
        let name = exchange["name"].as_str().unwrap();
        let request = &exchange["request"];
        stub.lock().unwrap().expected = exchange["upstream"]
            .as_array()
            .unwrap()
            .iter()
            .cloned()
            .collect();
        let audited_before = store.audit().recent(200).unwrap().len();
        let mut builder = Request::builder()
            .method(request["method"].as_str().unwrap())
            .uri(request["path"].as_str().unwrap())
            .header(header::ORIGIN, ORIGIN);
        match exchange["bearer"].as_str() {
            Some("read") => {
                builder = builder.header(header::AUTHORIZATION, format!("Bearer {read}"));
            }
            Some("manage") => {
                builder = builder.header(header::AUTHORIZATION, format!("Bearer {manage}"));
            }
            _ => {}
        }
        let body = if request["body"].is_null() {
            Body::empty()
        } else {
            builder = builder.header(header::CONTENT_TYPE, "application/json");
            Body::from(request["body"].to_string())
        };
        let response = app
            .clone()
            .oneshot(builder.body(body).unwrap())
            .await
            .unwrap();
        let status = response.status().as_u16();
        let bytes = to_bytes(response.into_body(), 1 << 20).await.unwrap();
        let answered: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        let expected = &exchange["response"];
        assert_eq!(
            u64::from(status),
            expected["status"].as_u64().unwrap(),
            "{name}: status"
        );
        assert_eq!(answered, expected["body"], "{name}: body");
        let left = std::mem::take(&mut stub.lock().unwrap().problems);
        assert!(left.is_empty(), "{name}: {left:?}");
        assert!(
            stub.lock().unwrap().expected.is_empty(),
            "{name}: an upstream call was not made"
        );
        let audit = store.audit().recent(200).unwrap();
        if let Some(line) = exchange.get("audit") {
            assert_eq!(audit.len(), audited_before + 1, "{name}: one audit line");
            assert_eq!(
                audit[0].action,
                line["action"].as_str().unwrap(),
                "{name}: action"
            );
            assert_eq!(
                audit[0].target,
                line["target"].as_str().unwrap(),
                "{name}: target"
            );
            assert_eq!(audit[0].status, status, "{name}: audited status");
            assert_eq!(audit[0].label, "Ops laptop");
        } else {
            assert_eq!(audit.len(), audited_before, "{name}: nothing audited");
        }
    }
    let file = std::fs::read_to_string(tmp.path().join("tailnet-admin-audit.jsonl")).unwrap();
    assert!(
        !file.contains("tskey-"),
        "the audit trail never holds a key"
    );
}

#[test]
fn the_pairing_code_is_the_one_the_spec_records() {
    let spec: Value = serde_json::from_str(SPEC).unwrap();
    let pairing = &spec["pairing"];
    let role = Role::parse(pairing["role"].as_str().unwrap()).unwrap();
    let code = opensesame_tailnet_admin::format_pairing_code(
        pairing["url"].as_str().unwrap(),
        pairing["code"].as_str().unwrap(),
        pairing["origin"].as_str().unwrap(),
        role,
        pairing["label"].as_str().unwrap(),
    );
    assert_eq!(code, pairing["printed"].as_str().unwrap());
    assert!(
        opensesame_plugin_settings::is_secret_shaped(pairing["code"].as_str().unwrap()),
        "the sample secret has the shape a real one has"
    );
}
