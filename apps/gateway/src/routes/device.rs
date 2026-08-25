use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use chrono::{Duration, Utc};
use serde::Deserialize;
use serde_json::json;

use opensesame_claims::{hash_eq, hash_low_entropy, hash_secret};

use crate::app_state::{AppState, ApprovedDevice};
use crate::middleware::auth::{require_demo_bootstrap, require_operator, same_principal_subject};

/// Failed `user_code` guesses tolerated across the whole instance per window.
///
/// A guess cannot be attributed to a particular pending authorization, so the
/// fence has to be global. It is a cooldown rather than an invalidation: a wrong
/// guess must never destroy in-flight device authorizations (that would let any
/// caller cancel every pending login).
const MAX_APPROVE_FAILURES: usize = 10;
const APPROVE_FAILURE_WINDOW_SECS: i64 = 60;
const MAX_PENDING_DEVICE_CODES: usize = 512;
const DEVICE_SCOPE: &str = "opensesame.session";

fn admitted_client(client_id: &str) -> bool {
    matches!(client_id, "opensesame-cli" | "opensesame-pages")
}

/// Drops failures older than the window and reports how many remain.
fn prune_failures(failures: &mut Vec<chrono::DateTime<Utc>>, now: chrono::DateTime<Utc>) -> usize {
    let cutoff = now - Duration::seconds(APPROVE_FAILURE_WINDOW_SECS);
    failures.retain(|at| *at > cutoff);
    failures.len()
}

#[derive(Deserialize)]
pub struct DeviceAuthorizeRequest {
    client_id: String,
    scope: Option<String>,
}

pub async fn authorize(
    State(st): State<AppState>,
    Json(req): Json<DeviceAuthorizeRequest>,
) -> impl IntoResponse {
    if !admitted_client(&req.client_id) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"unauthorized_client"})),
        )
            .into_response();
    }
    let scope = req.scope.unwrap_or_else(|| DEVICE_SCOPE.into());
    if scope != DEVICE_SCOPE {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"invalid_scope"})),
        )
            .into_response();
    }
    let now = Utc::now();
    {
        let mut map = st.device_codes.lock().unwrap();
        map.retain(|_, p| p.expires_at > now);
        if map.len() >= MAX_PENDING_DEVICE_CODES {
            let oldest_unapproved = map
                .iter()
                .filter(|(_, pending)| pending.approved.is_none())
                .min_by_key(|(_, pending)| pending.expires_at)
                .map(|(digest, _)| digest.clone());
            if let Some(digest) = oldest_unapproved {
                map.remove(&digest);
            } else {
                return (
                    StatusCode::TOO_MANY_REQUESTS,
                    Json(json!({"error":"device_code_capacity"})),
                )
                    .into_response();
            }
        }
        let device_code = format!("dc_{}", uuid::Uuid::new_v4());
        let user_code = opensesame_claims::generate_user_code();
        let expires_at = now + Duration::minutes(15);
        let device_digest = hash_secret(&device_code);
        map.insert(
            device_digest.clone(),
            crate::app_state::DevicePending {
                user_code_hash: user_code_digest(&st.claim_pepper, &device_digest, &user_code),
                client_id: req.client_id.clone(),
                scope: scope.clone(),
                expires_at,
                approved: None,
            },
        );
        drop(map);
        Json(json!({
            "device_code": device_code,
            "user_code": user_code,
            "verification_uri": format!("{}/device", st.resource),
            "verification_uri_complete": format!("{}/device?user_code={}", st.resource, user_code),
            "expires_in": 900,
            "interval": 5,
            "client_id": req.client_id,
            "scope": scope
        }))
        .into_response()
    }
}

/// Server-side copy of the session metadata with the bearer swapped for its
/// digest — the token returned to the client is never held at rest.
fn stored_session_meta(meta: &serde_json::Value, session_digest: &str) -> serde_json::Value {
    let mut stored = meta.clone();
    if let Some(obj) = stored.as_object_mut() {
        obj.insert("session_id".into(), json!(session_digest));
    }
    stored
}

#[derive(Deserialize)]
pub struct DeviceTokenRequest {
    device_code: String,
    client_id: String,
    grant_type: String,
}

