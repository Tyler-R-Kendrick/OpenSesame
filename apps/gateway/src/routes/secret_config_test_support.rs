use super::*;

pub(super) fn router(state: AppState) -> Router {
    crate::routes::router(state)
}

pub(super) async fn state_with_seal_key() -> AppState {
    let mut st = test_demo_state().await;
    st.connection_broker = Arc::new(
        ConnectionBroker::new(
            st.db.pool().clone(),
            BrokerConfig::in_memory(Some([42u8; 32]), "http://127.0.0.1:8787"),
        )
        .unwrap(),
    );
    for (subject, role) in [
        (P04, OrganizationRole::Admin),
        (P05, OrganizationRole::Member),
    ] {
        opensesame_connection_broker::config_access::set_role_ceiling(
            st.db.pool(),
            &st.connection_organization,
            &crate::session_claims::parse_principal(subject).unwrap(),
            Some(role),
            0,
            0,
        )
        .await
        .unwrap();
    }
    st
}

pub(super) async fn send(
    app: &Router,
    headers: &axum::http::HeaderMap,
    method: &str,
    uri: &str,
    body: Option<serde_json::Value>,
) -> (StatusCode, serde_json::Value) {
    let mut builder = Request::builder().method(method).uri(uri).header(
        "authorization",
        headers.get("authorization").unwrap().as_bytes(),
    );
    let body = match body {
        Some(json) => {
            builder = builder.header("content-type", "application/json");
            Body::from(json.to_string())
        }
        None => Body::empty(),
    };
    let res = app
        .clone()
        .oneshot(builder.body(body).unwrap())
        .await
        .unwrap();
    let status = res.status();
    let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    let value = if bytes.is_empty() {
        json!({})
    } else {
        serde_json::from_slice(&bytes).unwrap_or_else(|_| json!({}))
    };
    (status, value)
}
