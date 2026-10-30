//! Durable admission before a low-entropy EST credential is examined.
use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use opensesame_security_events::{NoticeState, SecurityNotice, Severity};
use opensesame_storage::StoredEstConfig;
use serde_json::json;

use crate::app_state::AppState;

pub(super) async fn reserve(st: &AppState, config: &StoredEstConfig) -> Result<(), Response> {
    let now = chrono::Utc::now();
    let reserved = st
        .db
        .admit_est_passphrase_attempt(&config.organization_id, &config.id, now.timestamp())
        .await
        .map_err(|error| super::internal(error, "reserve est passphrase check"))?;
    let Some(attempt) = reserved else {
        return Err((
            StatusCode::TOO_MANY_REQUESTS,
            [(axum::http::header::RETRY_AFTER, "600")],
            Json(json!({"error":"too_many_attempts"})),
        )
            .into_response());
    };
    if attempt == 5 {
        // The atomic reservation emits once per window, rather than allowing
        // rejected requests to amplify the security-event feed without bound.
        let notice = SecurityNotice {
            event_type: "certmgr.est.verification_budget_exhausted".into(),
            severity: Severity::Warning,
            state: NoticeState::Firing,
            organization_id: config.organization_id.clone(),
            subject_kind: "certificate_profile".into(),
            subject_id: config.profile_id.clone(),
            label: None,
            occurred_at: now,
            summary: "EST enrollment verification budget exhausted".into(),
            detail: Some("Further password checks are refused for this window; certificate authentication remains available".into()),
            payload: json!({"profile_id":config.profile_id,"limit":5,"window_seconds":600,"secrets_returned":false}),
        };
        crate::security::dispatch::publish(st, &notice, now).await;
    }
    Ok(())
}