pub async fn token(State(st): State<AppState>, Json(req): Json<DeviceTokenRequest>) -> Response {
    if req.grant_type != "urn:ietf:params:oauth:grant-type:device_code" {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"unsupported_grant_type"})),
        )
            .into_response();
    }
    // Membership mutations revoke approved grants and live sessions together.
    // Hold the same lifecycle fence until this grant is consumed and its session
    // is published, so revocation cannot slip between those two states.
    let _lifecycle = st.session_lifecycle.lock().unwrap();
    let device_code_hash = hash_secret(&req.device_code);
    let mut map = st.device_codes.lock().unwrap();
    let Some(pending) = map.get_mut(&device_code_hash) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"invalid_grant"})),
        )
            .into_response();
    };
    if pending.client_id != req.client_id {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"invalid_grant"})),
        )
            .into_response();
    }
    if Utc::now() >= pending.expires_at {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"expired_token"})),
        )
            .into_response();
    }
    let Some(approved) = pending.approved.clone() else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"authorization_pending"})),
        )
            .into_response();
    };
    // Identity already supplied the trusted principal, organization, and role.
    // Demo bootstrap metadata is useful in development, but production disables
    // that bootstrap and must still be able to mint this organization session.
    let boot = st.bootstrap.lock().unwrap().clone().filter(|boot| {
        boot.org == approved.organization_id
            && same_principal_subject(&approved.principal, &boot.principal.to_string())
    });
    let session_id = format!("sess_{}", uuid::Uuid::new_v4());
    // The session id *is* the bearer; only its digest is retained server-side.
    let session_digest = hash_secret(&session_id);
    let actor_id = boot.as_ref().map(|boot| boot.actor.to_string());
    let project_id = boot.as_ref().map(|boot| boot.project.to_string());
    let credential_handle = boot
        .as_ref()
        .map(|_| format!("handle_{}", uuid::Uuid::new_v4()));
    // Bind session to the *approved* principal — never the bootstrap demo id alone.
    let meta = json!({
        "session_id": session_id,
        "principal_id": approved.principal.clone(),
        "actor_id": actor_id,
        "issuer": st.issuer,
        "assurance": "mfa",
        "organization_id": approved.organization_id.to_string(),
        "organization_role": approved.organization_role,
        "project_id": project_id,
        "credential_handle": credential_handle,
        "approved_as": approved.principal,
        "client_id": pending.client_id,
        "scope": pending.scope,
        "expires_at": (Utc::now() + Duration::hours(8)).to_rfc3339()
    });
    {
        let mut sessions = st.sessions.lock().unwrap();
        let now = Utc::now();
        sessions.retain(|_, m| {
            m.get("expires_at")
                .and_then(|v| v.as_str())
                .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                .is_some_and(|dt| now < dt.with_timezone(&Utc))
        });
        if sessions.len() >= 1024 {
            return (
                StatusCode::TOO_MANY_REQUESTS,
                Json(json!({"error":"session_capacity"})),
            )
                .into_response();
        }
        sessions.insert(
            session_digest.clone(),
            stored_session_meta(&meta, &session_digest),
        );
    }
    map.remove(&device_code_hash);
    // Never return refresh token bytes — opaque handle only
    (
        StatusCode::OK,
        Json(json!({
            "token_type": "Bearer",
            "expires_in": 28800,
            "session": meta,
            "access_token": format!("opaque-session:{session_id}")
        })),
    )
        .into_response()
}

#[derive(Deserialize)]
pub struct DeviceApproveRequest {
    user_code: String,
    principal: Option<String>,
    organization_id: Option<String>,
    organization_role: Option<opensesame_domain::OrganizationRole>,
}

fn approved_organization(
    organization_id: Option<&str>,
    organization_role: Option<opensesame_domain::OrganizationRole>,
    operator_default: Option<opensesame_domain::OrganizationId>,
) -> Result<
    (
        opensesame_domain::OrganizationId,
        opensesame_domain::OrganizationRole,
    ),
    &'static str,
> {
    match (organization_id, organization_role) {
        (Some(id), Some(role)) => opensesame_domain::OrganizationId::parse(id)
            .map(|id| (id, role))
            .map_err(|_| "invalid_organization_id"),
        (None, None) => operator_default
            .map(|id| (id, opensesame_domain::OrganizationRole::Owner))
            .ok_or("demo_bootstrap_unavailable"),
        _ => Err("organization_claims_incomplete"),
    }
}

