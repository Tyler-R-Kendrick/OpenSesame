//! Attachments and Sends without an oracle binary (ADR 0148): isolation,
//! limits, links that open one file only, and Send access rules. Runs in
//! ordinary CI; `bw_cli_oracle_files.rs` drives the same flows with `bw`.
mod common;

use chrono::{Duration, Utc};
use common::client::{encrypt, http, Account};
use common::Harness;
use opensesame_provider_bitwarden::Kdf;
use reqwest::multipart::{Form, Part};
use serde_json::{json, Value};

const LIGHT: Kdf = Kdf::Argon2id {
    iterations: 2,
    memory_kib: 16 * 1024,
    parallelism: 1,
};
const PASSWORD: &str = "a long enough master password";

struct Person {
    account: Account,
    token: String,
}

async fn person(harness: &Harness, email: &str) -> Person {
    let account = Account::register(&harness.http_url, email, PASSWORD, LIGHT).await;
    let token = account.access_token(&harness.http_url).await;
    Person { account, token }
}

impl Person {
    fn enc(&self, plain: &str) -> String {
        encrypt(&self.account.user_key(), plain.as_bytes())
    }

    async fn call(
        &self,
        harness: &Harness,
        method: &str,
        path: &str,
        body: Option<Value>,
    ) -> (u16, Value) {
        let url = format!("{}{path}", harness.http_url);
        let method = reqwest::Method::from_bytes(method.as_bytes()).unwrap();
        let mut request = http().request(method, url).bearer_auth(&self.token);
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().await.unwrap();
        let status = response.status().as_u16();
        (status, response.json().await.unwrap_or(Value::Null))
    }

    async fn upload(&self, url: &str, bytes: Vec<u8>) -> u16 {
        let form = Form::new().part("data", Part::bytes(bytes).file_name("2.a|b|c"));
        http()
            .post(url)
            .bearer_auth(&self.token)
            .multipart(form)
            .send()
            .await
            .unwrap()
            .status()
            .as_u16()
    }

    async fn note(&self, harness: &Harness) -> String {
        let body = json!({"type": 2, "name": self.enc("Note"), "secureNote": {"type": 0}});
        self.call(harness, "POST", "/api/ciphers", Some(body))
            .await
            .1["id"]
            .as_str()
            .unwrap()
            .to_owned()
    }
}

async fn fetch(url: &str) -> (u16, Vec<u8>) {
    let response = http().get(url).send().await.unwrap();
    (
        response.status().as_u16(),
        response.bytes().await.unwrap().to_vec(),
    )
}

#[tokio::test]
async fn an_attachment_is_its_owners_and_a_link_opens_that_file_only() {
    let harness = Harness::start().await;
    let alice = person(&harness, "alice-files@example.test").await;
    let bob = person(&harness, "bob-files@example.test").await;
    let cipher = alice.note(&harness).await;
    let announce = json!({"key": alice.enc("k"), "fileName": alice.enc("a.txt"), "fileSize": 5});
    let path = format!("/api/ciphers/{cipher}/attachment/v2");

    // Bob cannot attach to Alice's cipher.
    assert_eq!(
        bob.call(&harness, "POST", &path, Some(announce.clone()))
            .await
            .0,
        404
    );
    // A plaintext name is refused; so is a file past the limit.
    let plain = json!({"key": alice.enc("k"), "fileName": "a.txt", "fileSize": 5});
    assert_eq!(
        alice.call(&harness, "POST", &path, Some(plain)).await.0,
        400
    );
    let huge = json!({"key": alice.enc("k"), "fileName": alice.enc("a"), "fileSize": 1_i64 << 40});
    assert_eq!(alice.call(&harness, "POST", &path, Some(huge)).await.0, 400);

    let (_, upload) = alice.call(&harness, "POST", &path, Some(announce)).await;
    // Links name the public (HTTPS) URL; the test speaks the plain listener.
    let plain = |url: &str| url.replace(&harness.https_url, &harness.http_url);
    let url = plain(upload["url"].as_str().unwrap());
    assert_eq!(bob.upload(&url, b"hello".to_vec()).await, 404);
    assert_eq!(alice.upload(&url, Vec::new()).await, 400);
    assert_eq!(alice.upload(&url, b"hello".to_vec()).await, 200);
    assert_eq!(alice.upload(&url, b"again".to_vec()).await, 400);

    let id = upload["attachmentId"].as_str().unwrap();
    let (_, described) = alice
        .call(
            &harness,
            "GET",
            &format!("/api/ciphers/{cipher}/attachment/{id}"),
            None,
        )
        .await;
    let link = &plain(described["url"].as_str().unwrap());
    assert_eq!(fetch(link).await, (200, b"hello".to_vec()));
    // The link's token opens this file, not another, and not without it.
    assert_eq!(fetch(&link.replace(id, "someotherfile")).await.0, 404);
    assert_eq!(fetch(link.split('?').next().unwrap()).await.0, 400);
    assert_eq!(
        bob.call(
            &harness,
            "GET",
            &format!("/api/ciphers/{cipher}/attachment/{id}"),
            None
        )
        .await
        .0,
        404
    );

    // Deleting the cipher takes the file's bytes with it.
    alice
        .call(&harness, "DELETE", &format!("/api/ciphers/{cipher}"), None)
        .await;
    assert!(harness.db.bitwarden_blob(id).await.unwrap().is_none());
}

