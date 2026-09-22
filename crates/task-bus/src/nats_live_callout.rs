//! AT-NATS-LIVEEXPIRY on the callout profile: the server enforces the
//! `exp` of a callout-issued user JWT by disconnecting the live client.
//!
//! The responder here is a minimal test double for the bridge SW-CALLOUT
//! ships (`crates/nats-callout`); it exists only to issue a short-lived
//! user JWT and observe the server. It verifies nothing about the user —
//! that is the production bridge's job, not this test's claim.

use super::live_harness::{free_port, Pki, Roles, Server};
use super::*;
use base64::Engine;
use futures::StreamExt;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::URL_SAFE_NO_PAD;

fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).expect("clock").as_secs() as i64
}

/// Encode `claims` as an `ed25519-nkey` JWT signed by `kp`.
fn encode_jwt(kp: &nkeys::KeyPair, claims: &Value) -> String {
    let header = B64.encode(br#"{"typ":"JWT","alg":"ed25519-nkey"}"#);
    let payload = B64.encode(serde_json::to_vec(claims).expect("claims"));
    let signing = format!("{header}.{payload}");
    let sig = kp.sign(signing.as_bytes()).expect("sign");
    format!("{signing}.{}", B64.encode(sig))
}

fn decode_claims(jwt: &str) -> Value {
    let payload = jwt.split('.').nth(1).expect("payload");
    serde_json::from_slice(&B64.decode(payload).expect("b64")).expect("json")
}

fn user_jwt(issuer: &nkeys::KeyPair, user_nkey: &str, exp: i64) -> String {
    let iat = now();
    encode_jwt(issuer, &json!({
        "jti": format!("u{iat:x}{}", &user_nkey[1..7]),
        "iat": iat,
        "iss": issuer.public_key(),
        "sub": user_nkey,
        "name": "alice",
        "aud": "OPENSESAME",
        "exp": exp,
        "nats": {
            "pub": {"allow": ["opensesame.events.>"]},
            "sub": {"allow": ["_INBOX.>"]},
            "subs": -1, "data": -1, "payload": -1,
            "type": "user", "version": 2
        }
    }))
}

fn response_jwt(issuer: &nkeys::KeyPair, server_id: &str, user_nkey: &str, inner: Result<String, &str>) -> String {
    let iat = now();
    let nats = match inner {
        Ok(jwt) => json!({"jwt": jwt, "type": "authorization_response", "version": 2}),
        Err(error) => json!({"error": error, "type": "authorization_response", "version": 2}),
    };
    encode_jwt(issuer, &json!({
        "jti": format!("r{iat:x}{}", &user_nkey[1..7]),
        "iat": iat,
        "iss": issuer.public_key(),
        "aud": server_id,
        "sub": user_nkey,
        "nats": nats
    }))
}

/// A callout-issued JWT with `exp` 5 s ahead: the client is admitted,
/// publishes, and is disconnected by the server when `exp` passes; its
/// reconnect is answered with a denial and it stays out.
#[tokio::test]
#[ignore = "requires OPENSESAME_MTLS_FIXTURES=1"]
async fn callout_issued_jwt_expiry_is_enforced_by_disconnect() {
    if !super::live_harness::enabled() { return; }
    let pki = Pki::new();
    let roles = Roles::new();
    let issuer = nkeys::KeyPair::new_account();
    let port = free_port();
    let mut env = roles.env(&pki, port);
    env.push(("OPENSESAME_NATS_CALLOUT_ISSUER", issuer.public_key()));
    let server = Server::start("secure-callout.conf", &env);
    let url = server.url();

    // Responder: a static AUTH-account user answering $SYS.REQ.USER.AUTH.
    let responder_leaf = pki.client("callout.nats.opensesame.test");
    let responder_spec = pki.client_spec(Some(&responder_leaf), Some(&roles.callout.0), true).normalized(&url).expect("spec");
    let responder = crate::nats_connect::connect_options(&responder_spec, NatsRole::Callout, &InjectedMaterial::default(), Arc::new(BusHealth::default()))
        .await
        .expect("responder options")
        .connect(&url)
        .await
        .expect("responder connects");
    let mut requests = responder.subscribe("$SYS.REQ.USER.AUTH").await.expect("subscribe auth requests");
    let served = Arc::new(AtomicUsize::new(0));
    let served_task = Arc::clone(&served);
    let responder_client = responder.clone();
    let (alice_seed, alice_pub) = super::live_harness::user_nkey();
    let alice_expected = alice_pub.clone();
    tokio::spawn(async move {
        while let Some(msg) = requests.next().await {
            let request = decode_claims(std::str::from_utf8(&msg.payload).expect("utf8"));
            let server_id = request["nats"]["server_id"]["id"].as_str().unwrap_or_default().to_owned();
            let user_nkey = request["nats"]["user_nkey"].as_str().unwrap_or_default().to_owned();
            let presented = request["nats"]["connect_opts"]["nkey"].as_str().unwrap_or_default();
            let n = served_task.fetch_add(1, Ordering::SeqCst);
            let inner = if presented == alice_expected && n == 0 {
                Ok(user_jwt(&issuer, &user_nkey, now() + 5))
            } else {
                Err("denied by test policy")
            };
            let reply = response_jwt(&issuer, &server_id, &user_nkey, inner);
            if let Some(to) = msg.reply {
                let _ = responder_client.publish(to, reply.into()).await;
            }
        }
    });

    // Alice: TLS-first, client certificate, nkey; admitted through callout.
    let alice_leaf = pki.client("alice.nats.opensesame.test");
    let alice_spec = pki.client_spec(Some(&alice_leaf), Some(&alice_seed), true).normalized(&url).expect("spec");
    let health = Arc::new(BusHealth::default());
    let alice = crate::nats_connect::connect_options(&alice_spec, NatsRole::Publisher, &InjectedMaterial::default(), Arc::clone(&health))
        .await
        .expect("alice options")
        .connect(&url)
        .await
        .expect("alice admitted by the callout");
    assert_eq!(served.load(Ordering::SeqCst), 1);
    alice.publish("opensesame.events.test", "hello".into()).await.expect("publish");
    alice.flush().await.expect("flush");
    let admitted_at = std::time::Instant::now();

    // Still connected well before exp.
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert_eq!(health.disconnects(), 0, "must not be disconnected before exp");
    alice.publish("opensesame.events.test", "still-here".into()).await.expect("publish before exp");
    alice.flush().await.expect("flush");

    // The server closes the connection once exp passes.
    let deadline = std::time::Instant::now() + Duration::from_secs(12);
    while health.disconnects() == 0 && std::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let elapsed = admitted_at.elapsed();
    assert!(health.disconnects() >= 1, "server did not disconnect after exp; log:\n{}", server.log_text());
    assert!(elapsed >= Duration::from_secs(4), "disconnected too early: {elapsed:?}");
    assert!(server.wait_log("Expired", Duration::from_secs(2)), "server log should name the expiry:\n{}", server.log_text());

    // The reconnect went through the callout again and was denied.
    tokio::time::sleep(Duration::from_secs(3)).await;
    assert!(served.load(Ordering::SeqCst) >= 2, "reconnect must re-run the callout");
    assert_ne!(alice.connection_state(), async_nats::connection::State::Connected);
    let last = health.last_event().unwrap_or_default();
    assert!(last.contains("authorization_violation") || last.contains("disconnected") || last.contains("max_reconnects"), "{last}");
}
