//! The policy routes: compare-and-set replacement, the parser's refusals,
//! and tenancy.

use super::*;

#[tokio::test]
async fn the_policy_is_replaced_by_compare_and_set_and_governs_verdicts() {
    let st = test_demo_state().await;
    let org = st.connection_organization;
    let admin = stepped_up(&st, P27, org, OrganizationRole::Admin);
    let member = test_session_headers(&st, P26, org, OrganizationRole::Member);
    let app = crate::routes::router(st.clone());

    let read = send(&app, &admin, "GET", POLICY, Vec::new()).await;
    assert_eq!(read.status, StatusCode::OK);
    assert_eq!(read.body["version"], 0);
    assert_eq!(read.body["stored"], false);
    assert_eq!(read.body["policy"]["unlisted_tools"], "escalate");
    assert_eq!(read.headers[header::ETAG], "\"0\"");

    let policy =
        br#"{"version":1,"unlisted_tools":"allow","tools":[{"name":"shell","decision":"deny"}]}"#;
    let missing = send(&app, &admin, "PUT", POLICY, policy.to_vec()).await;
    assert_eq!(missing.status, StatusCode::PRECONDITION_REQUIRED);
    for tag in ["*", "0", "W/\"0\"", "\"-1\"", "\"0\", \"1\""] {
        let headers = with(admin.clone(), "if-match", tag);
        let reply = send(&app, &headers, "PUT", POLICY, policy.to_vec()).await;
        assert_eq!(reply.status, StatusCode::BAD_REQUEST, "If-Match: {tag}");
    }

    let create = with(admin.clone(), "if-match", "\"0\"");
    let written = send(&app, &create, "PUT", POLICY, policy.to_vec()).await;
    assert_eq!(written.status, StatusCode::OK, "{}", written.body);
    assert_eq!(written.body["version"], 1);
    assert_eq!(written.body["policy"]["secret_guard"], "redact");
    assert_eq!(written.body["updated_by"], P27);
    assert_eq!(written.headers[header::ETAG], "\"1\"");

    // A second writer against the version it read loses, and learns why.
    let stale = send(&app, &create, "PUT", POLICY, b"{\"version\":1}".to_vec()).await;
    assert_eq!(stale.status, StatusCode::PRECONDITION_FAILED);
    assert_eq!(stale.body["current_version"], 1);
    // The largest version a tag can name is a lost race, never an overflow.
    let huge = with(admin.clone(), "if-match", &format!("\"{}\"", i64::MAX));
    let beyond = send(&app, &huge, "PUT", POLICY, b"{\"version\":1}".to_vec()).await;
    assert_eq!(beyond.status, StatusCode::PRECONDITION_FAILED);

    let shell = send(
        &app,
        &member,
        "POST",
        INTERCEPT,
        tool_call("shell", &json!({})),
    )
    .await;
    assert_eq!(shell.body["decision"], "deny");
    assert_eq!(shell.body["reason"], "opensesame:tool_denied");
    assert_eq!(shell.headers[POLICY_VERSION_HEADER], "1");
    let other = send(
        &app,
        &member,
        "POST",
        INTERCEPT,
        tool_call("ls", &json!({})),
    )
    .await;
    assert_eq!(other.body["decision"], "allow");

    let rows = decision_rows(&st).await;
    assert_eq!(rows.len(), 2);
    assert!(rows.iter().all(|row| row["policy_version"] == 1));

    let replace = with(admin.clone(), "if-match", "\"1\"");
    let back = send(&app, &replace, "PUT", POLICY, b"{\"version\":1}".to_vec()).await;
    assert_eq!(back.status, StatusCode::OK);
    assert_eq!(back.body["version"], 2);
    let updates: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM outbox_events WHERE event_type = ?")
            .bind(crate::agent_hooks::EVENT_POLICY_UPDATED)
            .fetch_one(st.db.pool())
            .await
            .unwrap();
    assert_eq!(
        updates, 2,
        "each landed write is audited, the lost one is not"
    );
}

