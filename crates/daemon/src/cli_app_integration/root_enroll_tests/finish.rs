use super::*;

#[tokio::test]
async fn finish_origin_does_not_burn_the_session() {
    let dir = tempfile::tempdir().unwrap();
    let (app, _) = router_at(Some(dir.path()));
    let started = begin(&app).await;
    let spki = root_spki_der(&generate_root_signing_key());
    let (message, confirm) = honest(&started, &spki);
    let body = proof(&started, &spki, confirm.client_confirm(), &message);
    let blocked = app
        .clone()
        .oneshot(finish_request(body.clone(), true))
        .await
        .unwrap();
    let (status, parsed, _) = read_json(blocked).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(parsed["error"], "origin_forbidden");
    let response = app.oneshot(finish_request(body, false)).await.unwrap();
    let (status, parsed, _) = read_json(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(parsed["enrollmentEpoch"], 1);
}

#[tokio::test]
async fn finish_without_enroll_entry_header_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let (app, _) = router_at(Some(dir.path()));
    let started = begin(&app).await;
    let spki = root_spki_der(&generate_root_signing_key());
    let (message, confirm) = honest(&started, &spki);
    let body = proof(&started, &spki, confirm.client_confirm(), &message);
    let builder = Request::builder()
        .method("POST")
        .uri(ROOT_ENROLL_FINISH_PATH)
        .header("content-type", "application/json");
    let refused = app
        .oneshot(builder.body(Body::from(body)).unwrap())
        .await
        .unwrap();
    let (status, parsed, _) = read_json(refused).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(parsed["error"], "root_enroll_refused");
}

#[tokio::test]
async fn malformed_finish_can_be_retried_and_unknown_id_is_not_found() {
    let dir = tempfile::tempdir().unwrap();
    let (app, state) = router_at(Some(dir.path()));
    let started = begin(&app).await;
    let spki = root_spki_der(&generate_root_signing_key());
    let (message, confirm) = honest(&started, &spki);
    let confirm_bytes = confirm.client_confirm().to_vec();
    let empty = app
        .clone()
        .oneshot(finish_request(String::new(), false))
        .await
        .unwrap();
    let (status, parsed, _) = read_json(empty).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(parsed["error"], "root_enroll_refused");

    let mut bad = serde_json::json!({
        "sessionId": started.session_id,
        "messageB64": "!!!",
        "confirmB64": b64(&confirm_bytes),
        "rootPublicKeySpkiB64": b64(&spki),
    });
    let refused = app
        .clone()
        .oneshot(finish_request(bad.to_string(), false))
        .await
        .unwrap();
    let (status, parsed, _) = read_json(refused).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(parsed["error"], "root_enroll_refused");

    bad["sessionId"] = serde_json::Value::String("ab".repeat(16));
    bad["messageB64"] = serde_json::Value::String(b64(&message));
    let unknown = app
        .clone()
        .oneshot(finish_request(bad.to_string(), false))
        .await
        .unwrap();
    let (status, parsed, _) = read_json(unknown).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(parsed["error"], "root_enroll_unknown");

    let ok = app
        .oneshot(finish_request(
            proof(&started, &spki, &confirm_bytes, &message),
            false,
        ))
        .await
        .unwrap();
    assert_eq!(ok.status(), StatusCode::OK);
    assert!(state
        .cli_app_integration
        .lock()
        .unwrap()
        .pairings
        .is_root_key_enrolled());
}

#[tokio::test]
async fn wrong_confirm_does_not_write_the_store() {
    let dir = tempfile::tempdir().unwrap();
    let (app, state) = router_at(Some(dir.path()));
    let started = begin(&app).await;
    let spki = root_spki_der(&generate_root_signing_key());
    let (message, confirm) = honest(&started, &spki);
    let mut bad = confirm.client_confirm().to_vec();
    bad[0] ^= 0xff;
    let response = app
        .oneshot(finish_request(
            proof(&started, &spki, &bad, &message),
            false,
        ))
        .await
        .unwrap();
    let (status, parsed, _) = read_json(response).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(parsed["error"], "root_enroll_refused");
    assert!(!dir
        .path()
        .join("cli-app-integration/root-trust.osseal")
        .exists());
    assert!(!state
        .cli_app_integration
        .lock()
        .unwrap()
        .pairings
        .is_root_key_enrolled());
}

#[tokio::test]
async fn a_second_enrollment_increments_the_epoch() {
    let dir = tempfile::tempdir().unwrap();
    let (app, _) = router_at(Some(dir.path()));
    for epoch in [1_u64, 2] {
        let started = begin(&app).await;
        let spki = root_spki_der(&generate_root_signing_key());
        let (message, confirm) = honest(&started, &spki);
        let response = app
            .clone()
            .oneshot(finish_request(
                proof(&started, &spki, confirm.client_confirm(), &message),
                false,
            ))
            .await
            .unwrap();
        let (status, parsed, _) = read_json(response).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(parsed["enrollmentEpoch"], epoch);
    }
    let reloaded = super::open_store(Some(dir.path()));
    assert_eq!(
        reloaded
            .lock()
            .unwrap()
            .pairings
            .root_trust()
            .unwrap()
            .enrollment_epoch(),
        2
    );
}

#[tokio::test]
async fn epoch_exhaustion_is_a_conflict_and_keeps_the_session() {
    let dir = tempfile::tempdir().unwrap();
    let stored = RootTrustRecord::new(fingerprint_of_spki(&[9u8; 8]), u64::MAX).unwrap();
    super::root_trust::save(dir.path(), &stored).unwrap();
    let mut state = crate::test_fixtures::test_state("http://127.0.0.1:8787");
    state.cli_app_integration = super::open_store(Some(dir.path()));
    state.cli_root_trust_dir = Some(dir.path().to_path_buf());
    let app = crate::router(state.clone());
    let started = begin(&app).await;
    let spki = root_spki_der(&generate_root_signing_key());
    let (message, confirm) = honest(&started, &spki);
    let body = proof(&started, &spki, confirm.client_confirm(), &message);
    let response = app
        .clone()
        .oneshot(finish_request(body.clone(), false))
        .await
        .unwrap();
    let (status, parsed, _) = read_json(response).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(parsed["error"], "root_enroll_epoch_exhausted");
    state
        .cli_app_integration
        .lock()
        .unwrap()
        .pairings
        .mark_root_key_enrolled(RootTrustRecord::new(fingerprint_of_spki(&spki), 3).unwrap());
    let response = app.oneshot(finish_request(body, false)).await.unwrap();
    let (status, parsed, _) = read_json(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(parsed["enrollmentEpoch"], 4);
}

#[tokio::test]
async fn oversized_body_is_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let (app, _) = router_at(Some(dir.path()));
    let response = app
        .oneshot(finish_request("x".repeat(3000), false))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
}
