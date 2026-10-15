//! Read-only root-trust view for the unlocked PWA (D7-2 d).

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;

use opensesame_cli_app_integration::{process_executable_sha256_hex, sas_from_fingerprint};

use crate::App;

use super::auth::require_paired_caller;
use super::root_trust::{effective_guard_socket, load};

pub(crate) async fn root_trust_status(State(st): State<App>, headers: HeaderMap) -> Response {
    if let Err(resp) = require_paired_caller(&st, &headers) {
        return resp;
    }
    let Some(dir) = st.cli_root_trust_dir.as_deref() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "root_trust_store_unavailable" })),
        )
            .into_response();
    };
    let guard_configured = effective_guard_socket().is_some();
    match load(dir) {
        Ok(super::root_trust::LoadOutcome::Absent) => {
            Json(json!({
                "status": "absent",
                "guardConfigured": guard_configured,
            }))
            .into_response()
        }
        Ok(super::root_trust::LoadOutcome::Enrolled(record)) => {
            let fingerprint = record.spki_fingerprint();
            Json(json!({
                "status": "enrolled",
                "spkiFingerprint": fingerprint,
                "spkiSas": sas_from_fingerprint(fingerprint),
                "enrollmentEpoch": record.enrollment_epoch(),
                "daemonBinarySha256": process_executable_sha256_hex(),
                "guardConfigured": guard_configured,
            }))
            .into_response()
        }
        Err(_) => (
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "root_trust_unreadable" })),
        )
            .into_response(),
    }
}