#[tokio::test]
async fn an_invalid_policy_is_refused_with_the_parsers_positional_error() {
    let st = test_demo_state().await;
    let admin = stepped_up(
        &st,
        P27,
        st.connection_organization,
        OrganizationRole::Owner,
    );
    let app = crate::routes::router(st.clone());
    let headers = with(admin, "if-match", "\"0\"");
    let ambiguous = br#"{"version":1,"tools":[{"decision":"allow"}]}"#;
    let reply = send(&app, &headers, "PUT", POLICY, ambiguous.to_vec()).await;
    assert_eq!(reply.status, StatusCode::BAD_REQUEST);
    assert_eq!(reply.body["error"], "invalid_policy");
    assert!(
        reply.body["hint"].as_str().unwrap().contains("tools[0]"),
        "{}",
        reply.body
    );
    let other_version = send(&app, &headers, "PUT", POLICY, b"{\"version\":2}".to_vec()).await;
    assert_eq!(other_version.status, StatusCode::BAD_REQUEST);
    let oversized = vec![b' '; MAX_POLICY_BYTES + 1];
    let reply = send(&app, &headers, "PUT", POLICY, oversized).await;
    assert_eq!(reply.status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(
        st.db
            .agent_hook_policy(&st.connection_organization.to_string())
            .await
            .unwrap(),
        None
    );
}

#[tokio::test]
async fn organizations_never_read_or_write_each_others_policy() {
    let st = test_demo_state().await;
    let org_a = st.connection_organization;
    let org_b = OrganizationId::new();
    let admin_a = stepped_up(&st, P27, org_a, OrganizationRole::Admin);
    let admin_b = stepped_up(&st, P28, org_b, OrganizationRole::Admin);
    let member_b = test_session_headers(&st, P26, org_b, OrganizationRole::Member);
    let app = crate::routes::router(st.clone());

    let create = with(admin_a.clone(), "if-match", "\"0\"");
    let policy = br#"{"version":1,"unlisted_tools":"deny"}"#;
    assert_eq!(
        send(&app, &create, "PUT", POLICY, policy.to_vec())
            .await
            .status,
        StatusCode::OK
    );

    // B sees its own (default) policy, and a verdict under it.
    let read = send(&app, &admin_b, "GET", POLICY, Vec::new()).await;
    assert_eq!(read.body["version"], 0);
    assert_eq!(read.body["policy"]["unlisted_tools"], "escalate");
    let verdict = send(
        &app,
        &member_b,
        "POST",
        INTERCEPT,
        tool_call("x", &json!({})),
    )
    .await;
    assert_eq!(verdict.body["reason"], "opensesame:tool_requires_approval");

    // A session cannot select another organization.
    let aimed = with(
        admin_b.clone(),
        "x-opensesame-organization",
        &org_a.to_string(),
    );
    for method in ["GET", "POST"] {
        let uri = if method == "GET" { POLICY } else { INTERCEPT };
        let reply = send(&app, &aimed, method, uri, tool_call("x", &json!({}))).await;
        assert_eq!(reply.status, StatusCode::FORBIDDEN, "{method}");
    }
    // B's creation does not touch A's version.
    let create_b = with(admin_b, "if-match", "\"0\"");
    assert_eq!(
        send(&app, &create_b, "PUT", POLICY, b"{\"version\":1}".to_vec())
            .await
            .status,
        StatusCode::OK
    );
    let a = send(&app, &admin_a, "GET", POLICY, Vec::new()).await;
    assert_eq!(a.body["version"], 1);
    assert_eq!(a.body["policy"]["unlisted_tools"], "deny");

    // The operator selects an organization explicitly.
    let operator_a = with(
        operator(&st),
        "x-opensesame-organization",
        &org_a.to_string(),
    );
    let verdict = send(
        &app,
        &operator_a,
        "POST",
        INTERCEPT,
        tool_call("x", &json!({})),
    )
    .await;
    assert_eq!(verdict.body["reason"], "opensesame:tool_denied");
}
