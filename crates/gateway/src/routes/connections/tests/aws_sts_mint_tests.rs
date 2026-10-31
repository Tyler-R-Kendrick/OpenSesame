//! The AWS mint through the Host API (ADR 0217): bind a role, mint through the
//! real route, broker and invoke-through against a loopback STS that verifies
//! `SigV4` with `aws-sigv4`, and prove the source credential appears nowhere a
//! caller, an event, a receipt or a log line can see.

use std::fmt::Write as _;
use std::sync::{Arc, Mutex};

use opensesame_connection_broker::aws_sts::stand_in::{self, Expect, Reply, StandIn};
use tracing::field::{Field, Visit};

use super::*;

const AKID: &str = "AKIAVTOKDUMMYMARKER0";
const SECRET: &str = "vtok_dummy_marker_0123456789abcdef";
const TOKEN: &str = "vtok_dummy_marker_session_0123456789";
const EXTERNAL_ID: &str = "vtok_dummy_marker_external_0123456789";
const SOURCE: [&str; 4] = [AKID, SECRET, TOKEN, EXTERNAL_ID];

/// Every event at every level, fields and all.
#[derive(Clone, Default)]
struct Logs(Arc<Mutex<String>>);

struct Fields<'a>(&'a mut String);

impl Visit for Fields<'_> {
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        let _ = write!(self.0, " {}={value:?}", field.name());
    }
}

impl tracing::Subscriber for Logs {
    fn enabled(&self, _: &tracing::Metadata<'_>) -> bool {
        true
    }
    fn new_span(&self, span: &tracing::span::Attributes<'_>) -> tracing::span::Id {
        span.record(&mut Fields(&mut self.0.lock().unwrap()));
        tracing::span::Id::from_u64(1)
    }
    fn record(&self, _: &tracing::span::Id, values: &tracing::span::Record<'_>) {
        values.record(&mut Fields(&mut self.0.lock().unwrap()));
    }
    fn record_follows_from(&self, _: &tracing::span::Id, _: &tracing::span::Id) {}
    fn event(&self, event: &tracing::Event<'_>) {
        event.record(&mut Fields(&mut self.0.lock().unwrap()));
    }
    fn enter(&self, _: &tracing::span::Id) {}
    fn exit(&self, _: &tracing::span::Id) {}
}

async fn aws_harness(reply: Reply) -> (AppState, StandIn) {
    let (mut state, _server) = harness().await;
    let stand_in = stand_in::spawn(
        Expect {
            access_key_id: AKID,
            secret: SECRET,
            session_token: Some(TOKEN),
            region: "eu-west-1",
        },
        reply,
    )
    .await;
    let config = BrokerConfig::in_memory(Some([11u8; 32]), "http://127.0.0.1:8787")
        .with_aws_sts_endpoint(stand_in.base.clone());
    state.connection_broker = Arc::new(
        ConnectionBroker::new(state.db.pool().clone(), config).expect("connection broker"),
    );
    (state, stand_in)
}

