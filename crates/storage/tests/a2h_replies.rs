use opensesame_storage::{
    a2h_replies::{ReplyDecision, ReplyOutcome},
    Db, StoredObservationRun,
};

const NOW: &str = "2026-09-08T00:00:00+00:00";
const DIGEST: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

async fn seed(db: &Db) {
    sqlx::query(r#"INSERT INTO security_hooks(id,organization_id,name,event_types_json,delivery,responder,created_at,updated_at)
        VALUES('hook','org','test','["agent.*"]','internal','test',?,?)"#)
        .bind(NOW).bind(NOW).execute(db.pool()).await.unwrap();
    sqlx::query("INSERT INTO security_deliveries(id,organization_id,hook_id,event_type,subject_kind,subject_id,payload_json,state,created_at,updated_at)
        VALUES('reply','org','hook','agent.run.blocked','web_login','opaque','{}','delivered',?,?)")
        .bind(NOW).bind(NOW).execute(db.pool()).await.unwrap();
    db.create_observation_run(&StoredObservationRun {
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
        owner_principal_id: "principal:owner".into(),
        viewer_key_id: "viewer".into(),
        next_seq: 0,
        blocked_reason: None,
        expires_at: "2026-09-09T00:00:00+00:00".into(),
        closed_at: None,
        version: 1,
        created_at: NOW.into(),
        updated_at: NOW.into(),
    })
    .await
    .unwrap();
}

async fn cancel(db: &Db) -> anyhow::Result<ReplyOutcome> {
    db.apply_a2h_reply(
        "reply",
        "org",
        DIGEST,
        ReplyDecision::Cancel {
            run_id: "run",
            owner: "principal:owner",
            valid_until: chrono::DateTime::parse_from_rfc3339("2026-09-09T00:00:00+00:00")
                .unwrap()
                .timestamp(),
        },
        NOW,
    )
    .await
}

#[tokio::test]
async fn replicas_and_restart_apply_one_effect_not_outbound_delivery_state() {
    let path = std::env::temp_dir().join(format!("opensesame-a2h-{}.sqlite", uuid::Uuid::new_v4()));
    let url = format!("sqlite:{}?mode=rwc", path.display());
    let first = Db::connect_sqlite(&url).await.unwrap();
    seed(&first).await;
    let second = Db::connect_sqlite(&url).await.unwrap();
    let (a, b) = tokio::join!(cancel(&first), cancel(&second));
    let outcomes = [a.unwrap(), b.unwrap()];
    assert_eq!(
        outcomes
            .iter()
            .filter(|v| **v == ReplyOutcome::Applied)
            .count(),
        1
    );
    assert_eq!(
        outcomes
            .iter()
            .filter(|v| **v == ReplyOutcome::Duplicate)
            .count(),
        1
    );
    let run = first
        .get_observation_run("org", "run")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(run.version, 2);
    assert!(run.closed_at.is_some());
    assert!(first
        .enqueue_runner_step("org", "run", 0, "{}", NOW)
        .await
        .is_err());
    drop(first);
    drop(second);
    let restarted = Db::connect_sqlite(&url).await.unwrap();
    assert_eq!(cancel(&restarted).await.unwrap(), ReplyOutcome::Duplicate);
    assert_eq!(
        restarted
            .apply_a2h_reply(
                "reply",
                "org",
                &"b".repeat(64),
                ReplyDecision::Acknowledge,
                NOW
            )
            .await
            .unwrap(),
        ReplyOutcome::Conflict
    );
    drop(restarted);
    std::fs::remove_file(path).unwrap();
}

#[tokio::test]
async fn stale_or_cross_owner_cancel_is_dead_lettered_without_interrupting_work() {
    let db = Db::connect_memory().await.unwrap();
    seed(&db).await;
    sqlx::query("UPDATE observation_runs SET quiescence='critical' WHERE id='run'")
        .execute(db.pool())
        .await
        .unwrap();
    assert_eq!(cancel(&db).await.unwrap(), ReplyOutcome::DeadLetter);
    let run = db.get_observation_run("org", "run").await.unwrap().unwrap();
    assert_eq!(run.version, 1);
    assert!(run.closed_at.is_none());
    assert_eq!(cancel(&db).await.unwrap(), ReplyOutcome::DeadLetter);
    assert_eq!(
        db.apply_a2h_reply(
            "reply",
            "other-org",
            DIGEST,
            ReplyDecision::Acknowledge,
            NOW
        )
        .await
        .unwrap(),
        ReplyOutcome::Conflict
    );
}

#[tokio::test]
async fn transient_effect_failure_rolls_back_claim_and_can_retry() {
    let db = Db::connect_memory().await.unwrap();
    seed(&db).await;
    sqlx::query("CREATE TRIGGER fail_cancel BEFORE UPDATE ON observation_runs BEGIN SELECT RAISE(ABORT,'injected failure'); END")
        .execute(db.pool()).await.unwrap();
    assert!(cancel(&db).await.is_err());
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM a2h_reply_claims")
        .fetch_one(db.pool())
        .await
        .unwrap();
    assert_eq!(count, 0);
    sqlx::query("DROP TRIGGER fail_cancel")
        .execute(db.pool())
        .await
        .unwrap();
    assert_eq!(cancel(&db).await.unwrap(), ReplyOutcome::Applied);
}

#[tokio::test]
async fn expired_reply_is_visible_without_applying_the_effect() {
    let db = Db::connect_memory().await.unwrap();
    seed(&db).await;
    let decision = ReplyDecision::Cancel {
        run_id: "run",
        owner: "principal:owner",
        valid_until: 0,
    };
    assert_eq!(
        db.apply_a2h_reply("reply", "org", DIGEST, decision, NOW)
            .await
            .unwrap(),
        ReplyOutcome::DeadLetter
    );
    assert_eq!(
        db.list_a2h_reply_status("org", 10).await.unwrap()[0].outcome,
        "reply_expired"
    );
    assert!(db
        .get_observation_run("org", "run")
        .await
        .unwrap()
        .unwrap()
        .closed_at
        .is_none());
}
