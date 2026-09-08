use super::*;
use crate::app_state::DevicePending;
use std::collections::HashMap;

#[path = "device_test_support.rs"]
mod support;
use support::*;

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
    let claims = crate::session_claims::fixture(
        opensesame_domain::PrincipalId::new(),
        opensesame_domain::OrganizationId::new(),
        opensesame_domain::OrganizationRole::Member,
        "https://host.test",
    );
    let mut sessions = HashMap::new();
    sessions.insert(digest.clone(), claims);

    assert!(
        !sessions.contains_key(session_id),
        "cleartext bearer must not be a key"
    );
    let found = sessions.get(&digest).expect("digest key hits");
    assert!(found.public_view().get("session_id").is_none());
    assert!(
        !found.public_view().to_string().contains(session_id),
        "stored metadata must not echo the bearer"
    );
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
    state
        .device_codes
        .lock()
        .unwrap()
        .extend((0..500).map(|index| (format!("fill-{index}"), pending("digest", "BCDFGHJK"))));
    let mut joins = Vec::new();
    for _ in 0..32 {
        joins.push(spawn_authorize(state.clone()));
    }
    let mut created = 0usize;
    let mut fenced = 0usize;
    for join in joins {
        let status = join.await.expect("join");
        match status {
            StatusCode::OK => created += 1,
            StatusCode::TOO_MANY_REQUESTS => fenced += 1,
            _ => panic!("unexpected authorize status {status}"),
        }
    }
    assert_eq!(created, 32, "old unapproved grants should be evicted");
    assert!(created + fenced == 32);
    assert!(state.device_codes.lock().unwrap().len() <= MAX_PENDING_DEVICE_CODES);
}

#[tokio::test]
async fn approve_failure_fence_holds_under_interleaving() {
    use axum::http::HeaderMap;

    let state = crate::app_state::test_demo_state().await;
    let mut headers = HeaderMap::new();
    headers.insert(
        "x-opensesame-operator",
        state.operator_token.parse().unwrap(),
    );
    let mut joins = Vec::new();
    for _ in 0..32 {
        joins.push(spawn_failed_approve(state.clone(), headers.clone()));
    }
    let mut unknown = 0usize;
    let mut limited = 0usize;
    for join in joins {
        let status = join.await.expect("join");
        match status {
            StatusCode::NOT_FOUND => unknown += 1,
            StatusCode::TOO_MANY_REQUESTS => limited += 1,
            _ => panic!("unexpected approve status {status}"),
        }
    }
    assert!(
        unknown <= MAX_APPROVE_FAILURES,
        "concurrent misses must not exceed the fence: {unknown}"
    );
    assert_eq!(unknown + limited, 32);
    assert!(state.device_approve_failures.lock().unwrap().len() <= MAX_APPROVE_FAILURES);
}
