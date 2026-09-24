//! EST (RFC 7030) enrollment endpoints, profile-scoped (ADR 0068 §4, §8).
//!
//! Protocol endpoints, deliberately session-free: none of the `.well-known`
//! routes calls `resolve_caller`. Each authenticates with EST's own mechanism —
//! the profile's sealed bootstrap passphrase (HTTP Basic, RFC 7030 §4.2.2) or
//! a verified TLS client certificate (bootstrap at first enrollment, or the
//! certificate being replaced at re-enrollment) — and each is scoped to
//! exactly one profile by its path. Enrollment endpoints are spoken by
//! protocol clients, never by agents, and are excluded from every agent
//! surface in the capability registry.
//!
//! The trust boundary, stated once: a policy-violating CSR is refused whole
//! (`policy_denied`), never narrowed. The issuing key leaves sealed custody
//! only inside the signer this handler borrows. Everything the response
//! carries is public material — RFC 7030 moves it in `certs-only` PKCS#7
//! precisely because it is public.
//!
//! Routes (via [`routes`], allowlisted in `contract.rs`):
//!
//! - `GET /{profileId}/cacerts` — the profile CA's chain as `certs-only`.
//! - `POST /{profileId}/simpleenroll` — PKCS#10 in, issued chain out.
//! - `POST /{profileId}/simplereenroll` — same, plus "the certificate being
//!   replaced" as a first-class credential.
//!
//! Plus the operator surface that configures a profile's EST settings:
//! `GET|PUT /api/v1/certmgr/profiles/{id}/est-config`, session-authenticated
//! like every certmgr route (the one place `resolve_caller` runs).

use axum::extract::{DefaultBodyLimit, Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{body::Bytes, Json, Router};
use opensesame_connection_broker::crypto::seal_scoped;
use opensesame_pki_core::types::ProfileDefaults;
use opensesame_pki_core::PolicyRules;
use opensesame_storage::seal_scopes;
use opensesame_storage::{SealedCertificateMaterial, StoredCertificateProfile, StoredEstConfig};
use opensesame_transport_security::PeerExtension;
use serde::Deserialize;
use serde_json::json;

use super::est_enrollment;
use super::est_records::{enrollment_error, p7_response, record_issued};
use super::est_wire::{authenticate, ca_chain_pem, decode_csr_body, load_issuer, load_profile};
use crate::app_state::AppState;
use crate::middleware::auth::{resolve_caller, resolve_caller_organization};

/// Largest accepted CSR body (RFC 7030 bodies are base64 on the wire).
pub const MAX_CSR_BODY: usize = 384 * 1024;
/// The sealing key id every EST secret is sealed under.
pub(super) const KEY_ID: &str = "opensesame-connection-key:v1";

/// EST protocol + operator config routes. Profile-scoped, session-free on the
/// `.well-known` surface; the body limit is room for a PKCS#10 request with a
/// long chain encoded per RFC 7030 and nothing more.
pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/.well-known/est/{profile_id}/cacerts", get(cacerts))
        .route(
            "/.well-known/est/{profile_id}/simpleenroll",
            post(simple_enroll).layer(DefaultBodyLimit::max(MAX_CSR_BODY)),
        )
        .route(
            "/.well-known/est/{profile_id}/simplereenroll",
            post(simple_reenroll).layer(DefaultBodyLimit::max(MAX_CSR_BODY)),
        )
        .route(
            "/api/v1/certmgr/profiles/{id}/est-config",
            get(get_config)
                .put(put_config)
                .layer(DefaultBodyLimit::max(MAX_CSR_BODY)),
        )
}

// —— shared gates and error shapes ————————————————————————————————————

pub(super) fn internal(error: impl std::fmt::Display, context: &'static str) -> Response {
    tracing::error!(%error, %context, "est operation failed");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({"error":"internal","hint":"est operation failed"})),
    )
        .into_response()
}

pub(super) fn refuse(status: StatusCode, error: &'static str, hint: &'static str) -> Response {
    (status, Json(json!({"error": error, "hint": hint}))).into_response()
}

pub(super) fn sealing_key(st: &AppState) -> Result<[u8; 32], Response> {
    st.connection_broker.config().key().copied().ok_or_else(|| {
        refuse(
            StatusCode::SERVICE_UNAVAILABLE,
            "sealing_unavailable",
            "no host sealing key is configured",
        )
    })
}

/// The operator gate: owner/admin, then the profile, scoped to the caller's
/// organization. Every admin route runs this before touching `st.db`.
pub(crate) async fn authorized_profile(
    st: &AppState,
    headers: &HeaderMap,
    profile_id: &str,
) -> Result<(String, StoredCertificateProfile), Response> {
    let who = resolve_caller(st, headers)?;
    if !who.can_configure_integrations() {
        return Err(refuse(
            StatusCode::FORBIDDEN,
            "forbidden",
            "owner or admin role required to manage enrollment configuration",
        ));
    }
    let organization = resolve_caller_organization(st, &who, headers)?.to_string();
    let profile = st
        .db
        .get_certificate_profile(&organization, profile_id)
        .await
        .map_err(|error| internal(error, "read profile"))?
        .ok_or_else(|| {
            refuse(
                StatusCode::NOT_FOUND,
                "unknown_profile",
                "no such certificate profile",
            )
        })?;
    Ok((organization, profile))
}

