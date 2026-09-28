//! Organizations and collections (ADR 0148 §5), in process: who sees an
//! organization's ciphers, who may change them, and that nothing reaches a
//! member before an administrator confirms them.
mod common;

use common::client::encrypt;
use common::orgs::{account, add_member, ids, Org};
use common::Harness;
use serde_json::{json, Value};

#[tokio::test]
async fn an_owner_creates_an_organization_and_sync_carries_it() {
    let harness = Harness::start().await;
    let (_, owner) = account(&harness, "owner@example.com").await;
    let (org, collection) = Org::create(&owner, "Acme").await;

    let sync = owner.ok("GET", "/sync", None).await;
    let orgs = sync["profile"]["organizations"].as_array().unwrap();
    assert_eq!(orgs.len(), 1);
    assert_eq!(orgs[0]["id"], org.id.as_str());
    assert_eq!(orgs[0]["type"], 0);
    assert_eq!(orgs[0]["status"], 2);
    assert!(orgs[0]["key"].as_str().unwrap().starts_with("4."));
    assert_eq!(ids(&sync["collections"]), vec![collection.clone()]);

    let keys = owner
        .ok("GET", &format!("/organizations/{}/keys", org.id), None)
        .await;
    assert!(keys["privateKey"].as_str().unwrap().starts_with("2."));
    let details = owner
        .ok("GET", &format!("/organizations/{}", org.id), None)
        .await;
    assert_eq!(details["name"], "Acme");
}

#[tokio::test]
async fn a_member_holds_nothing_until_confirmed() {
    let harness = Harness::start().await;
    let (_, owner) = account(&harness, "owner@example.com").await;
    let (_, member) = account(&harness, "member@example.com").await;
    let (org, collection) = Org::create(&owner, "Acme").await;
    let cipher = owner
        .ok(
            "POST",
            "/ciphers/create",
            Some(json!({"cipher": org.login("Router", "hunter2"), "collectionIds": [collection]})),
        )
        .await;
    let cipher_id = cipher["id"].as_str().unwrap().to_owned();

    owner
        .ok(
            "POST",
            &format!("/organizations/{}/users/invite", org.id),
            Some(json!({"emails": ["member@example.com"], "type": 2,
                        "collections": [{"id": collection, "readOnly": true}]})),
        )
        .await;
    let listed = owner
        .ok("GET", &format!("/organizations/{}/users", org.id), None)
        .await;
    let pending = listed["data"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["email"] == "member@example.com")
        .unwrap();
    assert_eq!(
        pending["status"], 1,
        "an existing account is accepted at once"
    );

    // Accepted, not confirmed: no organization, no cipher, no keys.
    let sync = member.ok("GET", "/sync", None).await;
    assert!(sync["profile"]["organizations"]
        .as_array()
        .unwrap()
        .is_empty());
    assert!(sync["ciphers"].as_array().unwrap().is_empty());
    assert_eq!(member.get(&format!("/ciphers/{cipher_id}")).await.0, 404);
    assert_eq!(
        member
            .get(&format!("/organizations/{}/keys", org.id))
            .await
            .0,
        404
    );

    let id = pending["id"].as_str().unwrap();
    let key = org.wrap_for(&owner, &member.user_id().await).await;
    owner
        .ok(
            "POST",
            &format!("/organizations/{}/users/{id}/confirm", org.id),
            Some(json!({"key": key})),
        )
        .await;
    // A second confirmation is refused: the member is no longer accepted.
    assert_eq!(
        owner
            .post(
                &format!("/organizations/{}/users/{id}/confirm", org.id),
                json!({"key": key})
            )
            .await
            .0,
        400
    );

    let sync = member.ok("GET", "/sync", None).await;
    assert_eq!(sync["profile"]["organizations"][0]["key"], key.as_str());
    let seen = &sync["ciphers"][0];
    assert_eq!(seen["id"], cipher_id.as_str());
    assert_eq!(seen["edit"], false);
    assert_eq!(seen["collectionIds"], json!([collection]));
    assert_eq!(sync["collections"][0]["readOnly"], true);
}

