//! Organization roles and membership over time (ADR 0148 §5): what each
//! role may do to others, invitations that wait for an address, leaving and
//! revocation, and purging an organization's vault.
mod common;

use common::client::encrypt;
use common::orgs::{account, add_member, member_id, Org};
use common::Harness;
use serde_json::{json, Value};

#[tokio::test]
async fn roles_bound_what_members_may_do() {
    let harness = Harness::start().await;
    let (_, owner) = account(&harness, "owner@example.com").await;
    let (_, admin) = account(&harness, "admin@example.com").await;
    let (_, user) = account(&harness, "user@example.com").await;
    let (_, stranger) = account(&harness, "stranger@example.com").await;
    let (org, _) = Org::create(&owner, "Acme").await;
    let admin_id = add_member(&owner, &org, "admin@example.com", &admin, json!([])).await;
    owner
        .ok(
            "PUT",
            &format!("/organizations/{}/users/{admin_id}", org.id),
            Some(json!({"type": 1})),
        )
        .await;
    add_member(&owner, &org, "user@example.com", &user, json!([])).await;
    let owner_id = member_id(&owner, &org, "owner@example.com").await;

    let base = format!("/organizations/{}", org.id);
    assert_eq!(stranger.get(&format!("{base}/users")).await.0, 404);
    assert_eq!(user.get(&format!("{base}/users")).await.0, 404);
    assert_eq!(
        user.post(
            &format!("{base}/users/invite"),
            json!({"emails": ["x@example.com"], "type": 2})
        )
        .await
        .0,
        404
    );
    // An admin may not make an owner, nor act on one.
    assert_eq!(
        admin
            .post(
                &format!("{base}/users/invite"),
                json!({"emails": ["x@example.com"], "type": 0})
            )
            .await
            .0,
        400
    );
    assert_eq!(
        admin
            .delete(&format!("{base}/users/{owner_id}"), json!({}))
            .await
            .0,
        400
    );
    // The last owner can neither leave nor be demoted.
    assert_eq!(owner.post(&format!("{base}/leave"), json!({})).await.0, 400);
    assert_eq!(
        owner
            .put(&format!("{base}/users/{owner_id}"), json!({"type": 1}))
            .await
            .0,
        400
    );
    // Only the owner deletes it, and only with the password.
    assert_eq!(
        admin
            .delete(&base, json!({"masterPasswordHash": "x"}))
            .await
            .0,
        404
    );
    assert_eq!(
        owner
            .delete(&base, json!({"masterPasswordHash": "wrong"}))
            .await
            .0,
        400
    );
}

#[tokio::test]
async fn an_invitation_waits_for_the_address_to_register() {
    let harness = Harness::start().await;
    let (_, owner) = account(&harness, "owner@example.com").await;
    let (org, _) = Org::create(&owner, "Acme").await;
    owner
        .ok(
            "POST",
            &format!("/organizations/{}/users/invite", org.id),
            Some(json!({"emails": ["Later@Example.com"], "type": 2})),
        )
        .await;
    let listed = owner
        .ok("GET", &format!("/organizations/{}/users", org.id), None)
        .await;
    let waiting = listed["data"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["email"] == "later@example.com")
        .unwrap()
        .clone();
    assert_eq!(waiting["status"], 0);
    assert_eq!(waiting["userId"], Value::Null);

    let (_, later) = account(&harness, "later@example.com").await;
    let listed = owner
        .ok("GET", &format!("/organizations/{}/users", org.id), None)
        .await;
    let claimed = listed["data"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["email"] == "later@example.com")
        .unwrap()
        .clone();
    assert_eq!(claimed["status"], 1);
    assert_eq!(claimed["userId"], later.user_id().await.as_str());
}

