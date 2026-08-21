//! Host certificate issuance (Infisical-style private CA).
//!
//! Pages and the CLI authenticate as a Host session. Leaf private keys are
//! returned once on issue and never persisted.

use std::net::IpAddr;
use std::time::Duration as StdDuration;

use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use serde_json::json;

use crate::app_state::AppState;
use crate::dev_pki::{
    self, DevCa, IssuedRecord, DEFAULT_TTL, DEV_CA_CN, MAX_TTL,
};
use crate::middleware::auth::{resolve_caller, Caller};

const KV_CA: &str = "certs.dev_ca";
const KV_ISSUED: &str = "certs.issued";
const MAX_ISSUED: usize = 256;

fn require_configurator(st: &AppState, headers: &axum::http::HeaderMap) -> Result<Caller, Response> {
    let who = resolve_caller(st, headers)?;
    if !who.can_configure_integrations() {
        return Err((
            StatusCode::FORBIDDEN,
            Json(json!({
                "error": "forbidden",
                "hint": "owner or admin role required to issue certificates"
            })),
        )
            .into_response());
    }
    Ok(who)
}

async fn load_or_create_ca(st: &AppState) -> Result<DevCa, Response> {
    if let Some(raw) = st
        .db
        .get_host_kv(KV_CA)
        .await
        .map_err(|error| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error":"internal","hint": error.to_string()})),
            )
                .into_response()
        })?
    {
        return serde_json::from_str(&raw).map_err(|error| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error":"internal","hint": error.to_string()})),
            )
                .into_response()
        });
    }
    let ca = dev_pki::generate_dev_ca().map_err(|hint| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error":"internal","hint": hint})),
        )
            .into_response()
    })?;
    let encoded = serde_json::to_string(&ca).map_err(|error| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error":"internal","hint": error.to_string()})),
        )
            .into_response()
    })?;
    let claimed = st
        .db
        .try_claim_host_kv(KV_CA, &encoded)
        .await
        .map_err(|error| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error":"internal","hint": error.to_string()})),
            )
                .into_response()
        })?;
    if claimed {
        return Ok(ca);
    }
    let raw = st
        .db
        .get_host_kv(KV_CA)
        .await
        .map_err(|error| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error":"internal","hint": error.to_string()})),
            )
                .into_response()
        })?
        .ok_or_else(|| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error":"internal","hint": "dev CA missing after claim race"})),
            )
                .into_response()
        })?;
    serde_json::from_str(&raw).map_err(|error| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error":"internal","hint": error.to_string()})),
        )
            .into_response()
    })
}

async fn load_issued(st: &AppState) -> Result<Vec<IssuedRecord>, Response> {
    let Some(raw) = st.db.get_host_kv(KV_ISSUED).await.map_err(|error| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error":"internal","hint": error.to_string()})),
        )
            .into_response()
    })?
    else {
        return Ok(Vec::new());
    };
    serde_json::from_str(&raw).map_err(|error| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error":"internal","hint": error.to_string()})),
        )
            .into_response()
    })
}

async fn save_issued(st: &AppState, rows: &[IssuedRecord]) -> Result<(), Response> {
    let encoded = serde_json::to_string(rows).map_err(|error| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error":"internal","hint": error.to_string()})),
        )
            .into_response()
    })?;
    st.db.set_host_kv(KV_ISSUED, &encoded).await.map_err(|error| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error":"internal","hint": error.to_string()})),
        )
            .into_response()
    })
}

pub async fn get_ca(State(st): State<AppState>, headers: axum::http::HeaderMap) -> Response {
    if let Err(resp) = require_configurator(&st, &headers) {
        return resp;
    }
    match load_or_create_ca(&st).await {
        Ok(ca) => (
            StatusCode::OK,
            Json(json!({
                "ca": {
                    "common_name": DEV_CA_CN,
                    "certificate": ca.cert_pem,
                    "purpose": "dev",
                }
            })),
        )
            .into_response(),
        Err(resp) => resp,
    }
}

