use std::sync::{Arc, Mutex};

use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::Router;
use base64::Engine;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tower::ServiceExt;

use super::{router, Store, ORG_ROLE, OWNER_KIND, PRINCIPAL, SLOT_KEY, SNAPSHOT_FORMAT};

pub(crate) fn app() -> Router {
    router(Arc::new(Mutex::new(Store::default())))
}

pub(crate) fn key() -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([7u8; 32])
}

pub(crate) fn snapshot(tomb: &str) -> Value {
    json!({
        "format": SNAPSHOT_FORMAT,
        "v": 1,
        "tomb": tomb,
        "header": { "v": 1, "createdAt": "2026-10-07T00:00:00Z" },
        "body": { "ivB64": "aXY", "ctB64": "Y2lwaGVydGV4dA" },
        "rev": 1
    })
}

pub(crate) async fn call(
    app: Router,
    method: &str,
    uri: &str,
    key: Option<&str>,
    principal: Option<&str>,
    kind: Option<&str>,
    body: Option<Value>,
) -> (StatusCode, Value) {
    call_role(app, method, uri, key, principal, kind, None, body).await
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn call_role(
    app: Router,
    method: &str,
    uri: &str,
    key: Option<&str>,
    principal: Option<&str>,
    kind: Option<&str>,
    role: Option<&str>,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut builder = Request::builder().method(method).uri(uri);
    if let Some(key) = key {
        builder = builder.header(SLOT_KEY, key);
    }
    if let Some(principal) = principal {
        builder = builder.header(PRINCIPAL, principal);
    }
    if let Some(kind) = kind {
        builder = builder.header(OWNER_KIND, kind);
    }
    if let Some(role) = role {
        builder = builder.header(ORG_ROLE, role);
    }
    let request = builder
        .header("content-type", "application/json")
        .body(Body::from(
            body.map(|value| value.to_string()).unwrap_or_default(),
        ))
        .unwrap();
    let response = app.oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let parsed = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes)
            .unwrap_or(Value::String(String::from_utf8_lossy(&bytes).into_owned()))
    };
    (status, parsed)
}
