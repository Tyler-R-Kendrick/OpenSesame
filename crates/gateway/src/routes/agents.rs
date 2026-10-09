use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use chrono::{Duration, Utc};
use opensesame_claims::{generate_claim_token, hash_eq, hash_secret};
use opensesame_domain::{
    ActorId, ActorInstanceId, ClaimSession, ClaimSessionId, ClaimState, OrganizationId,
    PrincipalId, ProjectId,
};
use serde::Deserialize;
use serde_json::json;

use crate::app_state::AppState;
use crate::middleware::auth::{require_demo_bootstrap, require_operator};

#[derive(Deserialize)]
pub struct AgentIdentityRequest {
    instance_public_key_jwk: serde_json::Value,
    requested_grant_digest: String,
    organization_hint: Option<String>,
    project_hint: Option<String>,
}

pub async fn create_identity(
    State(st): State<AppState>,
    Json(req): Json<AgentIdentityRequest>,
) -> impl IntoResponse {
    // Evict expired claim sessions to bound memory / DoS surface.
    // Lock order: claims then claim_user_code_attempts (must match complete).
    {
        let mut map = st.claims.lock().unwrap();
        let now = Utc::now();
        map.retain(|_, s| s.expires_at > now);
        let mut attempts = st.claim_user_code_attempts.lock().unwrap();
        attempts.retain(|id, _| map.contains_key(id));
        if map.len() >= 256 {
            return (
                StatusCode::TOO_MANY_REQUESTS,
                Json(json!({"error":"claim_capacity","hint":"too many pending agent claims"})),
            )
                .into_response();
        }
    }
    let claim_token = generate_claim_token();
    let user_code = opensesame_claims::generate_user_code();
    let id = ClaimSessionId::new();
    let boot = require_demo_bootstrap(&st).ok();
    let org_hint = req
        .organization_hint
        .as_deref()
        .and_then(|s| OrganizationId::parse(s).ok())
        .or_else(|| boot.as_ref().map(|b| b.org));
    let project_hint = req
        .project_hint
        .as_deref()
        .and_then(|s| ProjectId::parse(s).ok())
        .or_else(|| boot.as_ref().map(|b| b.project));
    let session = ClaimSession {
        id,
        organization_hint: org_hint,
        project_hint,
        actor_id: ActorId::new(),
        actor_instance_id: ActorInstanceId::new(),
        client_id: None,
        operator_id: None,
        instance_public_key_jwk: req.instance_public_key_jwk,
        claim_token_hash: hash_secret(&claim_token),
        user_code_hash: Some(claim_user_code_digest(
            &st.claim_pepper,
            &id.to_string(),
            &user_code,
        )),
        claim_attempt_token_hash: None,
        provider_assertion_digest: None,
        attestation_digest: None,
        requested_grant_digest: req.requested_grant_digest,
        state: ClaimState::Pending,
        created_at: Utc::now(),
        expires_at: Utc::now() + Duration::minutes(15),
        claimed_at: None,
        claimed_by_principal_id: None,
        narrowed_actions: None,
    };
    let claim_id = session.id.to_string();
    st.claims.lock().unwrap().insert(claim_id.clone(), session);
    (
        StatusCode::OK,
        Json(json!({
            "claim_id": claim_id,
            "claim_token": claim_token,
            "user_code": user_code,
            "verification_uri": format!("{}/claim", st.resource),
            "expires_in": 900
        })),
    )
        .into_response()
}

#[derive(Deserialize)]
pub struct ClaimPollRequest {
    claim_token: String,
}

pub async fn poll(
    State(st): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<ClaimPollRequest>,
) -> impl IntoResponse {
    let map = st.claims.lock().unwrap();
    let Some(session) = map.get(&id) else {
        return (StatusCode::NOT_FOUND, Json(json!({"error":"not_found"}))).into_response();
    };
    if Utc::now() >= session.expires_at {
        return (StatusCode::GONE, Json(json!({"error":"expired"}))).into_response();
    }
    if !hash_eq(&hash_secret(&req.claim_token), &session.claim_token_hash) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({"error":"invalid_claim_token"})),
        )
            .into_response();
    }
    Json(json!({"state": session.state, "claim_id": id})).into_response()
}

#[derive(Deserialize)]
pub struct ClaimCompleteRequest {
    claim_token: String,
    /// Code displayed by the device being claimed — the human consent proof.
    user_code: String,
    narrow_actions: Option<Vec<String>>,
    /// The human principal taking ownership, in either the canonical Host
    /// spelling (`principal:<uuid>`) or Identity's `prn_<uuid>` spelling. The
    /// operator-authenticated completer (the Identity plane proxy) names the
    /// principal it authenticated; without it the claim can only bind to the
    /// dev bootstrap principal.
    claimed_by_principal: Option<String>,
}

