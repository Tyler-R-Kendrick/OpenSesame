//! Breach-exposure routes (ADR 0080).
//!
//! Three surfaces, all owner/admin or operator — the same gate as hook
//! subscriptions, because all three concern which of an organization's secrets
//! are exposed:
//!
//! - `GET /api/v1/security/findings` — the breach ledger, so an operator sees
//!   what is exposed and what has since been rotated without reading logs.
//! - `POST /api/v1/security/breach-scan` — run a catalogue pass now. The same
//!   function the tick calls, so a tool can drive the feed rather than waiting
//!   six hours.
//! - `POST /api/v1/security/breach-check` — vet one candidate secret against
//!   the password corpus before it is stored.
//!
//! That last one is the only route in the product that accepts a secret value,
//! and it is worth saying why it exists and what it does not do. NIST SP
//! 800-63B asks that a chosen password be checked against known-breached
//! corpora *at the moment it is set*, which is the check that actually prevents
//! the exposure rather than reporting it afterwards. The value is used to
//! compute a SHA-1, five characters of which leave the host; it is never
//! written to the database, never logged, and never included in the response or
//! in any published event. What is persisted is a finding about the named
//! subject — metadata, like every other row on this feed.

use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use chrono::Utc;
use opensesame_breach_intel::{BreachEvent, BreachSource, BreachSubject, BreachSubjectKind};
use opensesame_storage::StoredBreachFinding;
use serde::Deserialize;
use serde_json::{json, Value};
use zeroize::Zeroize as _;

use crate::app_state::AppState;
use crate::breach::{scanner, sources};
use crate::middleware::auth::{resolve_caller, resolve_caller_organization, Caller};
use crate::security;

/// Findings returned without an explicit limit.
const DEFAULT_FINDING_LIMIT: usize = 100;
/// Ceiling on the limit a caller may ask for.
const MAX_FINDING_LIMIT: usize = 500;
/// Longest subject id accepted on a check.
const MAX_SUBJECT_CHARS: usize = 256;
/// Longest candidate secret accepted.
///
/// Not a password policy — it is a bound on what one request may make us hash,
/// well above any real passphrase.
const MAX_SECRET_BYTES: usize = 4_096;

/// Exposure is integration configuration: owner/admin or the operator.
#[allow(clippy::result_large_err)]
fn authorize(st: &AppState, headers: &axum::http::HeaderMap) -> Result<Caller, Response> {
    let who = resolve_caller(st, headers)?;
    if !who.can_configure_integrations() {
        return Err((
            StatusCode::FORBIDDEN,
            Json(json!({
                "error": "forbidden",
                "hint": "owner or admin role required to read or run breach checks",
            })),
        )
            .into_response());
    }
    Ok(who)
}

fn bad_request(hint: &str) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({"error": "invalid_request", "hint": hint})),
    )
        .into_response()
}

fn internal(error: &impl std::fmt::Display, context: &str) -> Response {
    tracing::error!(%error, context, "security route failed");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({"error": "internal_error", "hint": context})),
    )
        .into_response()
}