/// Keyed, per-device digest of a user code.
fn user_code_digest(pepper: &str, device_digest: &str, user_code: &str) -> String {
    hash_low_entropy(pepper, device_digest, user_code)
}

pub async fn approve(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(req): Json<DeviceApproveRequest>,
) -> Response {
    if let Err(resp) = require_operator(&st, &headers) {
        return resp;
    }
    let now = Utc::now();
    // Hold the failure fence across the guess so concurrent misses cannot all
    // observe count < MAX and then all push.
    let mut failures = st.device_approve_failures.lock().unwrap();
    if prune_failures(&mut failures, now) >= MAX_APPROVE_FAILURES {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(json!({
                "error": "too_many_attempts",
                "retry_after_seconds": APPROVE_FAILURE_WINDOW_SECS,
            })),
        )
            .into_response();
    }

    let mut map = st.device_codes.lock().unwrap();
    map.retain(|_, p| p.expires_at > now);
    // The digest is bound per device code, so the attempt is recomputed for each
    // candidate rather than compared against one global hash.
    for (device_digest, pending) in map.iter_mut() {
        let attempt_hash = user_code_digest(&st.claim_pepper, device_digest, &req.user_code);
        if hash_eq(&attempt_hash, &pending.user_code_hash) {
            drop(failures);
            let operator_default =
                if req.organization_id.is_none() && req.organization_role.is_none() {
                    match require_demo_bootstrap(&st) {
                        Ok(boot) => Some(boot.org),
                        Err(resp) => return resp,
                    }
                } else {
                    None
                };
            let organization = match approved_organization(
                req.organization_id.as_deref(),
                req.organization_role,
                operator_default,
            ) {
                Ok(organization) => organization,
                Err(error) => {
                    return (StatusCode::BAD_REQUEST, Json(json!({"error":error}))).into_response();
                }
            };
            pending.approved = Some(ApprovedDevice {
                principal: req.principal.unwrap_or_else(|| "user:demo".into()),
                organization_id: organization.0,
                organization_role: organization.1,
            });
            return (
                StatusCode::OK,
                Json(json!({
                    "status":"approved",
                    "client_id": pending.client_id,
                    "scope": pending.scope,
                })),
            )
                .into_response();
        }
    }
    // A miss costs the guesser budget, not the pending authorizations.
    // Push while still holding `failures` — a second lock here deadlocks
    // `std::sync::Mutex` and lets concurrent misses all observe count < MAX.
    failures.push(now);
    (
        StatusCode::NOT_FOUND,
        Json(json!({"error":"unknown_user_code"})),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_state::DevicePending;
    use std::collections::HashMap;

    const TEST_PEPPER: &str = "test-pepper";

    fn pending(device_digest: &str, user_code: &str) -> DevicePending {
        DevicePending {
            user_code_hash: user_code_digest(TEST_PEPPER, device_digest, user_code),
            client_id: "opensesame-cli".into(),
            scope: DEVICE_SCOPE.into(),
            expires_at: Utc::now() + Duration::minutes(15),
            approved: None,
        }
    }

    async fn mint_approved(
        state: &AppState,
        device_code: &str,
        principal: String,
        organization_id: opensesame_domain::OrganizationId,
    ) -> serde_json::Value {
        state.device_codes.lock().unwrap().insert(
            hash_secret(device_code),
            DevicePending {
                user_code_hash: "digest".into(),
                client_id: "opensesame-cli".into(),
                scope: DEVICE_SCOPE.into(),
                expires_at: Utc::now() + Duration::minutes(5),
                approved: Some(ApprovedDevice {
                    principal,
                    organization_id,
                    organization_role: opensesame_domain::OrganizationRole::Member,
                }),
            },
        );
        let response = token(
            State(state.clone()),
            Json(DeviceTokenRequest {
                device_code: device_code.into(),
                client_id: "opensesame-cli".into(),
                grant_type: "urn:ietf:params:oauth:grant-type:device_code".into(),
            }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        serde_json::from_slice(&body).unwrap()
    }

    #[test]
    fn authorize_capacity_check_holds_the_map_lock() {
        opensesame_host_core::pact::assert_source_order(
            include_str!("device.rs"),
            &[
                "device_codes.lock()",
                "map.len() >= MAX_PENDING_DEVICE_CODES",
                "map.insert",
            ],
        );
        opensesame_host_core::pact::assert_source_order(
            include_str!("device.rs"),
            &[
                "pub async fn approve",
                "device_approve_failures.lock()",
                "prune_failures",
                "device_codes.lock()",
                "failures.push(now)",
            ],
        );
    }

    #[test]
    fn codes_are_stored_as_digests_only() {
        let device_code = "dc_secret";
        let digest = hash_secret(device_code);
        let mut map: HashMap<String, DevicePending> = HashMap::new();
        map.insert(digest.clone(), pending(&digest, "BCDFGHJK"));

        assert!(!map.contains_key(device_code), "plaintext key must not hit");
        let entry = map.get(&digest).expect("digest key hits");
        assert!(!entry.user_code_hash.contains("BCDFGHJK"));
        assert!(hash_eq(
            &user_code_digest(TEST_PEPPER, &digest, "BCDFGHJK"),
            &entry.user_code_hash
        ));
        assert!(!hash_eq(
            &user_code_digest(TEST_PEPPER, &digest, "BCDFGHJL"),
            &entry.user_code_hash
        ));
        // Keyless SHA-256 over ~2^35 codes is exhaustible; the stored digest is not
        // that, and it is not the same digest another device code would hold.
        assert!(!hash_eq(&hash_secret("BCDFGHJK"), &entry.user_code_hash));
        assert!(!hash_eq(
            &user_code_digest(TEST_PEPPER, "other-device", "BCDFGHJK"),
            &entry.user_code_hash
        ));
    }

    #[tokio::test]
    async fn unknown_clients_and_client_swaps_fail_closed() {
        let state = crate::app_state::test_demo_state().await;
        let unknown = authorize(
            State(state.clone()),
            Json(DeviceAuthorizeRequest {
                client_id: "attacker-client".into(),
                scope: Some(DEVICE_SCOPE.into()),
            }),
        )
        .await
        .into_response();
        assert_eq!(unknown.status(), StatusCode::BAD_REQUEST);
        assert!(state.device_codes.lock().unwrap().is_empty());

        let device_code = "dc_bound";
        state.device_codes.lock().unwrap().insert(
            hash_secret(device_code),
            DevicePending {
                user_code_hash: "digest".into(),
                client_id: "opensesame-cli".into(),
                scope: DEVICE_SCOPE.into(),
                expires_at: Utc::now() + Duration::minutes(5),
                approved: Some(ApprovedDevice {
                    principal: opensesame_domain::PrincipalId::new().to_string(),
                    organization_id: opensesame_domain::OrganizationId::new(),
                    organization_role: opensesame_domain::OrganizationRole::Member,
                }),
            },
        );
        let swapped = token(
            State(state.clone()),
            Json(DeviceTokenRequest {
                device_code: device_code.into(),
                client_id: "opensesame-pages".into(),
                grant_type: "urn:ietf:params:oauth:grant-type:device_code".into(),
            }),
        )
        .await;
        assert_eq!(swapped.status(), StatusCode::BAD_REQUEST);
        assert!(state
            .device_codes
            .lock()
            .unwrap()
            .contains_key(&hash_secret(device_code)));
    }

    #[test]
    fn wrong_guesses_never_invalidate_pending_authorizations() {
        let mut map: HashMap<String, DevicePending> = HashMap::new();
        let digest = hash_secret("dc_1");
        map.insert(digest.clone(), pending(&digest, "BCDF-GHJK"));
        let mut failures: Vec<chrono::DateTime<Utc>> = Vec::new();

        for _ in 0..(MAX_APPROVE_FAILURES * 3) {
            let now = Utc::now();
            map.retain(|_, p| p.expires_at > now);
            failures.push(now);
        }

        let now = Utc::now();
        map.retain(|_, p| p.expires_at > now);
        assert_eq!(map.len(), 1, "guessing must not burn live authorizations");
        // The legitimate code still approves once the cooldown has elapsed.
        let entry = map.values().next().expect("entry");
        assert!(hash_eq(
            &user_code_digest(TEST_PEPPER, &digest, "BCDF-GHJK"),
            &entry.user_code_hash
        ));
    }

    #[test]
    fn session_bearer_is_never_retained() {
        let session_id = "sess_11111111-2222-3333-4444-555555555555";
        let digest = hash_secret(session_id);
        let meta = json!({"session_id": session_id, "approved_as": "prn_abc"});
        let stored = stored_session_meta(&meta, &digest);

        let mut sessions: HashMap<String, serde_json::Value> = HashMap::new();
        sessions.insert(digest.clone(), stored);

        assert!(
            !sessions.contains_key(session_id),
            "cleartext bearer must not be a key"
        );
        let found = sessions.get(&digest).expect("digest key hits");
        assert_eq!(found["session_id"], json!(digest));
        assert!(
            !serde_json::to_string(found).unwrap().contains(session_id),
            "stored metadata must not echo the bearer"
        );
        // The response copy still hands the caller its own token.
        assert_eq!(meta["session_id"], json!(session_id));
    }

    #[test]
    fn failure_window_prunes_and_caps() {
        let now = Utc::now();
        let mut failures: Vec<chrono::DateTime<Utc>> = vec![
            now - Duration::seconds(APPROVE_FAILURE_WINDOW_SECS + 5),
            now - Duration::seconds(APPROVE_FAILURE_WINDOW_SECS + 1),
        ];
        assert_eq!(
            prune_failures(&mut failures, now),
            0,
            "stale failures pruned"
        );

        for _ in 0..MAX_APPROVE_FAILURES {
            failures.push(now);
        }
        assert_eq!(prune_failures(&mut failures, now), MAX_APPROVE_FAILURES);
        assert!(
            prune_failures(&mut failures, now) >= MAX_APPROVE_FAILURES,
            "locked out"
        );

        // Everything ages out after the window.
        let later = now + Duration::seconds(APPROVE_FAILURE_WINDOW_SECS + 1);
        assert_eq!(prune_failures(&mut failures, later), 0);
    }

    #[test]
    fn identity_organization_id_round_trips_into_host_claims() {
        let id = "org:018f4b93-7f20-7b14-8f6d-8f435274ca1f";
        let (organization_id, role) = approved_organization(
            Some(id),
            Some(opensesame_domain::OrganizationRole::Member),
            None,
        )
        .expect("canonical Identity organization id");
        assert_eq!(organization_id.to_string(), id);
        assert_eq!(role, opensesame_domain::OrganizationRole::Member);
        assert_eq!(
            approved_organization(
                Some("org_018f4b93-7f20-7b14-8f6d-8f435274ca1f"),
                Some(opensesame_domain::OrganizationRole::Member),
                None,
            ),
            Err("invalid_organization_id")
        );
    }

    #[tokio::test]
    async fn trusted_organization_session_mints_and_identifies_without_demo_bootstrap() {
        let state = crate::app_state::test_demo_state().await;
        let device_code = "dc_production";
        let organization_id = opensesame_domain::OrganizationId::new();
        let principal = opensesame_domain::PrincipalId::new().to_string();
        state.device_codes.lock().unwrap().insert(
            hash_secret(device_code),
            DevicePending {
                user_code_hash: "digest".into(),
                client_id: "opensesame-cli".into(),
                scope: DEVICE_SCOPE.into(),
                expires_at: Utc::now() + Duration::minutes(5),
                approved: Some(ApprovedDevice {
                    principal: principal.clone(),
                    organization_id,
                    organization_role: opensesame_domain::OrganizationRole::Admin,
                }),
            },
        );
        *state.bootstrap.lock().unwrap() = None;

        let response = token(
            State(state.clone()),
            Json(DeviceTokenRequest {
                device_code: device_code.into(),
                client_id: "opensesame-cli".into(),
                grant_type: "urn:ietf:params:oauth:grant-type:device_code".into(),
            }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert!(body["session"]["actor_id"].is_null());
        assert!(body["session"]["project_id"].is_null());
        assert!(body["session"]["credential_handle"].is_null());

        let mut headers = axum::http::HeaderMap::new();
        headers.insert(
            axum::http::header::AUTHORIZATION,
            format!("Bearer {}", body["access_token"].as_str().unwrap())
                .parse()
                .unwrap(),
        );
        let whoami = crate::routes::session::whoami(State(state), headers).await;
        assert_eq!(whoami.status(), StatusCode::OK);
        let whoami = axum::body::to_bytes(whoami.into_body(), usize::MAX)
            .await
            .unwrap();
        let whoami: serde_json::Value = serde_json::from_slice(&whoami).unwrap();
        assert_eq!(whoami["principal_id"], principal);
        assert_eq!(whoami["organization_id"], organization_id.to_string());
        assert_eq!(whoami["organization_role"], "admin");
    }

    #[tokio::test]
    async fn demo_metadata_only_attaches_to_matching_approved_authority() {
        let state = crate::app_state::test_demo_state().await;
        let bootstrap = state.bootstrap.lock().unwrap().clone().unwrap();
        let identity_principal = format!("prn_{}", bootstrap.principal.as_uuid());

        let matching = mint_approved(
            &state,
            "dc_matching",
            identity_principal.clone(),
            bootstrap.org,
        )
        .await;
        assert_eq!(matching["session"]["actor_id"], bootstrap.actor.to_string());
        assert_eq!(
            matching["session"]["project_id"],
            bootstrap.project.to_string()
        );
        assert!(matching["session"]["credential_handle"].is_string());

        let foreign_org = mint_approved(
            &state,
            "dc_foreign_org",
            identity_principal,
            opensesame_domain::OrganizationId::new(),
        )
        .await;
        assert!(foreign_org["session"]["actor_id"].is_null());
        assert!(foreign_org["session"]["project_id"].is_null());
        assert!(foreign_org["session"]["credential_handle"].is_null());

        let foreign_principal = mint_approved(
            &state,
            "dc_foreign_principal",
            opensesame_domain::PrincipalId::new().to_string(),
            bootstrap.org,
        )
        .await;
        assert!(foreign_principal["session"]["actor_id"].is_null());
        assert!(foreign_principal["session"]["project_id"].is_null());
        assert!(foreign_principal["session"]["credential_handle"].is_null());
    }

    #[tokio::test]
    async fn authorize_capacity_fence_holds_under_interleaving() {
        let state = crate::app_state::test_demo_state().await;
        {
            let mut map = state.device_codes.lock().unwrap();
            for i in 0..500 {
                map.insert(format!("fill-{i}"), pending("digest", "BCDFGHJK"));
            }
        }
        let mut joins = Vec::new();
        for _ in 0..32 {
            let st = state.clone();
            joins.push(tokio::spawn(async move {
                authorize(
                    State(st),
                    Json(DeviceAuthorizeRequest {
                        client_id: "opensesame-cli".into(),
                        scope: None,
                    }),
                )
                .await
                .into_response()
                .status()
            }));
        }
        let mut created = 0usize;
        let mut fenced = 0usize;
        for join in joins {
            let status = join.await.expect("join");
            if status == StatusCode::OK {
                created += 1;
            } else {
                assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
                fenced += 1;
            }
        }
        assert_eq!(created, 32, "old unapproved grants should be evicted");
        assert!(created + fenced == 32);
        assert!(state.device_codes.lock().unwrap().len() <= MAX_PENDING_DEVICE_CODES);
    }

    #[tokio::test]
    async fn approve_failure_fence_holds_under_interleaving() {
        use crate::config::DEV_OPERATOR_TOKEN;
        use axum::http::HeaderMap;

        let state = crate::app_state::test_demo_state().await;
        let mut headers = HeaderMap::new();
        headers.insert("x-opensesame-operator", DEV_OPERATOR_TOKEN.parse().unwrap());
        let mut joins = Vec::new();
        for _ in 0..32 {
            let st = state.clone();
            let h = headers.clone();
            joins.push(tokio::spawn(async move {
                approve(
                    State(st),
                    h,
                    Json(DeviceApproveRequest {
                        user_code: "XXXX-YYYY".into(),
                        principal: None,
                        organization_id: None,
                        organization_role: None,
                    }),
                )
                .await
                .into_response()
                .status()
            }));
        }
        let mut unknown = 0usize;
        let mut limited = 0usize;
        for join in joins {
            let status = join.await.expect("join");
            if status == StatusCode::NOT_FOUND {
                unknown += 1;
            } else {
                assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
                limited += 1;
            }
        }
        assert!(
            unknown <= MAX_APPROVE_FAILURES,
            "concurrent misses must not exceed the fence: {unknown}"
        );
        assert_eq!(unknown + limited, 32);
        assert!(state.device_approve_failures.lock().unwrap().len() <= MAX_APPROVE_FAILURES);
    }
}