/// Wrong user codes tolerated per claim before completion is refused outright.
const MAX_CLAIM_USER_CODE_ATTEMPTS: u32 = 5;

/// Outcome of the credential checks guarding claim completion.
#[derive(Debug, PartialEq, Eq)]
enum CompleteGate {
    /// Too many wrong user codes for this claim.
    Locked,
    BadClaimToken,
    /// Claim was minted without a user code — no consent proof is possible.
    NoUserCode,
    BadUserCode,
    Allowed,
}

/// Keyed, per-claim digest of a user code. A user code is ~2^35 possibilities, so
/// a keyless digest of one is recoverable by exhaustion.
fn claim_user_code_digest(pepper: &str, claim_id: &str, user_code: &str) -> String {
    opensesame_claims::hash_low_entropy(pepper, claim_id, user_code)
}

fn complete_gate(
    session: &ClaimSession,
    pepper: &str,
    claim_id: &str,
    claim_token: &str,
    user_code: &str,
    attempts: u32,
) -> CompleteGate {
    if attempts >= MAX_CLAIM_USER_CODE_ATTEMPTS {
        return CompleteGate::Locked;
    }
    if !hash_eq(&hash_secret(claim_token), &session.claim_token_hash) {
        return CompleteGate::BadClaimToken;
    }
    let Some(expected) = session.user_code_hash.as_ref() else {
        return CompleteGate::NoUserCode;
    };
    if !hash_eq(
        &claim_user_code_digest(pepper, claim_id, user_code),
        expected,
    ) {
        return CompleteGate::BadUserCode;
    }
    CompleteGate::Allowed
}

fn resolve_claimant(
    st: &AppState,
    request: &ClaimCompleteRequest,
) -> Result<PrincipalId, Response> {
    let claimant = request
        .claimed_by_principal
        .as_deref()
        .map(|raw| {
            crate::middleware::auth::parse_principal(raw).ok_or_else(|| {
                (
                    StatusCode::BAD_REQUEST,
                    Json(json!({"error":"invalid_principal"})),
                )
                    .into_response()
            })
        })
        .transpose()?;
    if let Some(actions) = &request.narrow_actions {
        let boot = require_demo_bootstrap(st)?;
        if actions
            .iter()
            .any(|action| !boot.grant.actions.iter().any(|parent| parent == action))
        {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(json!({"error":"cannot_widen_grant"})),
            )
                .into_response());
        }
    }
    claimant.map_or_else(|| require_demo_bootstrap(st).map(|boot| boot.principal), Ok)
}