#[tokio::test]
async fn read_only_members_cannot_change_but_keep_their_own_folder() {
    let harness = Harness::start().await;
    let (_, owner) = account(&harness, "owner@example.com").await;
    let (_, member) = account(&harness, "member@example.com").await;
    let (org, collection) = Org::create(&owner, "Acme").await;
    add_member(
        &owner,
        &org,
        "member@example.com",
        &member,
        json!([{"id": collection, "readOnly": true}]),
    )
    .await;
    let cipher = owner
        .ok(
            "POST",
            "/ciphers/create",
            Some(json!({"cipher": org.login("Router", "a"), "collectionIds": [collection]})),
        )
        .await;
    let id = cipher["id"].as_str().unwrap();

    let (status, body) = member
        .put(&format!("/ciphers/{id}"), org.login("Changed", "b"))
        .await;
    assert_eq!(status, 400, "{body}");
    assert_eq!(
        member
            .put(&format!("/ciphers/{id}/delete"), json!({}))
            .await
            .0,
        400
    );
    assert_eq!(
        member
            .post(
                "/ciphers/create",
                json!({"cipher": org.login("New", "c"), "collectionIds": [collection]})
            )
            .await
            .0,
        400
    );

    // Favourite and folder are the member's own and allowed.
    let folder = member
        .ok("POST", "/folders", Some(json!({"name": org.enc("Mine")})))
        .await;
    let marked = member
        .ok(
            "PUT",
            &format!("/ciphers/{id}/partial"),
            Some(json!({"folderId": folder["id"], "favorite": true})),
        )
        .await;
    assert_eq!(marked["favorite"], true);
    assert_eq!(marked["folderId"], folder["id"]);
    let owners_view = owner.ok("GET", &format!("/ciphers/{id}"), None).await;
    assert_eq!(owners_view["favorite"], false);
    assert_eq!(owners_view["folderId"], Value::Null);

    // The owner can edit.
    owner
        .ok(
            "PUT",
            &format!("/ciphers/{id}"),
            Some(org.login("Changed", "b")),
        )
        .await;
}

#[tokio::test]
async fn a_member_shares_a_personal_cipher_into_a_writable_collection() {
    let harness = Harness::start().await;
    let (account_b, member) = account(&harness, "member@example.com").await;
    let (_, owner) = account(&harness, "owner@example.com").await;
    let (org, collection) = Org::create(&owner, "Acme").await;
    add_member(
        &owner,
        &org,
        "member@example.com",
        &member,
        json!([{"id": collection}]),
    )
    .await;
    let personal = member
        .ok(
            "POST",
            "/ciphers",
            Some(json!({"type": 2, "name": encrypt(&account_b.user_key(), b"n"), "secureNote": {"type": 0}})),
        )
        .await;
    let id = personal["id"].as_str().unwrap();

    // Not into a collection it cannot write to, and not without one.
    let mut body = json!({"type": 2, "organizationId": org.id, "name": org.enc("n"), "secureNote": {"type": 0}});
    assert_eq!(
        member
            .put(
                &format!("/ciphers/{id}/share"),
                json!({"cipher": body.clone(), "collectionIds": []})
            )
            .await
            .0,
        400
    );
    body["lastKnownRevisionDate"] = personal["revisionDate"].clone();
    let shared = member
        .ok(
            "PUT",
            &format!("/ciphers/{id}/share"),
            Some(json!({"cipher": body.clone(), "collectionIds": [collection]})),
        )
        .await;
    assert_eq!(shared["organizationId"], org.id.as_str());
    assert_eq!(shared["collectionIds"], json!([collection]));
    let seen = owner.ok("GET", &format!("/ciphers/{id}"), None).await;
    assert_eq!(seen["organizationId"], org.id.as_str());
    // Sharing twice is refused: it is no longer the member's.
    assert_eq!(
        member
            .put(
                &format!("/ciphers/{id}/share"),
                json!({"cipher": body, "collectionIds": [collection]})
            )
            .await
            .0,
        404
    );
}