#[tokio::test]
async fn a_member_who_leaves_or_is_revoked_loses_access() {
    let harness = Harness::start().await;
    let (_, owner) = account(&harness, "owner@example.com").await;
    let (_, member) = account(&harness, "member@example.com").await;
    let (org, collection) = Org::create(&owner, "Acme").await;
    let id = add_member(
        &owner,
        &org,
        "member@example.com",
        &member,
        json!([{"id": collection}]),
    )
    .await;
    let cipher = owner
        .ok(
            "POST",
            "/ciphers/create",
            Some(json!({"cipher": org.login("Router", "a"), "collectionIds": [collection]})),
        )
        .await["id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(member.get(&format!("/ciphers/{cipher}")).await.0, 200);

    owner
        .ok(
            "PUT",
            &format!("/organizations/{}/users/{id}/revoke", org.id),
            Some(json!({})),
        )
        .await;
    assert_eq!(member.get(&format!("/ciphers/{cipher}")).await.0, 404);
    owner
        .ok(
            "PUT",
            &format!("/organizations/{}/users/{id}/restore", org.id),
            Some(json!({})),
        )
        .await;
    assert_eq!(member.get(&format!("/ciphers/{cipher}")).await.0, 200);

    member
        .ok(
            "POST",
            &format!("/organizations/{}/leave", org.id),
            Some(json!({})),
        )
        .await;
    assert_eq!(member.get(&format!("/ciphers/{cipher}")).await.0, 404);
    let sync = member.ok("GET", "/sync", None).await;
    assert!(sync["profile"]["organizations"]
        .as_array()
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn purging_an_organization_leaves_personal_vaults_alone() {
    let harness = Harness::start().await;
    let (owner_account, owner) = account(&harness, "owner@example.com").await;
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
    owner
        .ok(
            "POST",
            "/ciphers/create",
            Some(json!({"cipher": org.login("Router", "a"), "collectionIds": [collection]})),
        )
        .await;
    owner
        .ok(
            "POST",
            "/ciphers",
            Some(json!({"type": 2, "name": encrypt(&owner_account.user_key(), b"mine"), "secureNote": {"type": 0}})),
        )
        .await;

    let purge = format!("/ciphers/purge?organizationId={}", org.id);
    let member_hash = json!({"masterPasswordHash": "x"});
    assert_ne!(member.post(&purge, member_hash).await.0, 200);
    owner
        .ok(
            "POST",
            &purge,
            Some(json!({"masterPasswordHash": owner_account.password_hash()})),
        )
        .await;
    let sync = owner.ok("GET", "/sync", None).await;
    let left = sync["ciphers"].as_array().unwrap();
    assert_eq!(left.len(), 1, "{sync}");
    assert_eq!(left[0]["organizationId"], Value::Null);
}

#[tokio::test]
async fn delegated_roles_hand_out_no_more_than_they_hold() {
    let harness = Harness::start().await;
    let (_, owner) = account(&harness, "owner@example.com").await;
    let (_, helper) = account(&harness, "helper@example.com").await;
    let (_, user) = account(&harness, "user@example.com").await;
    let (org, first) = Org::create(&owner, "Acme").await;
    let base = format!("/organizations/{}", org.id);
    let second = owner
        .ok(
            "POST",
            &format!("{base}/collections"),
            Some(json!({"name": org.enc("Second")})),
        )
        .await["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let helper_id = add_member(
        &owner,
        &org,
        "helper@example.com",
        &helper,
        json!([{"id": first, "manage": true}]),
    )
    .await;
    owner
        .ok(
            "PUT",
            &format!("{base}/users/{helper_id}"),
            Some(json!({"type": 4, "permissions": {"manageUsers": true},
                        "collections": [{"id": first, "manage": true}]})),
        )
        .await;
    let user_id = add_member(&owner, &org, "user@example.com", &user, json!([])).await;

    // The helper grants what it reaches, but not a collection it does not,
    // and not every collection.
    helper
        .ok(
            "PUT",
            &format!("{base}/users/{user_id}"),
            Some(json!({"type": 2, "collections": [{"id": first}]})),
        )
        .await;
    let (status, _) = helper
        .put(
            &format!("{base}/users/{user_id}"),
            json!({"type": 2, "collections": [{"id": second}]}),
        )
        .await;
    assert_eq!(status, 400);
    helper
        .ok(
            "PUT",
            &format!("{base}/users/{user_id}"),
            Some(json!({"type": 2, "accessAll": true, "collections": [{"id": first}]})),
        )
        .await;
    let listed = owner
        .ok("GET", &format!("{base}/users/{user_id}"), None)
        .await;
    assert_eq!(listed["accessAll"], false);
    // Managing a collection is not deleting it.
    assert_eq!(
        helper
            .delete(&format!("{base}/collections/{first}"), json!({}))
            .await
            .0,
        400
    );
    owner
        .ok(
            "DELETE",
            &format!("{base}/collections/{first}"),
            Some(json!({})),
        )
        .await;
}
