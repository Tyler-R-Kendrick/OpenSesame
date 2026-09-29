//! Organization policies (ADR 0148 §9), in process: sync carries them, and
//! the server itself holds members — never owners or admins — to the ones
//! that guard what it stores.
mod common;

use chrono::{Duration, Utc};
use common::orgs::{account, add_member, member_id, Api, Org};
use common::Harness;
use serde_json::{json, Value};

fn note(org: Option<&Org>) -> Value {
    match org {
        Some(org) => json!({"type": 2, "organizationId": org.id, "name": org.enc("n"),
                            "secureNote": {"type": 0}}),
        None => json!({"type": 2, "name": "2.aGk=|aGk=|aGk=", "secureNote": {"type": 0}}),
    }
}

fn send(hide_email: bool) -> Value {
    json!({"type": 0, "name": "2.aGk=|aGk=|aGk=", "key": "2.aGk=|aGk=|aGk=",
           "text": {"text": "2.aGk=|aGk=|aGk=", "hidden": false}, "hideEmail": hide_email,
           "deletionDate": (Utc::now() + Duration::days(2)).to_rfc3339()})
}

async fn set(owner: &Api, org: &Org, kind: i64, enabled: bool, data: Value) {
    owner
        .ok(
            "PUT",
            &format!("/organizations/{}/policies/{kind}", org.id),
            Some(json!({"policy": {"enabled": enabled, "data": data}})),
        )
        .await;
}

#[tokio::test]
async fn personal_ownership_and_send_policies_bind_members_not_owners() {
    let harness = Harness::start().await;
    let (_, owner) = account(&harness, "owner@example.com").await;
    let (_, member) = account(&harness, "member@example.com").await;
    let (org, collection) = Org::create(&owner, "Acme").await;
    add_member(
        &owner,
        &org,
        "member@example.com",
        &member,
        json!([{"id": collection}]),
    )
    .await;
    assert_eq!(
        member
            .put(
                &format!("/organizations/{}/policies/5", org.id),
                json!({"enabled": true})
            )
            .await
            .0,
        404
    );

    set(&owner, &org, 5, true, Value::Null).await;
    assert_eq!(member.post("/ciphers", note(None)).await.0, 400);
    member
        .ok(
            "POST",
            "/ciphers/create",
            Some(json!({"cipher": note(Some(&org)), "collectionIds": [collection]})),
        )
        .await;
    owner.ok("POST", "/ciphers", Some(note(None))).await;
    let sync = member.ok("GET", "/sync", None).await;
    assert_eq!(sync["policies"][0]["type"], 5);
    assert_eq!(sync["policies"][0]["enabled"], true);

    // The older flat body, as some clients send it.
    owner
        .ok(
            "PUT",
            &format!("/organizations/{}/policies/7", org.id),
            Some(json!({"enabled": true, "data": {"disableHideEmail": true}})),
        )
        .await;
    assert_eq!(member.post("/sends", send(true)).await.0, 400);
    member.ok("POST", "/sends", Some(send(false))).await;
    set(&owner, &org, 6, true, Value::Null).await;
    assert_eq!(member.post("/sends", send(false)).await.0, 400);
    owner.ok("POST", "/sends", Some(send(true))).await;

    // Turned off, it binds no one.
    set(&owner, &org, 5, false, Value::Null).await;
    member.ok("POST", "/ciphers", Some(note(None))).await;
    let listed = member
        .ok("GET", &format!("/organizations/{}/policies", org.id), None)
        .await;
    assert_eq!(listed["data"].as_array().unwrap().len(), 3);
}

#[tokio::test]
async fn two_step_login_and_single_organization_revoke_and_refuse() {
    let harness = Harness::start().await;
    let (_, owner) = account(&harness, "owner@example.com").await;
    let (_, member) = account(&harness, "member@example.com").await;
    let (_, later) = account(&harness, "later@example.com").await;
    let (org, _) = Org::create(&owner, "Acme").await;
    let (other, _) = Org::create(&later, "Elsewhere").await;
    add_member(&owner, &org, "member@example.com", &member, json!([])).await;

    // The member has no two-step login: enabling the policy revokes them.
    set(&owner, &org, 0, true, Value::Null).await;
    let listed = owner
        .ok("GET", &format!("/organizations/{}/users", org.id), None)
        .await;
    let revoked = listed["data"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["email"] == "member@example.com")
        .unwrap();
    assert_eq!(revoked["status"], -1);
    assert!(
        member.ok("GET", "/sync", None).await["profile"]["organizations"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    // And one without it is not confirmed.
    owner
        .ok(
            "POST",
            &format!("/organizations/{}/users/invite", org.id),
            Some(json!({"emails": ["later@example.com"], "type": 2})),
        )
        .await;
    let later_id = member_id(&owner, &org, "later@example.com").await;
    let key = org.wrap_for(&owner, &later.user_id().await).await;
    assert_eq!(
        owner
            .post(
                &format!("/organizations/{}/users/{later_id}/confirm", org.id),
                json!({"key": key})
            )
            .await
            .0,
        400
    );
    // Nor restored while the policy holds.
    let member_row = member_id(&owner, &org, "member@example.com").await;
    assert_eq!(
        owner
            .put(
                &format!("/organizations/{}/users/{member_row}/restore", org.id),
                json!({})
            )
            .await
            .0,
        400
    );
    set(&owner, &org, 0, false, Value::Null).await;

    // Single organization: `later` owns another, so is not confirmed here...
    set(&owner, &org, 3, true, Value::Null).await;
    assert_eq!(
        owner
            .post(
                &format!("/organizations/{}/users/{later_id}/confirm", org.id),
                json!({"key": key})
            )
            .await
            .0,
        400
    );
    // ...and a bound member may not create one.
    owner
        .ok(
            "PUT",
            &format!(
                "/organizations/{}/users/{}/restore",
                org.id,
                member_id(&owner, &org, "member@example.com").await
            ),
            Some(json!({})),
        )
        .await;
    let created = member
        .post(
            "/organizations",
            json!({"name": "Mine", "billingEmail": "b@example.com", "key": "4.eA=="}),
        )
        .await;
    assert_eq!(created.0, 400, "{}", created.1);
    let _ = other;
}

#[tokio::test]
async fn the_web_vault_can_list_plans() {
    let harness = Harness::start().await;
    let (_, api) = account(&harness, "me@example.com").await;
    assert_eq!(api.ok("GET", "/plans", None).await["data"][0]["type"], 0);
}
