use opensesame_storage::{
    browser_pairing::NewBrowserPairing, host_authorizations::HostAuthorization, Db,
    ObservationControlUpdate, StoredObservationRun,
};

async fn seed(db: &Db) -> (HostAuthorization, ObservationControlUpdate) {
    db.create_browser_pairing(&NewBrowserPairing {
        id: "client",
        device_digest: "device",
        user_code_digest: "code",
        origin: "https://vault.example",
        dpop_jkt: "key",
        audience: "https://host.example",
        capabilities_json: "[\"host.sync.read\"]",
        now: 1000,
    })
    .await
    .unwrap();
    db.decide_browser_pairing("code", "owner", "org", true, 1000)
        .await
        .unwrap();
    db.consume_browser_pairing("device", "https://vault.example", "key", "token", 1001)
        .await
        .unwrap()
        .unwrap();
    let run = StoredObservationRun {
        id: "run".into(),
        organization_id: "org".into(),
        job_id: "job".into(),
        target_origin: "https://example.test".into(),
        tier: "t4".into(),
        control_state: "awaiting_human".into(),
        quiescence: "quiescent".into(),
        handoff_queued: false,
        lease_holder: None,
        lease_expires_at: None,
        owner_principal_id: "owner".into(),
        viewer_key_id: "viewer".into(),
        next_seq: 0,
        blocked_reason: None,
        expires_at: "2026-09-09T00:00:00Z".into(),
        closed_at: None,
        version: 1,
        created_at: "2026-09-08T00:00:00Z".into(),
        updated_at: "2026-09-08T00:00:00Z".into(),
    };
    db.create_observation_run(&run).await.unwrap();
    let pending = HostAuthorization {
        id: "challenge".into(),
        client_id: "client".into(),
        digest: "digest".into(),
        operation: "agent.browser.control".into(),
        target_id: "run".into(),
        transition: Some("take".into()),
        run_version: Some(1),
        expires_at: 1200,
    };
    assert!(db.create_host_authorization(&pending, 1002).await.unwrap());
    let update = ObservationControlUpdate {
        run_id: "run".into(),
        organization_id: "org".into(),
        expected_version: 1,
        control_state: "human_driving".into(),
        quiescence: "quiescent".into(),
        handoff_queued: false,
        lease_holder: Some("owner".into()),
        lease_expires_at: Some("2026-09-08T00:05:00Z".into()),
        blocked_reason: None,
    };
    (pending, update)
}

#[tokio::test]
async fn exact_run_transition_client_and_version_bind_one_atomic_effect_across_replicas() {
    let path = std::env::temp_dir().join(format!("host-elevation-{}.sqlite", uuid::Uuid::new_v4()));
    let url = format!("sqlite:{}?mode=rwc", path.display());
    let first = Db::connect_sqlite(&url).await.unwrap();
    let (pending, mut update) = seed(&first).await;
    assert!(first
        .authorize_host_challenge(&pending, "jti", None, Some("elevation"), 1003)
        .await
        .unwrap());
    assert!(!first
        .authorize_host_challenge(&pending, "other-jti", None, Some("other"), 1003)
        .await
        .unwrap());
    for (client, token, transition) in [
        ("other", "elevation", "take"),
        ("client", "copied", "take"),
        ("client", "elevation", "release"),
    ] {
        assert!(!first
            .control_with_host_authorization(client, token, transition, &update, 1004)
            .await
            .unwrap());
    }
    update.run_id = "other".into();
    assert!(!first
        .control_with_host_authorization("client", "elevation", "take", &update, 1004)
        .await
        .unwrap());
    update.run_id = "run".into();
    update.expected_version = 2;
    assert!(!first
        .control_with_host_authorization("client", "elevation", "take", &update, 1004)
        .await
        .unwrap());
    update.expected_version = 1;
    let second = Db::connect_sqlite(&url).await.unwrap();
    let (a, b) = tokio::join!(
        first.control_with_host_authorization("client", "elevation", "take", &update, 1004),
        second.control_with_host_authorization("client", "elevation", "take", &update, 1004)
    );
    assert_eq!(usize::from(a.unwrap()) + usize::from(b.unwrap()), 1);
    assert_eq!(
        first
            .get_observation_run("org", "run")
            .await
            .unwrap()
            .unwrap()
            .version,
        2
    );
    drop(first);
    drop(second);
    let restarted = Db::connect_sqlite(&url).await.unwrap();
    assert!(!restarted
        .control_with_host_authorization("client", "elevation", "take", &update, 1005)
        .await
        .unwrap());
    drop(restarted);
    std::fs::remove_file(path).unwrap();
}

#[tokio::test]
async fn revocation_expiry_and_effect_failure_never_leave_partial_authority() {
    let db = Db::connect_memory().await.unwrap();
    let (pending, update) = seed(&db).await;
    assert!(db
        .authorize_host_challenge(&pending, "jti", None, Some("elevation"), 1003)
        .await
        .unwrap());
    sqlx::query("CREATE TRIGGER reject_control BEFORE UPDATE ON observation_runs BEGIN SELECT RAISE(ABORT,'test failure'); END")
        .execute(db.pool()).await.unwrap();
    assert!(db
        .control_with_host_authorization("client", "elevation", "take", &update, 1004)
        .await
        .is_err());
    sqlx::query("DROP TRIGGER reject_control")
        .execute(db.pool())
        .await
        .unwrap();
    assert!(!db
        .control_with_host_authorization("client", "elevation", "take", &update, 1200)
        .await
        .unwrap());
    db.revoke_browser_client("client", "owner", "org", 1005)
        .await
        .unwrap();
    assert!(!db
        .control_with_host_authorization("client", "elevation", "take", &update, 1006)
        .await
        .unwrap());
    assert_eq!(
        db.get_observation_run("org", "run")
            .await
            .unwrap()
            .unwrap()
            .version,
        1
    );
}
