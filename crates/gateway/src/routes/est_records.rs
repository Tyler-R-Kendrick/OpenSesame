//! EST record keeping and response shaping: what an enrollment files, and how
//! its answer travels (RFC 7030 `certs-only`, base64 on the wire).
//!
//! The inventory record is what makes "the certificate being replaced" work
//! at re-enrollment. The issuance request and its certificate are created
//! completed: EST's response *is* the delivery, so there is no sealed pickup
//! object (that shape belongs to managed-key issuance).

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use base64::Engine as _;
use opensesame_pki_core::leaf::IssuedLeaf;
use opensesame_storage::{
    StoredCertificateIssuanceRequest, StoredCertificateProfile, StoredManagedCertificate,
};
use serde_json::json;

use super::est_server::refuse;
use crate::app_state::AppState;

/// `time::OffsetDateTime` → RFC 3339, through the timestamp only.
fn rfc3339(unix_seconds: i64) -> String {
    chrono::DateTime::from_timestamp(unix_seconds, 0)
        .unwrap_or_default()
        .to_rfc3339()
}

/// Files the enrolled certificate in the inventory.
pub(super) async fn record_issued(
    st: &AppState,
    profile: &StoredCertificateProfile,
    issued: &IssuedLeaf,
    common_name: &str,
    san_json: String,
) -> anyhow::Result<()> {
    let now = chrono::Utc::now().to_rfc3339();
    let request_id = format!("certificate-request:{}", uuid::Uuid::new_v4());
    let fingerprint = issued.fingerprint_sha256.clone();
    st.db
        .insert_certificate_issuance_request(&StoredCertificateIssuanceRequest {
            id: request_id.clone(),
            organization_id: profile.organization_id.clone(),
            authority_id: profile.certificate_authority_id.clone().unwrap_or_default(),
            request_digest: format!("est:{fingerprint}"),
            idempotency_key: format!("est:{request_id}"),
            created_by: "est-enrollment".into(),
            state: "completed".into(),
            common_name: common_name.to_owned(),
            san_json: san_json.clone(),
            delivery: None,
            expires_at: now.clone(),
            version: 1,
            created_at: now.clone(),
            updated_at: now.clone(),
        })
        .await?;
    st.db
        .insert_certificate_row(&StoredManagedCertificate {
            id: format!("certificate:{}", uuid::Uuid::new_v4()),
            organization_id: profile.organization_id.clone(),
            authority_id: profile.certificate_authority_id.clone().unwrap_or_default(),
            request_id,
            certificate_digest: fingerprint.clone(),
            serial_number: issued.serial_hex.clone(),
            common_name: common_name.to_owned(),
            san_json,
            not_before: rfc3339(issued.not_before.unix_timestamp()),
            expires_at: rfc3339(issued.not_after.unix_timestamp()),
            status: "active".into(),
            application_id: None,
            profile_id: Some(profile.id.clone()),
            source: "issued".into(),
            enrollment_method: Some("est".into()),
            metadata_json: "{}".into(),
            key_algorithm: None,
            signature_algorithm: None,
            fingerprint_sha256: Some(fingerprint),
            chain_pem: Some(issued.chain_pem.clone()),
            renewed_from_id: None,
            renewed_by_id: None,
            auto_renew_enabled: false,
            renew_before_seconds: None,
            revocation_reason: None,
            revoked_at: None,
            version: 1,
            created_at: now.clone(),
            updated_at: now,
        })
        .await
}

/// The `certs-only` response with RFC 7030 headers (base64 on the wire).
pub(super) fn p7_response(p7: Vec<u8>) -> Response {
    use axum::http::header::{HeaderName, CONTENT_TYPE};
    let encoded = base64::engine::general_purpose::STANDARD.encode(p7);
    (
        [
            (CONTENT_TYPE, "application/pkcs7-mime".to_string()),
            (
                HeaderName::from_static("content-transfer-encoding"),
                "base64".to_string(),
            ),
        ],
        encoded,
    )
        .into_response()
}

/// Maps an enrollment-core refusal onto its stable wire code.
pub(super) fn enrollment_error(error: super::est_enrollment::EstError) -> Response {
    use super::est_enrollment::EstError;
    match error {
        error @ (EstError::InvalidCsr | EstError::PolicyDenied(_)) => {
            let violations = match &error {
                EstError::PolicyDenied(violations) => {
                    serde_json::to_value(violations).unwrap_or(serde_json::Value::Null)
                }
                _ => serde_json::Value::Null,
            };
            (
                StatusCode::BAD_REQUEST,
                Json(json!({"error": error.code(), "violations": violations})),
            )
                .into_response()
        }
        EstError::IssuerUnavailable => refuse(
            StatusCode::SERVICE_UNAVAILABLE,
            "issuer_unavailable",
            "the profile's authority could not sign; nothing was issued",
        ),
    }
}
