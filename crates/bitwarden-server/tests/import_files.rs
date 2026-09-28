//! Files move with an account (ADR 0148): attachments and Sends from a
//! vaultwarden data folder, and a live account's attachments and text Sends,
//! byte for byte and still behind their passwords.
mod common;

use common::client::{encrypt, http, Account};
use common::vaultwarden::{
    fixture, write_files, ATTACHMENT, ATTACHMENT_BYTES, EMAIL, LOGIN, PASSWORD, SEND_FILE,
    SEND_FILE_BYTES, SEND_FILE_ID, SEND_PASSWORD_HASH, SEND_TEXT,
};
use common::Harness;
use opensesame_bitwarden_server::hashing::HashRegistry;
use opensesame_bitwarden_server::import::account::{self, AccountRequest, Answer, Ask, Challenge};
use opensesame_bitwarden_server::import::{self, vaultwarden, WriteOptions};
use opensesame_provider_bitwarden::Kdf;
use reqwest::multipart::{Form, Part};
use serde_json::{json, Value};

async fn grant(harness: &Harness, send_id: &str, password: Option<&str>) -> (u16, Value) {
    let access = base64_access(send_id);
    let mut form = vec![
        ("grant_type", "send_access"),
        ("client_id", "send"),
        ("scope", "api.send.access"),
        ("send_id", access.as_str()),
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

fn base64_access(id: &str) -> String {
    use base64::Engine as _;
    let uuid = uuid::Uuid::parse_str(id).unwrap();
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(uuid.as_bytes())
}

async fn send_file(harness: &Harness, token: &str, file_id: &str) -> Vec<u8> {
    let link: Value = http()
        .post(format!(
            "{}/api/sends/access/file/{file_id}",
            harness.http_url
        ))
        .bearer_auth(token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let url = link["url"]
        .as_str()
        .unwrap()
        .replace(&harness.https_url, &harness.http_url);
    http()
        .get(url)
        .send()
        .await
        .unwrap()
        .bytes()
        .await
        .unwrap()
        .to_vec()
}

#[tokio::test]
async fn a_vaultwarden_accounts_attachments_and_sends_move_with_their_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db.sqlite3");
    let keys = fixture(&path).await;
    write_files(&path, &keys).await;
    let source = vaultwarden::read(&path).await.unwrap();
    let target = Harness::start().await;
    let report = import::write(&target.db, &source, WriteOptions::default())
        .await
        .unwrap();
    assert_eq!(
        (report[0].attachments, report[0].sends),
        (1, 2),
        "{report:?}"
    );

    let user = target
        .db
        .bitwarden_user_by_email(EMAIL)
        .await
        .unwrap()
        .unwrap();
    let moved = target
        .db
        .bitwarden_attachment(&user.id, LOGIN, ATTACHMENT)
        .await
        .unwrap()
        .unwrap();
    assert!(moved.uploaded);
    assert_eq!(
        target.db.bitwarden_blob(ATTACHMENT).await.unwrap().unwrap(),
        ATTACHMENT_BYTES
    );

    // The text Send opens by its link; the file Send only with its password.
    assert_eq!(grant(&target, SEND_TEXT, None).await.0, 200);
    let (_, asked) = grant(&target, SEND_FILE, None).await;
    assert_eq!(
        asked["send_access_error_type"],
        "password_hash_b64_required"
    );
    let (status, token) = grant(&target, SEND_FILE, Some(SEND_PASSWORD_HASH)).await;
    assert_eq!(status, 200, "{token}");
    let token = token["access_token"].as_str().unwrap();
    assert_eq!(
        send_file(&target, token, SEND_FILE_ID).await,
        SEND_FILE_BYTES
    );
    let _ = PASSWORD;
}

#[tokio::test]
async fn a_missing_file_is_reported_and_costs_only_itself() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db.sqlite3");
    fixture(&path).await;
    // No data folder: the attachment's row arrives, its file does not.
    let source = vaultwarden::read(&path).await.unwrap();
    let target = Harness::start().await;
    let report = import::write(&target.db, &source, WriteOptions::default())
        .await
        .unwrap();
    assert_eq!(report[0].attachments, 0);
    assert_eq!(
        report[0].left_behind["attachments whose file could not be read"],
        1
    );
    assert_eq!(report[0].ciphers, 2);
}

struct Never;
impl Ask for Never {
    fn ask(&mut self, challenge: &Challenge) -> Option<Answer> {
        panic!("no challenge expected, got {challenge:?}")
    }
}

#[tokio::test]
async fn a_live_accounts_attachments_and_text_sends_move() {
    let light = Kdf::Argon2id {
        iterations: 2,
        memory_kib: 16 * 1024,
        parallelism: 1,
    };
    let old = Harness::start_plain().await;
    let person = Account::register(&old.http_url, "live-files@example.test", PASSWORD, light).await;
    let token = person.access_token(&old.http_url).await;
    let key = person.user_key();
    let call = |method: reqwest::Method, path: String, body: Value| {
        http()
            .request(method, format!("{}{path}", old.http_url))
            .bearer_auth(&token)
            .json(&body)
            .send()
    };
    let cipher: Value = call(
        reqwest::Method::POST,
        "/api/ciphers".into(),
        json!({"type": 2, "name": encrypt(&key, b"Doc"), "secureNote": {"type": 0}}),
    )
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    let cipher_id = cipher["id"].as_str().unwrap();
    let bytes = b"2.live-attachment-ciphertext".to_vec();
    let announced: Value = call(
        reqwest::Method::POST,
        format!("/api/ciphers/{cipher_id}/attachment/v2"),
        json!({"key": encrypt(&key, b"k"), "fileName": encrypt(&key, b"f.txt"), "fileSize": bytes.len()}),
    )
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    let uploaded = http()
        .post(announced["url"].as_str().unwrap())
        .bearer_auth(&token)
        .multipart(Form::new().part("data", Part::bytes(bytes.clone()).file_name("2.a|b|c")))
        .send()
        .await
        .unwrap();
    assert!(uploaded.status().is_success());
    let deletion = (chrono::Utc::now() + chrono::Duration::days(2)).to_rfc3339();
    for extra in [json!({}), json!({"password": "locked"})] {
        let mut body = json!({"type": 0, "name": encrypt(&key, b"s"), "key": encrypt(&key, b"k"),
                              "text": {"text": encrypt(&key, b"t"), "hidden": false},
                              "deletionDate": deletion});
        body.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        call(reqwest::Method::POST, "/api/sends".into(), body)
            .await
            .unwrap();
    }

    let source = account::read(
        &AccountRequest {
            server_url: &old.http_url,
            email: &person.email,
            master_password: PASSWORD.as_bytes(),
        },
        &HashRegistry::default(),
        &mut Never,
    )
    .await
    .unwrap();
    let new = Harness::start().await;
    let report = import::write(&new.db, &source, WriteOptions::default())
        .await
        .unwrap();
    assert_eq!(
        (report[0].attachments, report[0].sends),
        (1, 1),
        "{report:?}"
    );
    assert_eq!(report[0].left_behind["Sends with a password"], 1);
    let attachment_id = announced["attachmentId"].as_str().unwrap();
    assert_eq!(
        new.db.bitwarden_blob(attachment_id).await.unwrap().unwrap(),
        bytes
    );
}
