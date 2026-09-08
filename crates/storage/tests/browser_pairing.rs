use opensesame_storage::{browser_pairing::NewBrowserPairing, Db};

async fn create(db: &Db) {
    assert!(db
        .create_browser_pairing(&NewBrowserPairing {
            id: "client",
            device_digest: "device-digest",
            user_code_digest: "user-digest",
            origin: "https://paired.example",
            dpop_jkt: "key",
            audience: "https://host.example",
            capabilities_json: "[\"host.sync.read\"]",
            now: 1000,
        })
        .await
        .unwrap());
}

#[tokio::test]
async fn exact_binding_and_single_winner_consumption() {
    let db = Db::connect_memory().await.unwrap();
    create(&db).await;
    assert!(db
        .consume_browser_pairing(
            "device-digest",
            "https://paired.example",
            "key",
            "token-digest",
            1001
        )
        .await
        .unwrap()
        .is_none());
    assert!(db
        .decide_browser_pairing("user-digest", "principal", "org", true, 1001)
        .await
        .unwrap());
    assert!(!db
        .decide_browser_pairing("user-digest", "other", "other", true, 1001)
        .await
        .unwrap());
    assert!(db
        .consume_browser_pairing(
            "device-digest",
            "https://other.example",
            "key",
            "token-digest",
            1001
        )
        .await
        .unwrap()
        .is_none());
    assert!(db
        .consume_browser_pairing(
            "device-digest",
            "https://paired.example",
            "other-key",
            "token-digest",
            1001
        )
        .await
        .unwrap()
        .is_none());
    let (first, second) = tokio::join!(
        db.consume_browser_pairing(
            "device-digest",
            "https://paired.example",
            "key",
            "one",
            1002
        ),
        db.consume_browser_pairing(
            "device-digest",
            "https://paired.example",
            "key",
            "two",
            1002
        ),
    );
    assert_eq!(
        usize::from(first.unwrap().is_some()) + usize::from(second.unwrap().is_some()),
        1
    );
}

#[tokio::test]
async fn restart_preserves_grants_proof_replay_and_owner_scoped_revocation() {
    let path = std::env::temp_dir().join(format!("browser-pairing-{}.db", uuid::Uuid::new_v4()));
    let url = format!("sqlite://{}?mode=rwc", path.display());
    let first = Db::connect_sqlite(&url).await.unwrap();
    create(&first).await;
    first
        .decide_browser_pairing("user-digest", "principal", "org", true, 1001)
        .await
        .unwrap();
    first
        .consume_browser_pairing(
            "device-digest",
            "https://paired.example",
            "key",
            "token-digest",
            1002,
        )
        .await
        .unwrap()
        .unwrap();
    assert!(first
        .claim_browser_proof("proof-digest", 1002)
        .await
        .unwrap());
    drop(first);
    let second = Db::connect_sqlite(&url).await.unwrap();
    assert!(second
        .browser_grant("token-digest", 1003)
        .await
        .unwrap()
        .is_some());
    assert!(!second
        .claim_browser_proof("proof-digest", 1003)
        .await
        .unwrap());
    assert!(!second
        .revoke_browser_client("client", "other", "org", 1003)
        .await
        .unwrap());
    assert!(second
        .revoke_browser_client("client", "principal", "org", 1003)
        .await
        .unwrap());
    assert!(second
        .browser_grant("token-digest", 1003)
        .await
        .unwrap()
        .is_none());
    drop(second);
    std::fs::remove_file(path).unwrap();
}

#[tokio::test]
async fn expiration_and_attempt_budgets_fail_closed() {
    let db = Db::connect_memory().await.unwrap();
    create(&db).await;
    assert!(!db
        .decide_browser_pairing("user-digest", "principal", "org", true, 1300)
        .await
        .unwrap());
    for _ in 0..10 {
        assert!(db
            .admit_browser_pairing_attempt("decision", 1000)
            .await
            .unwrap());
    }
    assert!(!db
        .admit_browser_pairing_attempt("decision", 1001)
        .await
        .unwrap());
    assert!(db
        .admit_browser_pairing_attempt("decision", 1060)
        .await
        .unwrap());
}

#[tokio::test]
async fn revocation_also_cancels_an_unconsumed_approval() {
    let db = Db::connect_memory().await.unwrap();
    create(&db).await;
    db.decide_browser_pairing("user-digest", "principal", "org", true, 1001)
        .await
        .unwrap();
    assert!(db
        .revoke_browser_client("client", "principal", "org", 1002)
        .await
        .unwrap());
    assert!(db
        .consume_browser_pairing(
            "device-digest",
            "https://paired.example",
            "key",
            "token-digest",
            1003
        )
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn expired_pairings_do_not_strand_the_owner_or_refresh_authentication_time() {
    let db = Db::connect_memory().await.unwrap();
    for cycle in 0..65 {
        let now = 1000 + cycle * 600;
        assert!(db
            .create_browser_pairing(&NewBrowserPairing {
                id: "client",
                device_digest: "device",
                user_code_digest: "code",
                origin: "https://paired.example",
                dpop_jkt: "key",
                audience: "https://host.example",
                capabilities_json: "[\"host.sync.read\"]",
                now,
            })
            .await
            .unwrap());
        assert!(db
            .decide_browser_pairing("code", "principal", "org", true, now + 1)
            .await
            .unwrap());
        let grant = db
            .consume_browser_pairing(
                "device",
                "https://paired.example",
                "key",
                "token",
                now + 200,
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(grant.approved_at, now + 1);
        assert_eq!(grant.issued_at, now + 200);
        assert_eq!(
            db.list_browser_clients("principal", "org")
                .await
                .unwrap()
                .len(),
            1
        );
    }
}