/// One finding, as metadata.
#[must_use]
pub fn finding_json(finding: &StoredBreachFinding) -> Value {
    json!({
        "subject_kind": finding.subject_kind,
        "subject_id": finding.subject_id,
        "source": finding.source,
        "reference": finding.reference,
        "severity": finding.severity,
        "occurrences": finding.occurrences,
        "state": finding.state,
        "first_seen_at": finding.first_seen_at,
        "last_seen_at": finding.last_seen_at,
        "cleared_at": finding.cleared_at,
    })
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FindingQuery {
    pub limit: Option<usize>,
}

/// `GET /api/v1/security/findings` — the breach ledger.
pub async fn list_findings(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Query(query): Query<FindingQuery>,
) -> Response {
    let who = match authorize(&st, &headers) {
        Ok(who) => who,
        Err(response) => return response,
    };
    let organization_id = match resolve_caller_organization(&st, &who, &headers) {
        Ok(id) => id,
        Err(response) => return response,
    };
    let limit = query
        .limit
        .unwrap_or(DEFAULT_FINDING_LIMIT)
        .clamp(1, MAX_FINDING_LIMIT);
    match st
        .db
        .list_breach_findings(&organization_id.to_string(), limit)
        .await
    {
        Ok(findings) => Json(json!({
            "findings": findings.iter().map(finding_json).collect::<Vec<_>>(),
            "secrets_returned": false,
        }))
        .into_response(),
        Err(error) => internal(&error, "list breach findings"),
    }
}

/// `POST /api/v1/security/breach-scan` — run one catalogue pass now.
pub async fn scan(State(st): State<AppState>, headers: axum::http::HeaderMap) -> Response {
    let who = match authorize(&st, &headers) {
        Ok(who) => who,
        Err(response) => return response,
    };
    let organization_id = match resolve_caller_organization(&st, &who, &headers) {
        Ok(id) => id,
        Err(response) => return response,
    };
    let now = Utc::now();
    let catalogue = match sources::catalogue().await {
        Ok(entries) => entries,
        Err(error) => {
            // The same failure the tick publishes, so an on-demand scan that
            // cannot reach the corpus is visible on the feed too rather than
            // being a 500 nobody correlates with a coverage gap.
            let event = BreachEvent::scan_failed(
                BreachSource::HibpBreaches,
                organization_id.to_string(),
                &error.to_string(),
                now,
            );
            security::dispatch::publish(&st, &event.notice(), now).await;
            return (
                StatusCode::BAD_GATEWAY,
                Json(json!({
                    "error": "source_unavailable",
                    "hint": "the breach catalogue could not be fetched; breach.scan.failed was published",
                    "secrets_returned": false,
                })),
            )
                .into_response();
        }
    };
    match scanner::scan_organization(&st, &catalogue, &organization_id, now).await {
        Ok(published) => Json(json!({
            "published": published,
            "catalogue_entries": catalogue.len(),
            "secrets_returned": false,
        }))
        .into_response(),
        Err(error) => internal(&error, "run breach scan"),
    }
}

/// A candidate secret to vet, and what to record the answer against.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CheckRequest {
    /// The value to check. Hashed, never stored.
    pub secret: String,
    /// What this secret belongs to, for the finding. A store path, a
    /// connection id — metadata.
    pub subject_id: String,
    /// `store_path` or `connection_credential`. Defaults to `store_path`.
    pub subject_kind: Option<String>,
}

/// `POST /api/v1/security/breach-check` — vet a candidate secret.
///
/// Publishes `breach.password.compromised` when the value is in the corpus, so
/// the answer reaches the same subscribers, notifier, and alerting as every
/// other security event rather than living only in this response.
pub async fn check(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(mut body): Json<CheckRequest>,
) -> Response {
    let response = run_check(&st, &headers, &body).await;
    // Wipe the copy we own. This is hygiene, not a guarantee: the request body
    // was buffered and parsed before it reached us, and those intermediates are
    // not ours to clear. The guarantee that matters is stated elsewhere and is
    // structural — the value is never written to the database, never logged,
    // and never returned.
    body.secret.zeroize();
    response
}

async fn run_check(
    st: &AppState,
    headers: &axum::http::HeaderMap,
    body: &CheckRequest,
) -> Response {
    let who = match authorize(st, headers) {
        Ok(who) => who,
        Err(response) => return response,
    };
    let organization_id = match resolve_caller_organization(st, &who, headers) {
        Ok(id) => id,
        Err(response) => return response,
    };
    let subject = match validate(body, &organization_id.to_string()) {
        Ok(subject) => subject,
        Err(hint) => return bad_request(&hint),
    };

    let digest = opensesame_breach_intel::PwnedDigest::of_secret(&body.secret);
    let occurrences = match sources::password_occurrences(&digest).await {
        Ok(count) => count,
        Err(error) => return source_unavailable(st, &organization_id.to_string(), &error).await,
    };
    settle_check(st, subject, occurrences).await
}

