//! The operator transport routes: who may read them, what the status body
//! is, and the shape of the verify allowlist.

use axum::body::Body;
use axum::http::{Request, StatusCode};
use opensesame_domain::transport::{
    BindingPurpose, BindingScope, ServiceBindingSet, TransportStatusView,
};
use serde_json::Value;
use tower::ServiceExt as _;

use super::test_support::{binding, runtime, set};

const STATUS: &str = "/api/v1/operator/transport/status";
const BINDINGS: &str = "/api/v1/operator/transport/bindings";
const VERIFY: &str = "/api/v1/operator/transport/verify";

async fn state(bindings: ServiceBindingSet) -> crate::app_state::AppState {
    let mut st = crate::app_state::test_demo_state().await;
    st.transport = Some(runtime(bindings, 1));
    st
}

async fn call(
    st: &crate::app_state::AppState,
    method: &str,
    path: &str,
    operator: bool,
    body: Option<String>,
) -> (StatusCode, Value) {
    let mut builder = Request::builder().method(method).uri(path);
    if operator {
        builder = builder.header("x-opensesame-operator", st.operator_token.clone());
    }
    let body = body.map_or_else(Body::empty, |body| {
        builder = builder.header("content-type", "application/json");
        Body::from(body)
    });
    let response = super::routes::routes()
        .with_state(st.clone())
        .oneshot(builder.body(body).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 128 * 1024)
        .await
        .unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

fn bridge() -> ServiceBindingSet {
    set(vec![binding(
        "b1",
        "bridge.test",
        BindingPurpose::NatsAuthBridge,
        &["nats.callout.decide"],
        BindingScope::Deployment,
    )])
}

/// mTLS is not an alternate operator login: every route needs the same
/// configurator credential the TaskBus routes need.
#[tokio::test]
async fn every_route_is_configurator_gated() {
    let st = state(bridge()).await;
    for (method, path, body) in [
        ("GET", STATUS, None),
        ("GET", BINDINGS, None),
        (
            "PUT",
            BINDINGS,
            Some("{\"revision\":1,\"bindings\":[]}".to_owned()),
        ),
        ("POST", VERIFY, Some("{\"target\":\"host-tls\"}".to_owned())),
    ] {
        let (status, _) = call(&st, method, path, false, body).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{method} {path}");
    }
}

#[tokio::test]
async fn the_status_body_is_exactly_a_transport_status_view() {
    let st = state(bridge()).await;
    let (status, body) = call(&st, "GET", STATUS, true, None).await;
    assert_eq!(status, StatusCode::OK);
    let view: TransportStatusView =
        serde_json::from_value(body.clone()).expect("decodes as TransportStatusView");
    view.validate().expect("valid");
    assert_eq!(view.target, super::HOST_TLS_LISTENER);
    assert!(view.capabilities.server_enforces_certificate);
    // A configuration fact is not a demonstration.
    assert!(!view.enforcement.enforces());
    // Nothing that names a path, a socket, or a distinguished name.
    let rendered = body.to_string();
    for leak in ["/tmp/", "cert.pem", "key.pem", "CN=", "BEGIN "] {
        assert!(!rendered.contains(leak), "status leaked {leak}");
    }
}

#[tokio::test]
async fn bindings_round_trip_with_compare_and_set() {
    let st = state(ServiceBindingSet::empty()).await;
    let (status, body) = call(&st, "GET", BINDINGS, true, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["bindings"]["revision"], 1);

    let proposed = serde_json::to_string(&bridge()).unwrap();
    let (status, body) = call(&st, "PUT", BINDINGS, true, Some(proposed.clone())).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["bindings"]["revision"], 2);

    // Replaying the same revision is refused.
    let (status, body) = call(&st, "PUT", BINDINGS, true, Some(proposed)).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["error"], "stale_revision");
}

#[tokio::test]
async fn an_unknown_field_or_malformed_document_is_refused() {
    let st = state(ServiceBindingSet::empty()).await;
    for body in [
        "{\"revision\":1,\"bindings\":[],\"extra\":true}",
        "{\"revision\":0,\"bindings\":[]}",
        "not json",
    ] {
        let (status, _) = call(&st, "PUT", BINDINGS, true, Some(body.to_owned())).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "accepted {body}");
    }
}

/// AT-EVIDENCE-PROBE: the target is a word from a fixed list. A host, URL,
/// port, or address is a bad request, not an egress.
#[tokio::test]
async fn verify_accepts_only_the_fixed_target_words() {
    let st = state(ServiceBindingSet::empty()).await;
    for target in [
        "http://169.254.169.254/latest/meta-data",
        "127.0.0.1:22",
        "internal.corp",
        "host-tls ",
        "",
    ] {
        let body = serde_json::json!({ "target": target }).to_string();
        let (status, value) = call(&st, "POST", VERIFY, true, Some(body)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "accepted {target:?}");
        assert_eq!(value["error"], "invalid_request");
    }
    // An extra member is refused too: the body carries one word.
    let (status, _) = call(
        &st,
        "POST",
        VERIFY,
        true,
        Some("{\"target\":\"worker\",\"host\":\"evil.test\"}".to_owned()),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
}

/// An allowlisted target this deployment never configured reports that it
/// cannot be verified — it does not guess an address.
#[tokio::test]
async fn an_unconfigured_target_reports_enforcement_unsupported() {
    let st = state(ServiceBindingSet::empty()).await;
    let (status, value) = call(
        &st,
        "POST",
        VERIFY,
        true,
        Some("{\"target\":\"worker\"}".to_owned()),
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(value["error"], "enforcement_unsupported");
}

#[tokio::test]
async fn an_unconfigured_host_answers_without_claiming_a_failure() {
    let mut st = crate::app_state::test_demo_state().await;
    st.transport = None;
    let (status, value) = call(&st, "GET", STATUS, true, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(value["transport"], Value::Null);
}
