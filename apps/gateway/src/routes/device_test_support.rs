use super::*;

pub(super) const TEST_PEPPER: &str = "test-pepper";

pub(super) fn pending(device_digest: &str, user_code: &str) -> DevicePending {
    DevicePending {
        user_code_hash: user_code_digest(TEST_PEPPER, device_digest, user_code),
        client_id: "opensesame-cli".into(),
        scope: DEVICE_SCOPE.into(),
        expires_at: Utc::now() + Duration::minutes(15),
        approved: None,
    }
}

pub(super) async fn mint_approved(
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

pub(super) fn spawn_authorize(state: AppState) -> tokio::task::JoinHandle<StatusCode> {
    tokio::spawn(async move {
        authorize(
            State(state),
            Json(DeviceAuthorizeRequest {
                client_id: "opensesame-cli".into(),
                scope: None,
            }),
        )
        .await
        .into_response()
        .status()
    })
}

pub(super) fn spawn_failed_approve(
    state: AppState,
    headers: axum::http::HeaderMap,
) -> tokio::task::JoinHandle<StatusCode> {
    tokio::spawn(async move {
        approve(
            State(state),
            headers,
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
    })
}