#[tokio::test]
async fn the_storage_quota_counts_attachments_and_sends_together() {
    let harness = Harness::start_with(|mut config| {
        config.storage_quota_bytes = 10;
        config
    })
    .await;
    let alice = person(&harness, "quota@example.test").await;
    let cipher = alice.note(&harness).await;
    let path = format!("/api/ciphers/{cipher}/attachment/v2");
    let announce =
        |size: i64| json!({"key": alice.enc("k"), "fileName": alice.enc("f"), "fileSize": size});
    assert_eq!(
        alice
            .call(&harness, "POST", &path, Some(announce(8)))
            .await
            .0,
        200
    );
    assert_eq!(
        alice
            .call(&harness, "POST", &path, Some(announce(3)))
            .await
            .0,
        400
    );
}

fn text_send(person: &Person, extra: &Value) -> Value {
    let mut body = json!({
        "type": 0,
        "name": person.enc("Wifi"),
        "key": person.enc("send key"),
        "text": {"text": person.enc("hunter2"), "hidden": true},
        "deletionDate": (Utc::now() + Duration::days(7)).to_rfc3339(),
        "disabled": false,
    });
    if let (Some(target), Some(extra)) = (body.as_object_mut(), extra.as_object()) {
        target.extend(extra.clone());
    }
    body
}

async fn grant(harness: &Harness, access_id: &str, password: Option<&str>) -> (u16, Value) {
    let mut form = vec![
        ("grant_type", "send_access"),
        ("client_id", "send"),
        ("scope", "api.send.access"),
        ("send_id", access_id),
    ];
    if let Some(password) = password {
        form.push(("password_hash_b64", password));
    }
    let response = http()
        .post(format!("{}/identity/connect/token", harness.http_url))
        .form(&form)
        .send()
        .await
        .unwrap();
    (response.status().as_u16(), response.json().await.unwrap())
}

async fn access(harness: &Harness, token: &str) -> u16 {
    http()
        .post(format!("{}/api/sends/access", harness.http_url))
        .bearer_auth(token)
        .send()
        .await
        .unwrap()
        .status()
        .as_u16()
}

#[tokio::test]
async fn a_send_opens_only_while_enabled_unexpired_and_under_its_limit() {
    let harness = Harness::start().await;
    let alice = person(&harness, "sender-rules@example.test").await;
    let far = json!({"deletionDate": (Utc::now() + Duration::days(40)).to_rfc3339()});
    assert_eq!(
        alice
            .call(
                &harness,
                "POST",
                "/api/sends",
                Some(text_send(&alice, &far))
            )
            .await
            .0,
        400
    );

    let (_, once) = alice
        .call(
            &harness,
            "POST",
            "/api/sends",
            Some(text_send(&alice, &json!({"maxAccessCount": 1}))),
        )
        .await;
    let access_id = once["accessId"].as_str().unwrap();
    let (status, token) = grant(&harness, access_id, None).await;
    assert_eq!(status, 200, "{token}");
    let token = token["access_token"].as_str().unwrap();
    assert_eq!(access(&harness, token).await, 200);
    assert_eq!(access(&harness, token).await, 404);
    assert_eq!(
        grant(&harness, access_id, None).await.1["send_access_error_type"],
        "send_id_invalid"
    );

    let (_, off) = alice
        .call(
            &harness,
            "POST",
            "/api/sends",
            Some(text_send(&alice, &json!({"disabled": true}))),
        )
        .await;
    assert_eq!(
        grant(&harness, off["accessId"].as_str().unwrap(), None)
            .await
            .0,
        400
    );
    let expired = json!({"expirationDate": (Utc::now() - Duration::minutes(1)).to_rfc3339()});
    let (_, old) = alice
        .call(
            &harness,
            "POST",
            "/api/sends",
            Some(text_send(&alice, &expired)),
        )
        .await;
    assert_eq!(
        grant(&harness, old["accessId"].as_str().unwrap(), None)
            .await
            .0,
        400
    );
    assert_eq!(grant(&harness, "not-an-access-id", None).await.0, 400);
}

#[tokio::test]
async fn a_sends_password_is_asked_for_and_checked() {
    let harness = Harness::start().await;
    let alice = person(&harness, "sender-password@example.test").await;
    let (_, locked) = alice
        .call(
            &harness,
            "POST",
            "/api/sends",
            Some(text_send(&alice, &json!({"password": "client-hash"}))),
        )
        .await;
    assert_eq!(locked["password"], "set");
    let access_id = locked["accessId"].as_str().unwrap();
    let (_, asked) = grant(&harness, access_id, None).await;
    assert_eq!(asked["error"], "invalid_request");
    assert_eq!(
        asked["send_access_error_type"],
        "password_hash_b64_required"
    );
    let (_, wrong) = grant(&harness, access_id, Some("nope")).await;
    assert_eq!(wrong["send_access_error_type"], "password_hash_b64_invalid");
    assert_eq!(grant(&harness, access_id, Some("client-hash")).await.0, 200);

    // The older access route asks the same question its own way.
    let old = |body: Value| {
        http()
            .post(format!("{}/api/sends/access/{access_id}", harness.http_url))
            .json(&body)
            .send()
    };
    assert_eq!(old(json!({})).await.unwrap().status().as_u16(), 401);
    assert_eq!(
        old(json!({"password": "nope"}))
            .await
            .unwrap()
            .status()
            .as_u16(),
        400
    );
    assert_eq!(
        old(json!({"password": "client-hash"}))
            .await
            .unwrap()
            .status()
            .as_u16(),
        200
    );

    // Removing the password opens it to the link alone.
    let id = locked["id"].as_str().unwrap();
    alice
        .call(
            &harness,
            "PUT",
            &format!("/api/sends/{id}/remove-password"),
            None,
        )
        .await;
    assert_eq!(grant(&harness, access_id, None).await.0, 200);
    // And nobody else can edit or delete it.
    let bob = person(&harness, "not-the-sender@example.test").await;
    assert_eq!(
        bob.call(&harness, "DELETE", &format!("/api/sends/{id}"), None)
            .await
            .0,
        404
    );
}
