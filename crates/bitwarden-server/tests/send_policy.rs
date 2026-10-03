//! The Send policy (ADR 0148 §9) holds for every change to a Send but
//! deleting it: creating, updating, removing a password, and completing a
//! file that was announced before the policy came on.
mod common;

use chrono::{Duration, Utc};
use common::client::http;
use common::orgs::{account, add_member, Org};
use common::Harness;
use reqwest::multipart::{Form, Part};
use serde_json::{json, Value};

const ENC: &str = "2.aGk=|aGk=|aGk=";

async fn set(owner: &common::orgs::Api, org: &Org, kind: i64, enabled: bool) {
    owner
        .ok(
            "PUT",
            &format!("/organizations/{}/policies/{kind}", org.id),
            Some(json!({"policy": {"enabled": enabled, "data": null}})),
        )
        .await;
}

fn file_send(extra: &Value) -> Value {
    let mut body = json!({
        "type": 1, "name": ENC, "key": ENC, "file": {"fileName": ENC}, "fileLength": 5,
        "deletionDate": (Utc::now() + Duration::days(2)).to_rfc3339(),
    });
    body.as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    body
}

#[tokio::test]
async fn the_send_policy_binds_every_change_to_a_send_but_deleting_it() {
    let harness = Harness::start().await;
    let (_, owner) = account(&harness, "owner@example.com").await;
    let (_, member) = account(&harness, "member@example.com").await;
    let (org, _) = Org::create(&owner, "Acme").await;
    add_member(&owner, &org, "member@example.com", &member, json!([])).await;

    // A file Send announced, and another with a password, before the policy.
    let announced = member.post("/sends/file/v2", file_send(&json!({}))).await.1;
    let id = announced["sendResponse"]["id"].as_str().unwrap().to_owned();
    let url = announced["url"]
        .as_str()
        .unwrap()
        .replace(&harness.https_url, &harness.http_url);
    let protected = member
        .post(
            "/sends",
            json!({"type": 0, "name": ENC, "key": ENC, "password": "open sesame",
                   "text": {"text": ENC, "hidden": false},
                   "deletionDate": (Utc::now() + Duration::days(2)).to_rfc3339()}),
        )
        .await
        .1;
    let protected_id = protected["id"].as_str().unwrap().to_owned();

    set(&owner, &org, 6, true).await;
    let upload = |bytes: &'static [u8]| {
        let form = Form::new().part("data", Part::bytes(bytes).file_name("2.a|b|c"));
        http()
            .post(&url)
            .bearer_auth(&member.token)
            .multipart(form)
            .send()
    };
    assert_eq!(upload(b"hello").await.unwrap().status().as_u16(), 400);
    assert_eq!(
        member
            .put(&format!("/sends/{protected_id}/remove-password"), json!({}))
            .await
            .0,
        400
    );
    // Deleting is what remains.
    assert_eq!(
        member
            .delete(&format!("/sends/{protected_id}"), json!({}))
            .await
            .0,
        200
    );

    // Off again, the announced file completes.
    set(&owner, &org, 6, false).await;
    assert_eq!(upload(b"hello").await.unwrap().status().as_u16(), 200);
    assert_eq!(member.get(&format!("/sends/{id}")).await.0, 200);
}
