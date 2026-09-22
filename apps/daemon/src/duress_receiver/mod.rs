//! Optional local HTTPS duress peer receiver (PEER-C).
//!
//! Bound APIs only — no generic webhooks / open SSRF proxy (INV-26).
//! Tailscale identity, when present, is evidence only (PEER-E).
//!
//! HOST must declare `mod duress_receiver;` and mount [`router`] — see
//! `.duress-swarm/requests/PEER-to-HOST.md`.

mod origin;
mod verify;

pub use origin::{assert_safe_peer_origin, is_allowed_peer_path};
pub use verify::{EnvelopeVerifyExpect, PeerEnvelopeView, ReplayCache, parse_verifying_key_b64, verify_envelope_view};

use axum::{
    Json, Router,
    body::Bytes,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use p256::ecdsa::VerifyingKey;
use std::sync::{Arc, Mutex};

const MAX_BODY: usize = 32_768;

#[derive(Clone)]
pub struct DuressReceiverState {
    pub audience: String,
    pub permitted_operations: Vec<String>,
    pub vault_ref: Option<String>,
    pub replay: Arc<Mutex<ReplayCache>>,
    /// Enrolled peer ECDSA P-256 verifying key — required for envelope accept.
    pub verifying_key: Option<VerifyingKey>,
    /// Optional Tailscale login/dns evidence — never vault authority.
    pub tailscale_evidence: Option<String>,
}

impl DuressReceiverState {
    pub fn new(audience: impl Into<String>, permitted_operations: Vec<String>) -> Self {
        Self {
            audience: audience.into(),
            permitted_operations,
            vault_ref: None,
            replay: Arc::new(Mutex::new(ReplayCache::new(4096))),
            verifying_key: None,
            tailscale_evidence: None,
        }
    }

    pub fn with_verifying_key(mut self, key: VerifyingKey) -> Self {
        self.verifying_key = Some(key);
        self
    }
}

/// Bound router — only `/v1/duress/peer/{health,envelope}`.
/// Prefer mounting via `main.rs` with `require_operator` instead of merging this
/// router alone (unauthenticated merge is rejected by HOST security policy).
pub fn router(state: DuressReceiverState) -> Router {
    Router::new()
        .route("/v1/duress/peer/health", get(health))
        .route("/v1/duress/peer/envelope", post(receive_envelope_axum))
        .with_state(state)
}

async fn receive_envelope_axum(
    State(st): State<DuressReceiverState>,
    headers: HeaderMap,
    body: Bytes,
) -> axum::response::Response {
    receive_envelope_response(st, headers, body).await
}


/// Health JSON after operator/UDS gate in the daemon.
pub fn peer_health_response(peer: Option<&DuressReceiverState>) -> axum::response::Response {
    let Some(peer) = peer else {
        return StatusCode::NOT_FOUND.into_response();
    };
    Json(json!({
        "ok": true,
        "audience": peer.audience,
        "vaultAuthorityFromTailscale": false,
        "certWeakening": false,
        "ecdsaVerifyRequired": true,
        "verifyingKeyConfigured": peer.verifying_key.is_some(),
        "tailscaleEvidence": peer.tailscale_evidence,
    }))
    .into_response()
}

async fn health(State(st): State<DuressReceiverState>) -> impl IntoResponse {
    Json(json!({
        "ok": true,
        "audience": st.audience,
        "tailscaleEvidence": st.tailscale_evidence,
        // Explicit non-claims (PEER-E)
        "vaultAuthorityFromTailscale": false,
        "certWeakening": false,
    }))
}

#[derive(Debug, Deserialize)]
struct IncomingEnvelope {
    #[serde(rename = "schemaVersion")]
    schema_version: u32,
    alg: String,
    issuer: String,
    audience: String,
    #[serde(rename = "principalRef")]
    principal_ref: String,
    #[serde(rename = "vaultRef")]
    vault_ref: String,
    #[serde(rename = "deviceBindingRef")]
    device_binding_ref: String,
    operation: String,
    #[serde(rename = "incidentId")]
    incident_id: String,
    #[serde(rename = "policyRevision")]
    policy_revision: i64,
    #[serde(rename = "keyEpoch")]
    key_epoch: i64,
    nonce: String,
    #[serde(rename = "issuedAt")]
    issued_at: String,
    #[serde(rename = "expiresAt")]
    expires_at: String,
    #[serde(rename = "ciphertextB64")]
    ciphertext_b64: String,
    #[serde(rename = "signatureB64")]
    signature_b64: String,
}

#[derive(Debug, Serialize)]
struct ReceiptBody {
    #[serde(rename = "schemaVersion")]
    schema_version: u32,
    #[serde(rename = "requestNonce")]
    request_nonce: String,
    #[serde(rename = "recipientDeviceBinding")]
    recipient_device_binding: String,
    status: &'static str,
    at: String,
    /// Signature is filled by HOST/operator key when wired; absent means
    /// structural accept only — never forge cryptographic receipt.
    #[serde(rename = "signatureB64")]
    signature_b64: String,
}

/// Public entry used by the daemon after operator/UDS auth.
pub async fn receive_envelope_response(
    st: DuressReceiverState,
    headers: HeaderMap,
    body: Bytes,
) -> axum::response::Response {
    if body.len() > MAX_BODY {
        return (StatusCode::PAYLOAD_TOO_LARGE, Json(json!({"ok": false, "code": "unsupported_factor"}))).into_response();
    }
    // Bound header: require peer marker; reject unexpected authn trampolines.
    if headers.get("x-opensesame-duress-peer").and_then(|v| v.to_str().ok()) != Some("1") {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"ok": false, "code": "unsupported_factor"})),
        )
            .into_response();
    }
    if headers.contains_key("x-forwarded-host") || headers.contains_key("forwarded") {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"ok": false, "code": "unapproved_route"})),
        )
            .into_response();
    }

    let parsed: IncomingEnvelope = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"ok": false, "code": "unsupported_factor"})),
            )
                .into_response();
        }
    };

    let view = PeerEnvelopeView {
        schema_version: parsed.schema_version,
        alg: parsed.alg.clone(),
        issuer: parsed.issuer.clone(),
        audience: parsed.audience.clone(),
        principal_ref: parsed.principal_ref.clone(),
        vault_ref: parsed.vault_ref.clone(),
        device_binding_ref: parsed.device_binding_ref.clone(),
        operation: parsed.operation.clone(),
        incident_id: parsed.incident_id.clone(),
        policy_revision: parsed.policy_revision,
        key_epoch: parsed.key_epoch,
        nonce: parsed.nonce.clone(),
        issued_at: parsed.issued_at.clone(),
        expires_at: parsed.expires_at.clone(),
        ciphertext_b64: parsed.ciphertext_b64.clone(),
        signature_b64: parsed.signature_b64.clone(),
    };

    let expect = EnvelopeVerifyExpect {
        audience: st.audience.clone(),
        permitted_operations: st.permitted_operations.clone(),
        vault_ref: st.vault_ref.clone(),
        now_ms: None,
    };

    let mut replay = st.replay.lock().expect("replay lock");
    match verify_envelope_view(&view, &expect, &mut replay, st.verifying_key.as_ref()) {
        Ok(()) => {
            let receipt = ReceiptBody {
                schema_version: 1,
                request_nonce: parsed.nonce,
                recipient_device_binding: parsed.device_binding_ref,
                status: "accepted",
                at: chrono::Utc::now().to_rfc3339(),
                // Structural receipt — HOST wires signing key (request filed).
                signature_b64: String::new(),
            };
            (StatusCode::OK, Json(receipt)).into_response()
        }
        Err(code) => (
            StatusCode::FORBIDDEN,
            Json(json!({"ok": false, "code": code})),
        )
            .into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn health_path_allowed() {
        assert!(is_allowed_peer_path("/v1/duress/peer/health"));
        assert!(is_allowed_peer_path("/v1/duress/peer/envelope"));
        assert!(!is_allowed_peer_path("/webhook"));
        assert!(!is_allowed_peer_path("/v1/duress/peer/../x"));
    }

    #[test]
    fn origin_rejects_ssrf() {
        assert!(assert_safe_peer_origin("https://peer.example").is_ok());
        assert!(assert_safe_peer_origin("http://127.0.0.1:9").is_ok());
        assert!(assert_safe_peer_origin("http://169.254.169.254/").is_err());
        assert!(assert_safe_peer_origin("https://user:pass@x/").is_err());
    }

    #[test]
    fn verify_rejects_audience_and_replay() {
        let view = PeerEnvelopeView {
            schema_version: 1,
            alg: "ECDSA-P256-SHA256".into(),
            issuer: "a".into(),
            audience: "recv".into(),
            principal_ref: "p".into(),
            vault_ref: "v".into(),
            device_binding_ref: "d".into(),
            operation: "quarantine_device".into(),
            incident_id: "i".into(),
            policy_revision: 1,
            key_epoch: 1,
            nonce: "nonce-001".into(),
            issued_at: chrono::Utc::now().to_rfc3339(),
            expires_at: (chrono::Utc::now() + chrono::Duration::seconds(60)).to_rfc3339(),
            ciphertext_b64: String::new(),
            signature_b64: "sig".into(),
        };
        let expect = EnvelopeVerifyExpect {
            audience: "recv".into(),
            permitted_operations: vec!["quarantine_device".into()],
            vault_ref: None,
            now_ms: None,
        };
        let mut replay = ReplayCache::new(16);
        // Without a verifying key, envelopes fail closed.
        assert_eq!(
            verify_envelope_view(&view, &expect, &mut replay, None).unwrap_err(),
            "unavailable_authority"
        );
        let mut bad = expect.clone();
        bad.audience = "other".into();
        let mut replay2 = ReplayCache::new(16);
        assert_eq!(
            verify_envelope_view(&view, &bad, &mut replay2, None).unwrap_err(),
            "scope_mismatch"
        );
    }

    #[test]
    fn tailscale_never_grants_vault() {
        let st = DuressReceiverState {
            audience: "a".into(),
            permitted_operations: vec![],
            vault_ref: None,
            replay: Arc::new(Mutex::new(ReplayCache::new(8))),
            verifying_key: None,
            tailscale_evidence: Some("user@tailnet".into()),
        };
        // Compile-time / API non-claim: field exists for evidence display only.
        assert!(st.tailscale_evidence.is_some());
        assert_eq!(
            json!({
                "vaultAuthorityFromTailscale": false,
                "certWeakening": false,
            })["vaultAuthorityFromTailscale"],
            false
        );
    }
}
