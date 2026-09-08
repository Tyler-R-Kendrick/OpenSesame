use opensesame_storage::{agent_capabilities::AgentLaunch, Db};

fn launch(handle: &str, now: i64) -> AgentLaunch<'_> {
    AgentLaunch {
        handle_digest: handle,
        principal_id: "principal",
        organization_id: "org",
        client_id: "client-1",
        audience: "urn:opensesame:agent:mcp-host",
        resource: "https://host.example",
        capabilities_json: "[\"host.tasks.read\"]",
        now,
    }
}

#[tokio::test]
async fn launch_is_single_use_and_bound_to_client_audience_and_resource() {
    let db = Db::connect_memory().await.unwrap();
    assert!(db
        .create_agent_launch(&launch("handle", 1000))
        .await
        .unwrap());
    for (client, audience, resource) in [
        (
            "other",
            "urn:opensesame:agent:mcp-host",
            "https://host.example",
        ),
        (
            "client-1",
            "urn:opensesame:agent:mcp-client",
            "https://host.example",
        ),
        (
            "client-1",
            "urn:opensesame:agent:mcp-host",
            "https://other.example",
        ),
    ] {
        assert!(db
            .exchange_agent_launch("handle", "wrong", client, audience, resource, 1001)
            .await
            .unwrap()
            .is_none());
    }
    let (a, b) = tokio::join!(
        db.exchange_agent_launch(
            "handle",
            "token-a",
            "client-1",
            "urn:opensesame:agent:mcp-host",
            "https://host.example",
            1001
        ),
        db.exchange_agent_launch(
            "handle",
            "token-b",
            "client-1",
            "urn:opensesame:agent:mcp-host",
            "https://host.example",
            1001
        )
    );
    assert_ne!(a.unwrap().is_some(), b.unwrap().is_some());
    let valid_a = db.agent_grant("token-a", 1002).await.unwrap();
    let token = if valid_a.is_some() {
        "token-a"
    } else {
        "token-b"
    };
    let grant = db.agent_grant(token, 1002).await.unwrap().unwrap();
    assert_eq!(grant.approved_at, 1000);
    assert_eq!(grant.expires_at, 1301);
    assert!(db.agent_grant(token, 1301).await.unwrap().is_none());
}

#[tokio::test]
async fn revocation_survives_restart_and_cancels_pending_launches() {
    let path = std::env::temp_dir().join(format!(
        "agent-capabilities-{}.sqlite",
        uuid::Uuid::new_v4()
    ));
    std::fs::File::create_new(&path).unwrap();
    let url = format!("sqlite://{}", path.display());
    let db = Db::connect_sqlite(&url).await.unwrap();
    db.create_agent_launch(&launch("handle", 1000))
        .await
        .unwrap();
    db.exchange_agent_launch(
        "handle",
        "token",
        "client-1",
        "urn:opensesame:agent:mcp-host",
        "https://host.example",
        1001,
    )
    .await
    .unwrap()
    .unwrap();
    db.create_agent_launch(&launch("pending", 1002))
        .await
        .unwrap();
    drop(db);
    let db = Db::connect_sqlite(&url).await.unwrap();
    assert!(db.agent_grant("token", 1003).await.unwrap().is_some());
    db.revoke_agent_client("other-principal", "org", "client-1")
        .await
        .unwrap();
    assert!(db.agent_grant("token", 1003).await.unwrap().is_some());
    db.revoke_agent_client("principal", "org", "client-1")
        .await
        .unwrap();
    assert!(db.agent_grant("token", 1003).await.unwrap().is_none());
    assert!(db
        .exchange_agent_launch(
            "pending",
            "other-token",
            "client-1",
            "urn:opensesame:agent:mcp-host",
            "https://host.example",
            1003
        )
        .await
        .unwrap()
        .is_none());
    drop(db);
    std::fs::remove_file(path).unwrap();
}

#[tokio::test]
async fn expired_launches_do_not_exhaust_the_owner_budget() {
    let db = Db::connect_memory().await.unwrap();
    for index in 0..65 {
        let now = 1000 + index * 601;
        let handle = format!("handle-{index}");
        assert!(db.create_agent_launch(&launch(&handle, now)).await.unwrap());
        assert!(db
            .exchange_agent_launch(
                &handle,
                &format!("token-{index}"),
                "client-1",
                "urn:opensesame:agent:mcp-host",
                "https://host.example",
                now + 1
            )
            .await
            .unwrap()
            .is_some());
    }
}
