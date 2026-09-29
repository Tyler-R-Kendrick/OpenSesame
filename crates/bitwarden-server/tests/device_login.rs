//! "Log in with device" (ADR 0148 §8), in process: a device without the
//! master password asks, the account's signed-in device hears it on the
//! hub and approves by wrapping the user key to the asking device, which
//! hears the answer on the anonymous hub, unwraps the key, and signs in with
//! its access code — once.
mod common;

use aws_lc_rs::encoding::{AsDer, PublicKeyX509Der};
use aws_lc_rs::rsa::{KeySize, OaepPrivateDecryptingKey, PrivateDecryptingKey, OAEP_SHA1_MGF1SHA1};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use common::client::http;
use common::orgs::{account, rsa_wrap};
use common::Harness;
use futures::StreamExt as _;
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::Message;

const CODE: &str = "4f9Q2xK7mP1rT8vW3yZ6aB0cD";

struct Asker {
    private: PrivateDecryptingKey,
    public_b64: String,
}

fn asker() -> Asker {
    let private = PrivateDecryptingKey::generate(KeySize::Rsa2048).unwrap();
    let public: PublicKeyX509Der = private.public_key().as_der().unwrap();
    Asker {
        public_b64: B64.encode(public.as_ref()),
        private,
    }
}

impl Asker {
    fn unwrap(&self, wrapped: &str) -> Vec<u8> {
        let sealed = B64.decode(wrapped.strip_prefix("4.").unwrap()).unwrap();
        let key = OaepPrivateDecryptingKey::new(self.private.clone()).unwrap();
        let mut out = vec![0u8; key.min_output_size()];
        key.decrypt(&OAEP_SHA1_MGF1SHA1, &sealed, &mut out, None)
            .unwrap()
            .to_vec()
    }
}

async fn ask(harness: &Harness, email: &str, public: &str) -> (u16, Value) {
    let response = http()
        .post(format!("{}/api/auth-requests", harness.http_url))
        .header("Device-Type", "10")
        .json(
            &json!({"email": email, "publicKey": public, "deviceIdentifier": "new-laptop",
                      "accessCode": CODE, "type": 0}),
        )
        .send()
        .await
        .unwrap();
    let status = response.status().as_u16();
    (status, response.json().await.unwrap_or(Value::Null))
}

async fn fetch(harness: &Harness, id: &str, code: &str) -> (u16, Value) {
    let response = http()
        .get(format!(
            "{}/api/auth-requests/{id}/response?code={code}",
            harness.http_url
        ))
        .send()
        .await
        .unwrap();
    let status = response.status().as_u16();
    (status, response.json().await.unwrap_or(Value::Null))
}

async fn sign_in(harness: &Harness, email: &str, id: &str) -> Value {
    http()
        .post(format!("{}/identity/connect/token", harness.http_url))
        .form(&[
            ("grant_type", "password"),
            ("username", email),
            ("password", CODE),
            ("authRequest", id),
            ("scope", "api offline_access"),
            ("client_id", "web"),
            ("deviceType", "10"),
            ("deviceIdentifier", "new-laptop"),
            ("deviceName", "firefox"),
        ])
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap()
}

type Socket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn socket(harness: &Harness, path: &str) -> Socket {
    let url = format!("{}{path}", harness.http_url.replacen("http", "ws", 1));
    tokio_tungstenite::connect_async(url).await.unwrap().0
}

async fn heard(socket: &mut Socket, needle: &[u8]) -> bool {
    let deadline = std::time::Duration::from_secs(10);
    while let Ok(Some(Ok(message))) = tokio::time::timeout(deadline, socket.next()).await {
        if let Message::Binary(data) = message {
            if data.windows(needle.len()).any(|w| w == needle) {
                return true;
            }
        }
    }
    false
}

#[tokio::test]
async fn an_approved_device_unwraps_the_key_and_signs_in_once() {
    let harness = Harness::start().await;
    let (account, api) = account(&harness, "me@example.com").await;
    let mut approver_hub = socket(
        &harness,
        &format!("/notifications/hub?access_token={}", api.token),
    )
    .await;
    let asker = asker();

    let (status, request) = ask(&harness, "me@example.com", &asker.public_b64).await;
    assert_eq!(status, 200, "{request}");
    let id = request["id"].as_str().unwrap().to_owned();
    assert!(
        heard(&mut approver_hub, b"\xa4Type\x0f").await,
        "the hub announces the request"
    );
    let mut waiting = socket(
        &harness,
        &format!("/notifications/anonymous-hub?Token={id}"),
    )
    .await;

    let pending = api.ok("GET", "/auth-requests/pending", None).await;
    assert_eq!(pending["data"][0]["id"], id.as_str());
    assert_eq!(pending["data"][0]["requestDeviceType"], "Firefox");
    // Not before approval.
    assert!(sign_in(&harness, "me@example.com", &id)
        .await
        .get("access_token")
        .is_none());

    let key = rsa_wrap(&asker.public_b64, account.user_key_bytes());
    api.ok(
        "PUT",
        &format!("/auth-requests/{id}"),
        Some(
            json!({"key": key, "masterPasswordHash": null, "deviceIdentifier": "old-phone",
                    "requestApproved": true}),
        ),
    )
    .await;
    assert!(heard(&mut waiting, b"AuthRequestResponseRecieved").await);

    assert_eq!(fetch(&harness, &id, "not-the-code-at-all").await.0, 404);
    let (status, answer) = fetch(&harness, &id, CODE).await;
    assert_eq!(status, 200);
    assert_eq!(answer["requestApproved"], true);
    assert_eq!(
        asker.unwrap(answer["key"].as_str().unwrap()),
        account.user_key_bytes()
    );

    let signed_in = sign_in(&harness, "me@example.com", &id).await;
    assert!(signed_in["access_token"].is_string(), "{signed_in}");
    assert!(
        sign_in(&harness, "me@example.com", &id)
            .await
            .get("access_token")
            .is_none(),
        "spent"
    );
}

#[tokio::test]
async fn a_denied_or_unknown_request_opens_nothing() {
    let harness = Harness::start().await;
    let (_, api) = account(&harness, "me@example.com").await;
    let (_, stranger) = account(&harness, "stranger@example.com").await;
    let asker = asker();

    // An address with no account gets an answer that looks the same.
    let (status, ghost) = ask(&harness, "nobody@example.com", &asker.public_b64).await;
    assert_eq!(status, 200);
    assert_eq!(
        fetch(&harness, ghost["id"].as_str().unwrap(), CODE).await.0,
        404
    );

    let (_, request) = ask(&harness, "me@example.com", &asker.public_b64).await;
    let id = request["id"].as_str().unwrap();
    assert_eq!(stranger.get(&format!("/auth-requests/{id}")).await.0, 404);
    assert_eq!(
        stranger
            .put(
                &format!("/auth-requests/{id}"),
                json!({"key": "4.eA==", "requestApproved": true})
            )
            .await
            .0,
        404
    );
    api.ok(
        "PUT",
        &format!("/auth-requests/{id}"),
        Some(json!({"requestApproved": false, "deviceIdentifier": "old-phone"})),
    )
    .await;
    assert_eq!(fetch(&harness, id, CODE).await.0, 404);
    assert!(sign_in(&harness, "me@example.com", id)
        .await
        .get("access_token")
        .is_none());

    // At most five unanswered requests at once.
    for _ in 0..5 {
        assert_eq!(
            ask(&harness, "me@example.com", &asker.public_b64).await.0,
            200
        );
    }
    assert_eq!(
        ask(&harness, "me@example.com", &asker.public_b64).await.0,
        429
    );
}