pub async fn list_issued(State(st): State<AppState>, headers: axum::http::HeaderMap) -> Response {
    if let Err(resp) = require_configurator(&st, &headers) {
        return resp;
    }
    match load_issued(&st).await {
        Ok(certs) => (StatusCode::OK, Json(json!({ "certificates": certs }))).into_response(),
        Err(resp) => resp,
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IssueBody {
    pub common_name: String,
    #[serde(default)]
    pub dns_names: Vec<String>,
    #[serde(default)]
    pub ip_addrs: Vec<String>,
    #[serde(default)]
    pub ttl_hours: Option<u64>,
}

pub async fn issue(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(body): Json<IssueBody>,
) -> Response {
    if let Err(resp) = require_configurator(&st, &headers) {
        return resp;
    }
    let ca = match load_or_create_ca(&st).await {
        Ok(ca) => ca,
        Err(resp) => return resp,
    };
    let mut ips = Vec::new();
    for raw in &body.ip_addrs {
        match raw.parse::<IpAddr>() {
            Ok(ip) => ips.push(ip),
            Err(_) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(json!({"error":"invalid_request","hint": format!("not an IP address: {raw}")})),
                )
                    .into_response();
            }
        }
    }
    let ttl = body
        .ttl_hours
        .map(|hours| StdDuration::from_secs(hours.saturating_mul(3600)))
        .filter(|ttl| !ttl.is_zero())
        .unwrap_or(DEFAULT_TTL)
        .min(MAX_TTL);
    let issued = match dev_pki::issue_leaf(
        &ca,
        &dev_pki::IssueRequest {
            common_name: body.common_name,
            dns_names: body.dns_names,
            ip_addrs: ips,
            ttl,
        },
    ) {
        Ok(issued) => issued,
        Err(hint) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"error":"invalid_request","hint": hint})),
            )
                .into_response();
        }
    };
    let mut rows = match load_issued(&st).await {
        Ok(rows) => rows,
        Err(resp) => return resp,
    };
    rows.insert(0, dev_pki::to_record(&issued));
    rows.truncate(MAX_ISSUED);
    if let Err(resp) = save_issued(&st, &rows).await {
        return resp;
    }
    (
        StatusCode::OK,
        Json(json!({
            "certificate": issued.certificate,
            "private_key": issued.private_key,
            "ca_certificate": issued.ca_certificate,
            "serial": issued.serial,
            "common_name": issued.common_name,
            "dns_names": issued.dns_names,
            "not_before": issued.not_before,
            "not_after": issued.not_after,
            "purpose": "dev",
        })),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use crate::app_state::{self, test_env, test_session_headers, AppState};
    use crate::config::{Args, DEV_OPERATOR_TOKEN};
    use axum::body::{to_bytes, Body};
    use axum::http::{Request, StatusCode};
    use serde_json::{json, Value};
    use tower::ServiceExt;

    fn env_lock() -> std::sync::MutexGuard<'static, ()> {
        test_env::lock()
    }

    async fn memory_state() -> AppState {
        app_state::build(Args {
            listen: "127.0.0.1:0".parse().unwrap(),
            resource: "https://opensesame.local".into(),
            issuer: "https://issuer.local".into(),
            database_url: "sqlite::memory:".into(),
            task_database_url: String::new(),
        })
        .await
        .unwrap()
    }

    async fn call(
        state: &AppState,
        method: &str,
        path: &str,
        headers: Option<axum::http::HeaderMap>,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let mut request = Request::builder().method(method).uri(path);
        match headers {
            Some(map) => {
                for (name, value) in map.iter() {
                    request = request.header(name, value);
                }
            }
            None => {
                request = request.header(
                    "authorization",
                    format!("Bearer operator:{DEV_OPERATOR_TOKEN}"),
                );
            }
        }
        let request = match body {
            Some(value) => request
                .header("content-type", "application/json")
                .body(Body::from(value.to_string()))
                .unwrap(),
            None => request.body(Body::empty()).unwrap(),
        };
        let response = crate::routes::router(state.clone())
            .oneshot(request)
            .await
            .unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
        let value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        (status, value)
    }

    #[tokio::test]
    async fn owner_session_issues_a_localhost_dev_cert() {
        let _guard = env_lock();
        let state = memory_state().await;
        let headers = test_session_headers(
            &state,
            "prn_owner",
            state.connection_organization,
            opensesame_domain::OrganizationRole::Owner,
        );
        let (status, body) = call(
            &state,
            "POST",
            "/api/v1/certs/issue",
            Some(headers.clone()),
            Some(json!({
                "common_name": "localhost",
                "dns_names": ["localhost"],
                "ip_addrs": ["127.0.0.1"],
                "ttl_hours": 24
            })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert!(body["certificate"].as_str().unwrap().contains("BEGIN CERTIFICATE"));
        assert!(body["private_key"].as_str().unwrap().contains("BEGIN"));
        assert_eq!(body["common_name"], "localhost");
        assert_eq!(body["purpose"], "dev");

        let (status, ca) = call(&state, "GET", "/api/v1/certs/ca", Some(headers.clone()), None).await;
        assert_eq!(status, StatusCode::OK, "{ca}");
        assert_eq!(ca["ca"]["certificate"], body["ca_certificate"]);

        let (status, list) = call(&state, "GET", "/api/v1/certs", Some(headers), None).await;
        assert_eq!(status, StatusCode::OK, "{list}");
        assert_eq!(list["certificates"][0]["common_name"], "localhost");
        assert!(list["certificates"][0]["private_key"].is_null());
    }

    #[tokio::test]
    async fn member_cannot_issue() {
        let _guard = env_lock();
        let state = memory_state().await;
        let headers = test_session_headers(
            &state,
            "prn_member",
            state.connection_organization,
            opensesame_domain::OrganizationRole::Member,
        );
        let (status, _) = call(
            &state,
            "POST",
            "/api/v1/certs/issue",
            Some(headers),
            Some(json!({"common_name": "localhost"})),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
    }
}