// —— operator surface: the profile's EST configuration ————————————————

/// The operator's EST configuration document. Unknown fields are refused.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EstConfigBody {
    /// Bootstrap passphrase (sealed at rest under `est_passphrase`).
    pub passphrase: Option<String>,
    /// Operator-uploaded bootstrap CA chain (PEM) whose client certificates
    /// may enroll. The EST listener's `client_trust` should name the same
    /// chain: chain validation happens at the handshake, and the enrollment
    /// layer pins which trust profile counts.
    pub bootstrap_chain_pem: Option<String>,
    /// When true a client certificate is mandatory: the passphrase alone must
    /// never enroll.
    #[serde(default)]
    pub require_bootstrap: bool,
}

/// Reads the profile's EST configuration (secret material redacted).
pub async fn get_config(
    State(st): State<AppState>,
    headers: HeaderMap,
    Path(profile_id): Path<String>,
) -> Response {
    let (organization, _profile) = match authorized_profile(&st, &headers, &profile_id).await {
        Ok(found) => found,
        Err(response) => return response,
    };
    match st.db.get_est_config(&organization, &profile_id).await {
        Ok(Some(config)) => Json(json!({
            "profile_id": config.profile_id,
            "passphrase_set": config.sealed_passphrase.is_some(),
            "bootstrap_chain_set": config.bootstrap_chain_pem.is_some(),
            "require_bootstrap": config.require_bootstrap,
            "version": config.version,
        }))
        .into_response(),
        Ok(None) => Json(json!({
            "profile_id": profile_id,
            "passphrase_set": false,
            "bootstrap_chain_set": false,
            "require_bootstrap": false,
            "version": 0
        }))
        .into_response(),
        Err(error) => internal(error, "read est config"),
    }
}

/// Writes the profile's EST configuration. The passphrase is sealed here and
/// never returned.
pub async fn put_config(
    State(st): State<AppState>,
    headers: HeaderMap,
    Path(profile_id): Path<String>,
    Json(body): Json<EstConfigBody>,
) -> Response {
    let (organization, _profile) = match authorized_profile(&st, &headers, &profile_id).await {
        Ok(found) => found,
        Err(response) => return response,
    };
    if let Some(chain) = &body.bootstrap_chain_pem {
        if opensesame_pki_core::bundle::certificates_der(chain).is_err() {
            return refuse(
                StatusCode::BAD_REQUEST,
                "invalid_bootstrap_chain",
                "bootstrap_chain_pem must be a PEM certificate bundle",
            );
        }
    }
    let sealing = match sealing_key(&st) {
        Ok(key) => key,
        Err(response) => return response,
    };
    let existing = match st.db.get_est_config(&organization, &profile_id).await {
        Ok(found) => found,
        Err(error) => return internal(error, "read est config"),
    };
    let id = existing.as_ref().map_or_else(
        || format!("est-config:{profile_id}"),
        |config| config.id.clone(),
    );
    let sealed_passphrase = match body.passphrase.as_deref() {
        Some(passphrase) => {
            let blob = match seal_scoped(
                &sealing,
                seal_scopes::EST_PASSPHRASE,
                &id,
                &organization,
                passphrase.as_bytes(),
            ) {
                Ok(blob) => blob,
                Err(error) => return internal(error, "seal est passphrase"),
            };
            Some(SealedCertificateMaterial {
                key_id: KEY_ID.into(),
                ciphertext: blob.ciphertext,
                nonce: blob.nonce,
                aad_digest: blob.aad_digest,
            })
        }
        None => existing
            .as_ref()
            .and_then(|config| config.sealed_passphrase.clone()),
    };
    let now = chrono::Utc::now().to_rfc3339();
    let config = StoredEstConfig {
        id,
        organization_id: organization,
        profile_id,
        sealed_passphrase,
        bootstrap_chain_pem: body.bootstrap_chain_pem.clone().or_else(|| {
            existing
                .as_ref()
                .and_then(|config| config.bootstrap_chain_pem.clone())
        }),
        require_bootstrap: body.require_bootstrap,
        version: existing.as_ref().map_or(1, |config| config.version),
        created_at: existing
            .as_ref()
            .map_or_else(|| now.clone(), |config| config.created_at.clone()),
        updated_at: now,
    };
    let written = if existing.is_some() {
        st.db.update_est_config(&config).await
    } else {
        st.db.insert_est_config(&config).await.map(|()| true)
    };
    match written {
        Ok(true) => Json(json!({"profile_id": config.profile_id, "written": true})).into_response(),
        Ok(false) => refuse(
            StatusCode::CONFLICT,
            "version_conflict",
            "the est configuration changed since it was read",
        ),
        Err(error) => internal(error, "write est config"),
    }
}

