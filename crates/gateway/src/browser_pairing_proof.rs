//! Browser proof boundary reuses the existing RFC 9449 cryptographic verifier.
use crate::app_state::AppState;
use axum::{
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use opensesame_host_core::http_security::{is_exact_origin, parse_cors_origins};
use serde_json::json;

pub fn refusal(code: &'static str) -> Response {
    (StatusCode::UNAUTHORIZED, Json(json!({"error":code}))).into_response()
}

pub fn pairable_origins() -> Result<Vec<String>, String> {
    let origins = parse_cors_origins(
        std::env::var("OPENSESAME_BROWSER_PAIRABLE_ORIGINS")
            .ok()
            .as_deref(),
    );
    if origins
        .iter()
        .any(|origin| !is_exact_origin(origin) || origin == "https://tyler-r-kendrick.github.io")
    {
        return Err(
            "OPENSESAME_BROWSER_PAIRABLE_ORIGINS requires dedicated HTTPS or loopback origins"
                .into(),
        );
    }
    Ok(origins)
}

pub fn request_origin(headers: &HeaderMap) -> Result<String, Response> {
    let origin = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| refusal("browser_origin_required"))?;
    let allowed = pairable_origins().map_err(|_| refusal("pairing_unavailable"))?;
    if !allowed.iter().any(|value| value == origin) {
        return Err(refusal("browser_origin_denied"));
    }
    Ok(origin.into())
}

pub async fn validate(
    st: &AppState,
    headers: &HeaderMap,
    method: &str,
    path: &str,
    token: Option<&str>,
    expected_jkt: Option<&str>,
) -> Result<(String, String), Response> {
    let origin = request_origin(headers)?;
    let proof = headers
        .get("dpop")
        .and_then(|value| value.to_str().ok())
        .filter(|value| value.len() <= 8192)
        .ok_or_else(|| refusal("invalid_dpop_proof"))?;
    let now = chrono::Utc::now().timestamp();
    let uri = format!("{}{}", st.resource.trim_end_matches('/'), path);
    let ath = token.map(opensesame_proof::access_token_hash);
    let (claims, jwk, jkt) =
        opensesame_proof::decode_dpop_proof(proof, method, &uri, ath.as_deref(), 300, now)
            .map_err(|_| refusal("invalid_dpop_proof"))?;
    // Browser capability policy is ES256/P-256, even though the shared verifier
    // also supports established non-browser EdDSA/RSA protocol profiles.
    let public = serde_json::to_value(&jwk).map_err(|_| refusal("invalid_dpop_proof"))?;
    if public.get("kty").and_then(serde_json::Value::as_str) != Some("EC")
        || public.get("crv").and_then(serde_json::Value::as_str) != Some("P-256")
        || claims.jti.is_empty()
        || claims.jti.len() > 256
        || expected_jkt.is_some_and(|expected| expected != jkt)
    {
        return Err(refusal("invalid_dpop_proof"));
    }
    let replay_digest =
        opensesame_claims::hash_secret(&format!("browser-proof-v1:{jkt}:{}", claims.jti));
    if !st
        .db
        .claim_browser_proof(&replay_digest, now)
        .await
        .map_err(|_| refusal("proof_store_unavailable"))?
    {
        return Err(refusal("dpop_replay"));
    }
    Ok((origin, jkt))
}