pub async fn complete(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
    Json(req): Json<ClaimCompleteRequest>,
) -> Response {
    // Operator must approve — claim_token alone must not self-complete (agent cannot).
    if let Err(resp) = require_operator(&st, &headers) {
        return resp;
    }
    // Lock order: claims then claim_user_code_attempts (must match create_identity).
    let mut map = st.claims.lock().unwrap();
    let mut attempts = st.claim_user_code_attempts.lock().unwrap();
    let Some(session) = map.get_mut(&id) else {
        return (StatusCode::NOT_FOUND, Json(json!({"error":"not_found"}))).into_response();
    };
    if Utc::now() >= session.expires_at {
        return (StatusCode::GONE, Json(json!({"error":"expired"}))).into_response();
    }
    // The operator token proves *a* human is driving the console; the user code
    // proves they are looking at the device that asked to be claimed.
    let prior = attempts.get(&id).copied().unwrap_or(0);
    match complete_gate(
        session,
        &st.claim_pepper,
        &id,
        &req.claim_token,
        &req.user_code,
        prior,
    ) {
        CompleteGate::Allowed => {
            attempts.remove(&id);
        }
        CompleteGate::Locked => {
            return (
                StatusCode::TOO_MANY_REQUESTS,
                Json(json!({"error":"too_many_attempts"})),
            )
                .into_response();
        }
        CompleteGate::BadClaimToken => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(json!({"error":"invalid_claim_token"})),
            )
                .into_response();
        }
        CompleteGate::NoUserCode => {
            return (
                StatusCode::FORBIDDEN,
                Json(json!({"error":"user_code_unavailable"})),
            )
                .into_response();
        }
        CompleteGate::BadUserCode => {
            *attempts.entry(id.clone()).or_insert(0) += 1;
            return (
                StatusCode::UNAUTHORIZED,
                Json(json!({"error":"invalid_user_code"})),
            )
                .into_response();
        }
    }
    if session.state != ClaimState::Pending {
        return (
            StatusCode::CONFLICT,
            Json(json!({"error":"already_completed_or_invalid"})),
        )
            .into_response();
    }
    // Bind the approving human, not the demo bootstrap identity: the completer
    // (operator-authenticated, e.g. the Identity plane proxy) names the
    // principal it authenticated. A supplied principal it cannot spell is a
    // refusal, never a silent fallback to somebody else.
    let claimant = match resolve_claimant(&st, &req) {
        Ok(claimant) => claimant,
        Err(response) => return response,
    };
    session.state = ClaimState::Claimed;
    session.claimed_at = Some(Utc::now());
    session.claimed_by_principal_id = Some(claimant);
    session.narrowed_actions.clone_from(&req.narrow_actions);
    (
        StatusCode::OK,
        Json(json!({"state":"claimed","principal_id": claimant.to_string()})),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEST_PEPPER: &str = "test-pepper";
    const TEST_CLAIM_ID: &str = "clm_test_1";

    fn session(user_code: Option<&str>, claim_token: &str) -> ClaimSession {
        ClaimSession {
            id: ClaimSessionId::new(),
            organization_hint: None,
            project_hint: None,
            actor_id: ActorId::new(),
            actor_instance_id: ActorInstanceId::new(),
            client_id: None,
            operator_id: None,
            instance_public_key_jwk: json!({}),
            claim_token_hash: hash_secret(claim_token),
            user_code_hash: user_code
                .map(|c| claim_user_code_digest(TEST_PEPPER, TEST_CLAIM_ID, c)),
            claim_attempt_token_hash: None,
            provider_assertion_digest: None,
            attestation_digest: None,
            requested_grant_digest: "sha256:test".into(),
            state: ClaimState::Pending,
            created_at: Utc::now(),
            expires_at: Utc::now() + Duration::minutes(15),
            claimed_at: None,
            claimed_by_principal_id: None,
            narrowed_actions: None,
        }
    }

    #[test]
    fn operator_plus_claim_token_is_not_enough_without_the_user_code() {
        let s = session(Some("ABCD-1234"), "tok");
        assert_eq!(
            complete_gate(&s, TEST_PEPPER, TEST_CLAIM_ID, "tok", "WRON-GXXX", 0),
            CompleteGate::BadUserCode
        );
        assert_eq!(
            complete_gate(&s, TEST_PEPPER, TEST_CLAIM_ID, "tok", "ABCD-1234", 0),
            CompleteGate::Allowed
        );
    }

    #[test]
    fn wrong_claim_token_is_refused_before_the_user_code_is_examined() {
        let s = session(Some("ABCD-1234"), "tok");
        assert_eq!(
            complete_gate(&s, TEST_PEPPER, TEST_CLAIM_ID, "other", "ABCD-1234", 0),
            CompleteGate::BadClaimToken
        );
    }

    #[test]
    fn guessing_the_user_code_locks_the_claim() {
        let s = session(Some("ABCD-1234"), "tok");
        assert_eq!(
            complete_gate(
                &s,
                TEST_PEPPER,
                TEST_CLAIM_ID,
                "tok",
                "ABCD-1234",
                MAX_CLAIM_USER_CODE_ATTEMPTS
            ),
            CompleteGate::Locked
        );
    }

    #[test]
    fn a_user_code_digest_is_useless_against_another_claim() {
        let s = session(Some("ABCD-1234"), "tok");
        // Same code, different claim: the digest must not carry over, so one
        // recovered code says nothing about any other claim.
        assert_eq!(
            complete_gate(&s, TEST_PEPPER, "clm_other", "tok", "ABCD-1234", 0),
            CompleteGate::BadUserCode
        );
        // And a keyless digest of the same code is not what is stored.
        assert!(!hash_eq(
            &hash_secret("ABCD-1234"),
            s.user_code_hash.as_deref().expect("hash")
        ));
    }

    #[test]
    fn a_claim_without_a_user_code_cannot_be_completed() {
        let s = session(None, "tok");
        assert_eq!(
            complete_gate(&s, TEST_PEPPER, TEST_CLAIM_ID, "tok", "", 0),
            CompleteGate::NoUserCode
        );
    }

    #[test]
    fn a_claimant_binds_in_either_principal_spelling_and_garbage_is_refused() {
        use crate::middleware::auth::parse_principal;
        let canonical = PrincipalId::new();
        let identity_spelling = format!("prn_{}", canonical.as_uuid());
        assert_eq!(parse_principal(&identity_spelling), Some(canonical));
        assert_eq!(parse_principal(&canonical.to_string()), Some(canonical));
        assert!(parse_principal("user@example.com").is_none());
    }

    #[tokio::test]
    async fn complete_without_operator_fails_closed() {
        let state = crate::app_state::test_demo_state().await;
        let response = complete(
            State(state),
            axum::http::HeaderMap::new(),
            Path("missing".into()),
            Json(ClaimCompleteRequest {
                claim_token: "tok".into(),
                user_code: "ABCD-1234".into(),
                narrow_actions: None,
                claimed_by_principal: None,
            }),
        )
        .await;
        assert!(
            response.status() == StatusCode::UNAUTHORIZED
                || response.status() == StatusCode::SERVICE_UNAVAILABLE,
            "got {}",
            response.status()
        );
    }
}