/// Validate the metadata half of a check request.
fn validate(body: &CheckRequest, organization_id: &str) -> Result<BreachSubject, String> {
    if body.secret.is_empty() {
        return Err("secret must not be empty".into());
    }
    if body.secret.len() > MAX_SECRET_BYTES {
        return Err(format!("secret must be at most {MAX_SECRET_BYTES} bytes"));
    }
    if body.subject_id.is_empty() || body.subject_id.chars().count() > MAX_SUBJECT_CHARS {
        return Err(format!(
            "subject_id must be 1..={MAX_SUBJECT_CHARS} characters",
        ));
    }
    let kind = match body.subject_kind.as_deref() {
        None => BreachSubjectKind::StorePath,
        Some(raw) => BreachSubjectKind::parse(raw)
            .filter(|kind| kind.requires_opening())
            .ok_or_else(|| {
                "subject_kind must be store_path or connection_credential".to_string()
            })?,
    };
    Ok(
        BreachSubject::new(kind, body.subject_id.clone(), organization_id)
            .labelled(body.subject_id.clone()),
    )
}

/// Publish `breach.scan.failed` and answer, rather than reporting a clean bill
/// of health we did not get.
async fn source_unavailable(
    st: &AppState,
    organization_id: &str,
    error: &anyhow::Error,
) -> Response {
    let now = Utc::now();
    let event = BreachEvent::scan_failed(
        BreachSource::HibpPasswords,
        organization_id.to_string(),
        &error.to_string(),
        now,
    );
    security::dispatch::publish(st, &event.notice(), now).await;
    (
        StatusCode::BAD_GATEWAY,
        Json(json!({
            "error": "source_unavailable",
            "hint": "the password corpus could not be consulted; breach.scan.failed was published",
            "secrets_returned": false,
        })),
    )
        .into_response()
}