#[cfg(test)]
#[path = "est_server_tests.rs"]
mod tests;

// —— protocol endpoints (RFC 7030) ————————————————————————————————————

/// `GET /.well-known/est/{profileId}/cacerts` — the profile CA's chain as a
/// PKCS#7 `certs-only` object (RFC 7030 §4.1). Unauthenticated by design: it
/// carries only what a trust distribution point publishes.
pub async fn cacerts(State(st): State<AppState>, Path(profile_id): Path<String>) -> Response {
    let (profile, _config) = match load_profile(&st, &profile_id).await {
        Ok(found) => found,
        Err(response) => return response,
    };
    let chain = match ca_chain_pem(&st, &profile).await {
        Ok(chain) => chain,
        Err(response) => return response,
    };
    match est_enrollment::chain_p7(&chain) {
        Ok(p7) => p7_response(p7),
        Err(error) => enrollment_error(error),
    }
}

/// `POST /.well-known/est/{profileId}/simpleenroll` (RFC 7030 §4.2).
pub async fn simple_enroll(
    State(st): State<AppState>,
    Path(profile_id): Path<String>,
    headers: HeaderMap,
    peer: Option<axum::Extension<PeerExtension>>,
    body: Bytes,
) -> Response {
    enroll(&st, &profile_id, &headers, peer, body, false).await
}

/// `POST /.well-known/est/{profileId}/simplereenroll` — like `simpleenroll`,
/// but the certificate being replaced is itself a first-class credential
/// (ADR 0068 §4).
pub async fn simple_reenroll(
    State(st): State<AppState>,
    Path(profile_id): Path<String>,
    headers: HeaderMap,
    peer: Option<axum::Extension<PeerExtension>>,
    body: Bytes,
) -> Response {
    enroll(&st, &profile_id, &headers, peer, body, true).await
}

async fn enroll(
    st: &AppState,
    profile_id: &str,
    headers: &HeaderMap,
    peer: Option<axum::Extension<PeerExtension>>,
    body: Bytes,
    reenroll: bool,
) -> Response {
    let (profile, config) = match load_profile(st, profile_id).await {
        Ok(found) => found,
        Err(response) => return response,
    };
    let peer = peer.map(|axum::Extension(peer)| peer);
    if let Err(response) =
        authenticate(st, headers, peer.as_ref(), &config, &profile, reenroll).await
    {
        return response;
    }
    let csr_der = match decode_csr_body(&body) {
        Ok(der) => der,
        Err(response) => return response,
    };
    let Ok(facts) = opensesame_pki_core::csr::parse_csr_der(&csr_der) else {
        return refuse(
            StatusCode::BAD_REQUEST,
            "csr_invalid",
            "the PKCS#10 request is malformed or fails proof of possession",
        );
    };
    let policy = match st
        .db
        .get_certificate_policy(&profile.organization_id, &profile.policy_id)
        .await
    {
        Ok(Some(policy)) => policy,
        Ok(None) => {
            return refuse(
                StatusCode::SERVICE_UNAVAILABLE,
                "policy_unavailable",
                "the profile's policy is gone; nothing is issued",
            )
        }
        Err(error) => return internal(error, "read policy"),
    };
    let rules: PolicyRules = match serde_json::from_str(&policy.rules_json) {
        Ok(rules) => rules,
        Err(error) => return internal(error, "decode policy"),
    };
    let defaults: ProfileDefaults =
        serde_json::from_str(&profile.defaults_json).unwrap_or_default();
    let mut request = est_enrollment::candidate(&facts, &defaults, None);
    if request.key_usages.is_empty() {
        let (keys, extended, constraints) = est_enrollment::client_auth_usages();
        request.key_usages = keys;
        request.ext_key_usages = extended;
        request.basic_constraints = constraints;
    }
    if let Err(error) = est_enrollment::decide(&rules, policy.max_validity_seconds, &request) {
        return enrollment_error(error);
    }
    let (issuer_pem, issuer_key) = match load_issuer(st, &profile).await {
        Ok(material) => material,
        Err(response) => return response,
    };
    let issued = match est_enrollment::issue(&issuer_pem, &issuer_key, &csr_der, &request) {
        Ok(issued) => issued,
        Err(error) => return enrollment_error(error),
    };
    let common_name = facts.subject.cn.clone().unwrap_or_default();
    let san_json = serde_json::to_string(&facts.sans).unwrap_or_else(|_| "[]".into());
    if let Err(error) = record_issued(st, &profile, &issued, &common_name, san_json).await {
        return internal(error, "record enrolled certificate");
    }
    match est_enrollment::response_p7(&issued) {
        Ok(p7) => p7_response(p7),
        Err(error) => enrollment_error(error),
    }
}