#[tokio::test]
async fn collections_decide_who_sees_what() {
    let harness = Harness::start().await;
    let (_, owner) = account(&harness, "owner@example.com").await;
    let (_, member) = account(&harness, "member@example.com").await;
    let (org, first) = Org::create(&owner, "Acme").await;
    let second = owner
        .ok(
            "POST",
            &format!("/organizations/{}/collections", org.id),
            Some(json!({"name": org.enc("Second"), "users": []})),
        )
        .await["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let member_id = add_member(
        &owner,
        &org,
        "member@example.com",
        &member,
        json!([{"id": first, "manage": true}]),
    )
    .await;
    let hidden = owner
        .ok(
            "POST",
            "/ciphers/create",
            Some(json!({"cipher": org.login("Hidden", "x"), "collectionIds": [second]})),
        )
        .await["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let both = owner
        .ok(
            "POST",
            "/ciphers/create",
            Some(json!({"cipher": org.login("Both", "y"), "collectionIds": [first, second]})),
        )
        .await["id"]
        .as_str()
        .unwrap()
        .to_owned();

    assert_eq!(member.get(&format!("/ciphers/{hidden}")).await.0, 404);
    let seen = member.ok("GET", &format!("/ciphers/{both}"), None).await;
    assert_eq!(
        seen["collectionIds"],
        json!([first]),
        "only the collections it sees"
    );
    // Members do not create collections here, and cannot see the other one.
    assert_eq!(
        member
            .post(
                &format!("/organizations/{}/collections", org.id),
                json!({"name": org.enc("Mine")})
            )
            .await
            .0,
        400
    );
    assert_eq!(
        ids(&member.ok("GET", "/collections", None).await),
        vec![first.clone()]
    );

    let refused = member
        .put(
            &format!("/ciphers/{hidden}/collections_v2"),
            json!({"collectionIds": [first]}),
        )
        .await;
    assert_eq!(refused.0, 404, "cannot reach a cipher it cannot see");
    let refused = member
        .put(
            &format!("/ciphers/{both}/collections_v2"),
            json!({"collectionIds": [first, second]}),
        )
        .await;
    assert_eq!(refused.0, 400, "cannot name a collection it cannot see");
    // Taking `both` out of the member's only collection keeps the one it
    // cannot see, and then it no longer sees the cipher at all.
    let moved = member
        .ok(
            "PUT",
            &format!("/ciphers/{both}/collections_v2"),
            Some(json!({"collectionIds": []})),
        )
        .await;
    assert_eq!(moved["unavailable"], true, "{moved}");
    let kept = owner.ok("GET", &format!("/ciphers/{both}"), None).await;
    assert_eq!(kept["collectionIds"], json!([second]));

    owner
        .ok(
            "PUT",
            &format!("/organizations/{}/users/{member_id}", org.id),
            Some(json!({"type": 2, "collections": [{"id": first}, {"id": second, "readOnly": true}]})),
        )
        .await;
    let seen = member.ok("GET", &format!("/ciphers/{hidden}"), None).await;
    assert_eq!(seen["edit"], false);
}

#[tokio::test]
async fn an_organization_import_lands_in_its_collections() {
    let harness = Harness::start().await;
    let (_, owner) = account(&harness, "owner@example.com").await;
    let (org, existing) = Org::create(&owner, "Acme").await;
    owner
        .ok(
            "POST",
            &format!("/ciphers/import-organization?organizationId={}", org.id),
            Some(json!({
                "ciphers": [org.login("One", "1"), org.login("Two", "2")],
                "collections": [{"id": existing, "name": org.enc("Default")}, {"name": org.enc("Imported")}],
                "collectionRelationships": [{"key": 0, "value": 0}, {"key": 1, "value": 1}],
            })),
        )
        .await;
    let sync = owner.ok("GET", "/sync", None).await;
    assert_eq!(sync["collections"].as_array().unwrap().len(), 2);
    let ciphers = sync["ciphers"].as_array().unwrap();
    assert_eq!(ciphers.len(), 2);
    assert!(ciphers
        .iter()
        .any(|c| c["collectionIds"] == json!([existing])));
    // A personal cipher cannot be imported into the organization.
    let mut stray = org.login("Stray", "3");
    stray["organizationId"] = Value::Null;
    let (status, _) = owner
        .post(
            &format!("/ciphers/import-organization?organizationId={}", org.id),
            json!({"ciphers": [stray], "collections": [], "collectionRelationships": []}),
        )
        .await;
    assert_eq!(status, 400);
}