/// Record and publish the answer.
///
/// A clean result clears any open finding for the subject, which resolves the
/// alert an earlier check opened — that is what makes this route usable as the
/// confirmation step after rotating an exposed secret.
async fn settle_check(st: &AppState, subject: BreachSubject, occurrences: u64) -> Response {
    let now = Utc::now();
    let source = BreachSource::HibpPasswords;
    if occurrences == 0 {
        let cleared = match st
            .db
            .clear_breach_finding(
                &subject.organization_id,
                subject.kind.as_str(),
                &subject.subject_id,
                source.as_str(),
                "",
                now,
            )
            .await
        {
            Ok(cleared) => cleared,
            // Reporting "clean, nothing to clear" here would be a lie by
            // omission: the corpus said clean, but the finding an operator can
            // see is still open and we failed to close it.
            Err(error) => return internal(&error, "clear breach finding"),
        };
        if cleared {
            let event = BreachEvent::cleared(subject, source, now);
            security::dispatch::publish(st, &event.notice(), now).await;
        }
        return Json(json!({
            "compromised": false,
            "occurrences": 0,
            "cleared": cleared,
            "secrets_returned": false,
        }))
        .into_response();
    }

    let event = BreachEvent::password_compromised(subject.clone(), occurrences, now);
    let row = StoredBreachFinding {
        organization_id: subject.organization_id.clone(),
        subject_kind: subject.kind.as_str().to_string(),
        subject_id: subject.subject_id.clone(),
        source: source.as_str().to_string(),
        reference: String::new(),
        severity: event.severity.as_str().to_string(),
        occurrences: i64::try_from(occurrences).ok(),
        state: opensesame_storage::BREACH_FINDING_OPEN.to_string(),
        first_seen_at: now.to_rfc3339(),
        last_seen_at: now.to_rfc3339(),
        cleared_at: None,
    };
    match st.db.record_breach_finding(&row, now).await {
        Ok(opened) => {
            if opened {
                security::dispatch::publish(st, &event.notice(), now).await;
            }
            Json(json!({
                "compromised": true,
                "occurrences": occurrences,
                "published": opened,
                "secrets_returned": false,
            }))
            .into_response()
        }
        Err(error) => internal(&error, "record breach finding"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(secret: &str, subject_id: &str, kind: Option<&str>) -> CheckRequest {
        CheckRequest {
            secret: secret.into(),
            subject_id: subject_id.into(),
            subject_kind: kind.map(str::to_string),
        }
    }

    #[test]
    fn a_valid_request_yields_a_metadata_only_subject() {
        let subject = validate(&request("hunter2", "Dev/api-token", None), "org-1").unwrap();
        assert_eq!(subject.kind, BreachSubjectKind::StorePath);
        assert_eq!(subject.subject_id, "Dev/api-token");
        assert_eq!(subject.organization_id, "org-1");
        let encoded = serde_json::to_string(&subject).unwrap();
        assert!(
            !encoded.contains("hunter2"),
            "a subject must not be able to carry the value it is about",
        );
    }

    #[test]
    fn a_connection_credential_is_an_accepted_kind() {
        let subject = validate(
            &request("hunter2", "conn-1", Some("connection_credential")),
            "org-1",
        )
        .unwrap();
        assert_eq!(subject.kind, BreachSubjectKind::ConnectionCredential);
    }

    #[test]
    fn a_kind_with_nothing_to_open_is_refused() {
        for kind in ["domain", "breach_source"] {
            let error =
                validate(&request("hunter2", "adobe.com", Some(kind)), "org-1").unwrap_err();
            assert!(error.contains("store_path"), "{kind}: {error}");
        }
    }

    #[test]
    fn an_unknown_kind_is_refused() {
        assert!(validate(&request("hunter2", "x", Some("planet")), "org-1").is_err());
    }

    #[test]
    fn an_empty_secret_is_refused_rather_than_hashed() {
        let error = validate(&request("", "Dev/api-token", None), "org-1").unwrap_err();
        assert!(error.contains("empty"), "{error}");
    }

    #[test]
    fn an_oversized_secret_is_refused() {
        let long = "x".repeat(MAX_SECRET_BYTES + 1);
        let error = validate(&request(&long, "Dev/api-token", None), "org-1").unwrap_err();
        assert!(error.contains("bytes"), "{error}");
    }

    #[test]
    fn a_missing_or_oversized_subject_is_refused() {
        assert!(validate(&request("hunter2", "", None), "org-1").is_err());
        let long = "x".repeat(MAX_SUBJECT_CHARS + 1);
        assert!(validate(&request("hunter2", &long, None), "org-1").is_err());
    }

    #[test]
    fn a_finding_renders_as_metadata_only() {
        let row = StoredBreachFinding {
            organization_id: "org-1".into(),
            subject_kind: "store_path".into(),
            subject_id: "Dev/api-token".into(),
            source: "hibp_passwords".into(),
            reference: String::new(),
            severity: "critical".into(),
            occurrences: Some(42),
            state: "open".into(),
            first_seen_at: "2026-08-30T00:00:00+00:00".into(),
            last_seen_at: "2026-08-30T00:00:00+00:00".into(),
            cleared_at: None,
        };
        let rendered = finding_json(&row);
        let object = rendered.as_object().unwrap();
        assert_eq!(object["occurrences"], json!(42));
        for key in object.keys() {
            for forbidden in ["secret", "password", "token", "credential"] {
                assert!(!key.contains(forbidden), "finding grew {key}");
            }
        }
    }

    #[test]
    fn the_limit_is_clamped_into_a_sane_range() {
        for (asked, expected) in [
            (None, DEFAULT_FINDING_LIMIT),
            (Some(0), 1),
            (Some(10_000), MAX_FINDING_LIMIT),
            (Some(25), 25),
        ] {
            let limit = asked
                .unwrap_or(DEFAULT_FINDING_LIMIT)
                .clamp(1, MAX_FINDING_LIMIT);
            assert_eq!(limit, expected, "asked {asked:?}");
        }
    }
}

#[cfg(test)]
mod route_tests {
    use super::*;
    use crate::app_state::{test_demo_state, test_session_headers};
    use axum::{
        body::Body,
        http::{Request, StatusCode},
        Router,
    };
    use opensesame_connection_broker::{BrokerConfig, ConnectionBroker};
    use opensesame_domain::OrganizationRole;
    use std::sync::Arc;
    use tower::ServiceExt;

    async fn state_with_seal_key() -> AppState {
        let mut st = test_demo_state().await;
        st.connection_broker = Arc::new(
            ConnectionBroker::new(
                st.db.pool().clone(),
                BrokerConfig::in_memory(Some([42u8; 32]), "http://127.0.0.1:8787"),
            )
            .unwrap(),
        );
        st
    }

    async fn send(
        app: &Router,
        headers: &axum::http::HeaderMap,
        method: &str,
        uri: &str,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
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
        let response = app
            .clone()
            .oneshot(builder.body(body).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let value = if bytes.is_empty() {
            json!({})
        } else {
            serde_json::from_slice(&bytes).unwrap_or_else(|_| json!({}))
        };
        (status, value)
    }

    #[tokio::test]
    async fn an_empty_ledger_reports_no_findings_rather_than_failing() {
        let st = state_with_seal_key().await;
        let org = st.connection_organization;
        let admin = test_session_headers(&st, "principal:admin", org, OrganizationRole::Admin);
        let app = crate::routes::router(st.clone());

        let (status, body) = send(&app, &admin, "GET", "/api/v1/security/findings", None).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["findings"], json!([]));
        assert_eq!(body["secrets_returned"], json!(false));
    }

    #[tokio::test]
    async fn a_member_cannot_read_or_run_breach_surfaces() {
        let st = state_with_seal_key().await;
        let org = st.connection_organization;
        let member = test_session_headers(&st, "principal:member", org, OrganizationRole::Member);
        let app = crate::routes::router(st.clone());

        for (method, uri) in [
            ("GET", "/api/v1/security/findings"),
            ("POST", "/api/v1/security/breach-scan"),
        ] {
            let (status, body) = send(&app, &member, method, uri, None).await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{method} {uri}: {body}");
        }
    }

    #[tokio::test]
    async fn a_breach_check_with_bad_metadata_is_refused_before_anything_is_hashed() {
        let st = state_with_seal_key().await;
        let org = st.connection_organization;
        let admin = test_session_headers(&st, "principal:admin", org, OrganizationRole::Admin);
        let app = crate::routes::router(st.clone());

        for body in [
            json!({"secret": "", "subject_id": "Dev/api-token"}),
            json!({"secret": "hunter2", "subject_id": ""}),
            json!({"secret": "hunter2", "subject_id": "adobe.com", "subject_kind": "domain"}),
        ] {
            let (status, answer) = send(
                &app,
                &admin,
                "POST",
                "/api/v1/security/breach-check",
                Some(body.clone()),
            )
            .await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{body} -> {answer}");
            assert!(
                !answer.to_string().contains("hunter2"),
                "a refusal must not echo the candidate: {answer}",
            );
        }
    }

    #[tokio::test]
    async fn an_alerting_sink_registers_with_its_routing_key_and_a_severity_floor() {
        let st = state_with_seal_key().await;
        let org = st.connection_organization;
        let admin = test_session_headers(&st, "principal:admin", org, OrganizationRole::Admin);
        let app = crate::routes::router(st.clone());

        let (status, created) = send(
            &app,
            &admin,
            "PUT",
            "/api/v1/security/hooks",
            Some(json!({
                "name": "oncall",
                "event_types": ["*"],
                "endpoint_url": "https://events.pagerduty.com/v2/enqueue",
                "delivery": "pagerduty",
                "severity_min": "critical",
                "secret": "R0UT1NGK3Y",
            })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{created}");
        assert_eq!(created["delivery"], json!("pagerduty"));
        assert_eq!(created["severity_min"], json!("critical"));
        assert_eq!(created["signing_secret"], json!("R0UT1NGK3Y"));

        // Shown once, then never again.
        let (status, listed) = send(&app, &admin, "GET", "/api/v1/security/hooks", None).await;
        assert_eq!(status, StatusCode::OK);
        assert!(
            !listed.to_string().contains("R0UT1NGK3Y"),
            "a stored routing key must never render again: {listed}",
        );
    }

    #[tokio::test]
    async fn a_pagerduty_sink_without_a_routing_key_is_refused_at_registration() {
        let st = state_with_seal_key().await;
        let org = st.connection_organization;
        let admin = test_session_headers(&st, "principal:admin", org, OrganizationRole::Admin);
        let app = crate::routes::router(st.clone());

        let (status, body) = send(
            &app,
            &admin,
            "PUT",
            "/api/v1/security/hooks",
            Some(json!({
                "name": "oncall",
                "event_types": ["*"],
                "endpoint_url": "https://events.pagerduty.com/v2/enqueue",
                "delivery": "pagerduty",
            })),
        )
        .await;
        assert_eq!(
            status,
            StatusCode::BAD_REQUEST,
            "a hook that can never deliver must not be stored: {body}",
        );
    }

    #[tokio::test]
    async fn an_internal_responder_cannot_be_registered_over_the_api() {
        let st = state_with_seal_key().await;
        let org = st.connection_organization;
        let admin = test_session_headers(&st, "principal:admin", org, OrganizationRole::Admin);
        let app = crate::routes::router(st.clone());

        let (status, body) = send(
            &app,
            &admin,
            "PUT",
            "/api/v1/security/hooks",
            Some(json!({
                "name": "impostor",
                "event_types": ["*"],
                "endpoint_url": "https://hooks.example.com/in",
                "delivery": "internal",
            })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    }

    #[tokio::test]
    async fn a_subscription_may_name_breach_events_and_a_family_wildcard() {
        let st = state_with_seal_key().await;
        let org = st.connection_organization;
        let admin = test_session_headers(&st, "principal:admin", org, OrganizationRole::Admin);
        let app = crate::routes::router(st.clone());

        let (status, created) = send(
            &app,
            &admin,
            "PUT",
            "/api/v1/security/hooks",
            Some(json!({
                "name": "breach-watcher",
                "event_types": ["breach.*", "lifecycle.renewal.failed"],
                "endpoint_url": "https://hooks.example.com/breach",
            })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{created}");
        assert_eq!(
            created["severity_min"],
            json!("info"),
            "the default floor admits everything"
        );

        let (status, rejected) = send(
            &app,
            &admin,
            "PUT",
            "/api/v1/security/hooks",
            Some(json!({
                "name": "nonsense",
                "event_types": ["rumour.*"],
                "endpoint_url": "https://hooks.example.com/breach",
            })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{rejected}");
    }

    #[tokio::test]
    async fn a_subscription_may_narrow_to_a_breach_subject_kind() {
        let st = state_with_seal_key().await;
        let org = st.connection_organization;
        let admin = test_session_headers(&st, "principal:admin", org, OrganizationRole::Admin);
        let app = crate::routes::router(st.clone());

        let (status, created) = send(
            &app,
            &admin,
            "PUT",
            "/api/v1/security/hooks",
            Some(json!({
                "name": "domains-only",
                "event_types": ["breach.*"],
                "endpoint_url": "https://hooks.example.com/breach",
                "subject_kinds": ["domain"],
            })),
        )
        .await;
        assert_eq!(
            status,
            StatusCode::OK,
            "a breach subject kind must be recognised at registration: {created}",
        );
    }
    #[tokio::test]
    async fn a_published_notice_reaches_a_registered_alerting_sink_as_a_rendered_body() {
        use opensesame_security_events::{Delivery, SecurityNotice, Severity};

        let st = state_with_seal_key().await;
        let org = st.connection_organization;
        let admin = test_session_headers(&st, "principal:admin", org, OrganizationRole::Admin);
        let app = crate::routes::router(st.clone());

        let (status, created) = send(
            &app,
            &admin,
            "PUT",
            "/api/v1/security/hooks",
            Some(json!({
                "name": "prom",
                "event_types": ["breach.*"],
                "endpoint_url": "https://alertmanager.example.com/api/v2/alerts",
                "delivery": "alertmanager",
                "severity_min": "warning",
            })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{created}");
        let hook_id = created["id"].as_str().unwrap().to_string();

        // A breach finding, published exactly the way the scanner publishes one.
        let subject = BreachSubject::new(
            BreachSubjectKind::StorePath,
            "Dev/api-token",
            org.to_string(),
        );
        let event = BreachEvent::password_compromised(subject, 42, Utc::now());
        security::dispatch::publish(&st, &event.notice(), Utc::now()).await;

        let queued = st
            .db
            .list_security_deliveries(&org.to_string(), 50)
            .await
            .unwrap();
        let mine: Vec<_> = queued.iter().filter(|row| row.hook_id == hook_id).collect();
        assert_eq!(
            mine.len(),
            1,
            "the sink should have exactly one queued delivery"
        );
        assert_eq!(mine[0].event_type, "breach.password.compromised");

        // The queued row renders into the Alertmanager v2 body the worker sends.
        let notice: SecurityNotice = serde_json::from_str(&mine[0].payload_json).unwrap();
        let rendered =
            crate::security::sinks::render(Delivery::Alertmanager, &notice, None).unwrap();
        let body: Value = serde_json::from_str(&rendered.body).unwrap();
        assert_eq!(body[0]["labels"]["severity"], json!("critical"));
        assert_eq!(body[0]["labels"]["subject_id"], json!("Dev/api-token"));
        assert_eq!(notice.severity, Severity::Critical);
    }

    #[tokio::test]
    async fn a_quiet_event_does_not_reach_a_sink_that_asked_for_loud_ones() {
        let st = state_with_seal_key().await;
        let org = st.connection_organization;
        let admin = test_session_headers(&st, "principal:admin", org, OrganizationRole::Admin);
        let app = crate::routes::router(st.clone());

        let (_, created) = send(
            &app,
            &admin,
            "PUT",
            "/api/v1/security/hooks",
            Some(json!({
                "name": "pager",
                "event_types": ["*"],
                "endpoint_url": "https://events.pagerduty.com/v2/enqueue",
                "delivery": "pagerduty",
                "severity_min": "critical",
                "secret": "R0UT1NGK3Y",
            })),
        )
        .await;
        let hook_id = created["id"].as_str().unwrap().to_string();

        // A scan failure is a Warning: real, but not something to page for.
        let event = BreachEvent::scan_failed(
            BreachSource::HibpBreaches,
            org.to_string(),
            "connection timed out",
            Utc::now(),
        );
        security::dispatch::publish(&st, &event.notice(), Utc::now()).await;

        let queued = st
            .db
            .list_security_deliveries(&org.to_string(), 50)
            .await
            .unwrap();
        assert!(
            queued.iter().all(|row| row.hook_id != hook_id),
            "a critical-only sink must not be paged for a warning",
        );
    }

    #[tokio::test]
    async fn the_built_in_subscribers_are_seeded_and_visible_to_an_operator() {
        let st = state_with_seal_key().await;
        let org = st.connection_organization;
        let admin = test_session_headers(&st, "principal:admin", org, OrganizationRole::Admin);
        let app = crate::routes::router(st.clone());

        crate::security::hooks::ensure_defaults(&st, &org.to_string(), Utc::now()).await;

        let (status, listed) = send(&app, &admin, "GET", "/api/v1/security/hooks", None).await;
        assert_eq!(status, StatusCode::OK, "{listed}");
        let responders: Vec<&str> = listed["hooks"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|hook| hook["responder"].as_str())
            .collect();
        assert!(responders.contains(&"notify"), "{listed}");
        assert!(responders.contains(&"alert"), "{listed}");

        // Seeding is insert-only: a disabled built-in stays disabled.
        let alert_id = crate::security::hooks::builtin_id(
            crate::security::hooks::ALERT_RESPONDER,
            &org.to_string(),
        );
        let mut disabled = st
            .db
            .get_security_hook(&org.to_string(), &alert_id)
            .await
            .unwrap()
            .unwrap();
        disabled.enabled = false;
        st.db.upsert_security_hook(&disabled).await.unwrap();
        crate::security::hooks::ensure_defaults(&st, &org.to_string(), Utc::now()).await;
        let still = st
            .db
            .get_security_hook(&org.to_string(), &alert_id)
            .await
            .unwrap()
            .unwrap();
        assert!(
            !still.enabled,
            "re-seeding must not revive something an operator turned off",
        );
    }
    #[tokio::test]
    async fn a_built_in_subscriber_cannot_be_rewritten_into_a_webhook() {
        let st = state_with_seal_key().await;
        let org = st.connection_organization;
        let admin = test_session_headers(&st, "principal:admin", org, OrganizationRole::Admin);
        let app = crate::routes::router(st.clone());

        crate::security::hooks::ensure_defaults(&st, &org.to_string(), Utc::now()).await;
        let alert_id = crate::security::hooks::builtin_id(
            crate::security::hooks::ALERT_RESPONDER,
            &org.to_string(),
        );

        let (status, body) = send(
            &app,
            &admin,
            "PUT",
            "/api/v1/security/hooks",
            Some(json!({
                "id": alert_id,
                "name": "hijacked",
                "event_types": ["*"],
                "endpoint_url": "https://attacker.example.com/in",
            })),
        )
        .await;
        assert_eq!(
            status,
            StatusCode::BAD_REQUEST,
            "rewriting a built-in would destroy it permanently: seeding only inserts: {body}",
        );

        let untouched = st
            .db
            .get_security_hook(&org.to_string(), &alert_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(untouched.delivery, "internal");
        assert_eq!(untouched.endpoint_url, None);
    }
}