/// An `aws` connection holding the dummy key pair, opted in and bound.
async fn bound_connection(state: &AppState) -> String {
    let (status, created) = call(
        state,
        "POST",
        "/api/v1/connections",
        Some(json!({"provider_id": "aws"})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{created}");
    let id = created["connection_id"].as_str().unwrap().to_string();
    let (status, body) = call(
        state,
        "POST",
        &format!("/api/v1/connections/{id}/credential"),
        Some(json!({"configuration_set": {
            "region": "eu-west-1",
            "access_key_id": AKID,
            "secret_access_key": SECRET,
            "session_token": TOKEN,
        }})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, body) = call(
        state,
        "PATCH",
        &format!("/api/v1/connections/{id}"),
        Some(json!({"shareability": "private", "max_invoke_level": 2, "materialization": "derived_short_lived"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, view) = call(
        state,
        "PUT",
        &format!("/api/v1/connections/{id}/aws-sts-binding"),
        Some(json!({
            "role_arn": "arn:aws:iam::123456789012:role/Deployer",
            "region": "eu-west-1",
            "max_duration_seconds": 1800,
            "session_policy": {"Version": "2012-10-17", "Statement": [
                {"Effect": "Allow", "Action": "s3:GetObject", "Resource": "*"}
            ]},
            "external_id": EXTERNAL_ID,
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{view}");
    assert_eq!(view["role_arn"], "arn:aws:iam::123456789012:role/Deployer");
    assert_eq!(view["external_id"], true);
    id
}

fn assert_no_source(label: &str, text: &str) {
    for secret in SOURCE {
        assert!(
            !text.contains(secret),
            "{label} carries source material {secret}: {text}"
        );
    }
}

#[tokio::test]
async fn a_bound_aws_connection_mints_sts_credentials_and_nothing_else_leaks() {
    let logs = Logs::default();
    let _guard = tracing::subscriber::set_default(logs.clone());
    let (state, stand_in) = aws_harness(Reply::Assume { expires_in: 1800 }).await;
    let id = bound_connection(&state).await;

    let (status, minted) = call(
        &state,
        "POST",
        &format!("/api/v1/connections/{id}/mint"),
        Some(json!({"duration_seconds": 1800})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{minted}");
    assert_eq!(minted["kind"], "aws_sts_assume_role");
    assert_eq!(minted["access_key_id"], stand_in::MINTED_ACCESS_KEY_ID);
    assert_eq!(minted["secret_access_key"], stand_in::MINTED_SECRET);
    assert_eq!(minted["session_token"], stand_in::MINTED_SESSION_TOKEN);
    assert_eq!(minted["derived_token"], stand_in::MINTED_SESSION_TOKEN);
    let receipt = &minted["receipt"];
    let grant = receipt["grant_id"].as_str().unwrap().to_string();
    assert_eq!(
        receipt["role_arn"],
        "arn:aws:iam::123456789012:role/Deployer"
    );
    assert_eq!(receipt["role_session_name"], format!("opensesame-{grant}"));
    assert_eq!(receipt["request_id"], stand_in::REQUEST_ID);
    assert_eq!(receipt["duration_seconds"], 1800);
    assert_eq!(receipt["expires_at"], minted["expires_at"]);

    let hits = stand_in.hits();
    assert_eq!(hits.len(), 1);
    assert!(
        hits[0].signature_valid,
        "the stand-in could not verify SigV4"
    );
    assert_eq!(
        hits[0].form["RoleSessionName"],
        format!("opensesame-{grant}")
    );
    assert_eq!(hits[0].form["SourceIdentity"], "operator");
    assert_eq!(hits[0].form["DurationSeconds"], "1800");
    assert_eq!(hits[0].form["ExternalId"], EXTERNAL_ID);
    assert!(hits[0].form["Policy"].contains("s3:GetObject"));

    assert_no_source("mint response", &minted.to_string());
    let (_, binding) = call(
        &state,
        "GET",
        &format!("/api/v1/connections/{id}/aws-sts-binding"),
        None,
    )
    .await;
    assert_no_source("binding view", &binding.to_string());
    let (_, connection) = call(&state, "GET", &format!("/api/v1/connections/{id}"), None).await;
    assert_no_source("connection view", &connection.to_string());
    let logged = logs.0.lock().unwrap().clone();
    assert_no_source("log lines", &logged);
    assert!(
        !logged.contains(stand_in::MINTED_SECRET),
        "a log line carries the minted secret"
    );
}

#[tokio::test]
async fn a_duration_past_the_cap_or_an_unbound_connection_never_reaches_sts() {
    let (state, stand_in) = aws_harness(Reply::Assume { expires_in: 900 }).await;
    let id = bound_connection(&state).await;
    let (status, body) = call(
        &state,
        "POST",
        &format!("/api/v1/connections/{id}/mint"),
        Some(json!({"duration_seconds": 3600})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    let (status, _) = call(
        &state,
        "DELETE",
        &format!("/api/v1/connections/{id}/aws-sts-binding"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, body) = call(
        &state,
        "POST",
        &format!("/api/v1/connections/{id}/mint"),
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(body["error"], "unmintable");
    assert!(stand_in.hits().is_empty(), "nothing may reach STS");
}

#[tokio::test]
async fn an_sts_refusal_is_a_stable_code_with_none_of_its_words() {
    let (state, stand_in) = aws_harness(Reply::Error {
        status: 403,
        code: "AccessDenied",
    })
    .await;
    let id = bound_connection(&state).await;
    let (status, body) = call(
        &state,
        "POST",
        &format!("/api/v1/connections/{id}/mint"),
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_GATEWAY, "{body}");
    assert_eq!(body["error"], "aws.sts.access_denied");
    assert!(
        !body.to_string().contains(stand_in::UPSTREAM_MESSAGE),
        "{body}"
    );
    assert_no_source("refusal", &body.to_string());
    assert_eq!(stand_in.hits().len(), 1, "AccessDenied is not retried");
}

#[tokio::test]
async fn a_binding_is_refused_on_a_connection_that_holds_no_key() {
    let (state, _stand_in) = aws_harness(Reply::Assume { expires_in: 900 }).await;
    // `aws-sts` is the browser's STS family; on the Host it holds no key pair.
    let (_, created) = call(
        &state,
        "POST",
        "/api/v1/connections",
        Some(json!({"provider_id": "aws-sts"})),
    )
    .await;
    let id = created["connection_id"].as_str().unwrap();
    let (status, body) = call(
        &state,
        "PUT",
        &format!("/api/v1/connections/{id}/aws-sts-binding"),
        Some(json!({"role_arn": "arn:aws:iam::123456789012:role/D", "region": "eu-west-1"})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    let (status, body) = call(
        &state,
        "PUT",
        &format!("/api/v1/connections/{id}/aws-sts-binding"),
        Some(json!({"role_arn": 7, "region": "eu-west-1", "external_id": EXTERNAL_ID})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_no_source("parse refusal", &body.to_string());
}

#[path = "aws_sts_receipt_tests.rs"]
mod receipt;
