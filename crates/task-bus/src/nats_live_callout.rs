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
    i64::try_from(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_secs(),
    )
    .expect("seconds since the epoch fit in i64")
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
    encode_jwt(
        issuer,
        &json!({
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
        }),
    )
}

fn response_jwt(
    issuer: &nkeys::KeyPair,
    server_id: &str,
    user_nkey: &str,
    inner: Result<String, &str>,
) -> String {
    let iat = now();
    let nats = match inner {
        Ok(jwt) => json!({"jwt": jwt, "type": "authorization_response", "version": 2}),
        Err(error) => json!({"error": error, "type": "authorization_response", "version": 2}),
    };
    encode_jwt(
        issuer,
        &json!({
            "jti": format!("r{iat:x}{}", &user_nkey[1..7]),
            "iat": iat,
            "iss": issuer.public_key(),
            "aud": server_id,
            "sub": user_nkey,
            "nats": nats
        }),
    )
}

/// One `$SYS.REQ.USER.AUTH` round trip: read the server-signed request,
/// answer with a response JWT bound to that server id and user key.
fn answer(issuer: &nkeys::KeyPair, request: &Value, admit: bool) -> (String, String) {
    let server_id = request["nats"]["server_id"]["id"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let user_nkey = request["nats"]["user_nkey"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let inner = if admit {
        Ok(user_jwt(issuer, &user_nkey, now() + 5))
    } else {
        Err("denied by test policy")
    };
    (
        response_jwt(issuer, &server_id, &user_nkey, inner),
        user_nkey,
    )
}

/// Serve `$SYS.REQ.USER.AUTH` until the subscription ends: admit the
/// expected nkey once, deny everything after (so the reconnect that
/// follows the expiry is refused and stays refused).
async fn serve(
    mut requests: async_nats::Subscriber,
    client: async_nats::Client,
    issuer: nkeys::KeyPair,
    expected: String,
    served: Arc<AtomicUsize>,
) {
    while let Some(msg) = requests.next().await {
        let request = decode_claims(std::str::from_utf8(&msg.payload).expect("utf8"));
        let presented = request["nats"]["connect_opts"]["nkey"]
            .as_str()
            .unwrap_or_default();
        let n = served.fetch_add(1, Ordering::SeqCst);
        let admit = presented == expected && n == 0;
        let (reply, _user) = answer(&issuer, &request, admit);
        let Some(to) = msg.reply else { continue };
        let _ = client.publish(to, reply.into()).await;
    }
}

/// Connect the callout responder (a static AUTH user) and serve auth
/// requests in the background for the lifetime of the test.
async fn start_responder(
    pki: &Pki,
    roles: &Roles,
    url: &str,
    issuer: nkeys::KeyPair,
    expected: String,
    admissions: Arc<AtomicUsize>,
) {
    let leaf = pki.client("callout.nats.opensesame.test");
    let spec = pki
        .client_spec(Some(&leaf), Some(&roles.callout.0), true)
        .normalized(url)
        .expect("spec");
    let responder = crate::nats_connect::connect_options(
        &spec,
        NatsRole::Callout,
        &InjectedMaterial::default(),
        Arc::new(BusHealth::default()),
    )
    .await
    .expect("responder options")
    .connect(url)
    .await
    .expect("responder connects");
    let requests = responder
        .subscribe("$SYS.REQ.USER.AUTH")
        .await
        .expect("subscribe auth requests");
    tokio::spawn(serve(requests, responder, issuer, expected, admissions));
}

/// A TLS-first client with a certificate and an nkey, admitted (or not) by
/// the callout. Returns the connect result so the caller can report the log.
async fn connect_as(
    pki: &Pki,
    url: &str,
    san: &str,
    seed: &str,
    health: Arc<BusHealth>,
) -> Result<async_nats::Client, async_nats::ConnectError> {
    let leaf = pki.client(san);
    let spec = pki
        .client_spec(Some(&leaf), Some(seed), true)
        .normalized(url)
        .expect("spec");
    crate::nats_connect::connect_options(
        &spec,
        NatsRole::Publisher,
        &InjectedMaterial::default(),
        health,
    )
    .await
    .expect("client options")
    .connect(url)
    .await
}

/// A callout-issued JWT with `exp` 5 s ahead: the client is admitted,
/// publishes, and is disconnected by the server when `exp` passes; its
/// reconnect is answered with a denial and it stays out.
#[tokio::test]
#[ignore = "requires OPENSESAME_MTLS_FIXTURES=1"]
async fn callout_issued_jwt_expiry_is_enforced_by_disconnect() {
    if !super::live_harness::enabled() {
        return;
    }
    let pki = Pki::new();
    let roles = Roles::new();
    let issuer = nkeys::KeyPair::new_account();
    let port = free_port();
    let mut env = roles.env(&pki, port);
    env.push(("OPENSESAME_NATS_CALLOUT_ISSUER", issuer.public_key()));
    let server = Server::start("secure-callout.conf", &env);
    let url = server.url();

    // Responder: a static AUTH-account user answering $SYS.REQ.USER.AUTH.
    let admissions = Arc::new(AtomicUsize::new(0));
    let (alice_seed, alice_pub) = super::live_harness::user_nkey();
    start_responder(
        &pki,
        &roles,
        &url,
        issuer,
        alice_pub,
        Arc::clone(&admissions),
    )
    .await;

    // Alice: TLS-first, client certificate, nkey; admitted through callout.
    let health = Arc::new(BusHealth::default());
    let alice = Box::pin(connect_as(
        &pki,
        &url,
        "alice.nats.opensesame.test",
        &alice_seed,
        Arc::clone(&health),
    ))
    .await
    .unwrap_or_else(|e| {
        panic!(
            "alice admitted by the callout: {e}\nserver log:\n{}",
            server.log_text()
        )
    });
    assert_eq!(admissions.load(Ordering::SeqCst), 1);
    alice
        .publish("opensesame.events.test", "hello".into())
        .await
        .expect("publish");
    alice.flush().await.expect("flush");
    let admitted_at = std::time::Instant::now();

    // Still connected well before exp.
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert_eq!(
        health.disconnects(),
        0,
        "must not be disconnected before exp"
    );
    alice
        .publish("opensesame.events.test", "still-here".into())
        .await
        .expect("publish before exp");
    alice.flush().await.expect("flush");

    // The server closes the connection once exp passes.
    let deadline = std::time::Instant::now() + Duration::from_secs(12);
    while health.disconnects() == 0 && std::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let elapsed = admitted_at.elapsed();
    assert!(
        health.disconnects() >= 1,
        "server did not disconnect after exp; log:\n{}",
        server.log_text()
    );
    assert!(
        elapsed >= Duration::from_secs(4),
        "disconnected too early: {elapsed:?}"
    );
    assert!(
        server.wait_log("Expired", Duration::from_secs(2)),
        "server log should name the expiry:\n{}",
        server.log_text()
    );

    // The reconnect went through the callout again and was denied.
    tokio::time::sleep(Duration::from_secs(3)).await;
    assert!(
        admissions.load(Ordering::SeqCst) >= 2,
        "reconnect must re-run the callout"
    );
    assert_ne!(
        alice.connection_state(),
        async_nats::connection::State::Connected
    );
    let last = health.last_event().unwrap_or_default();
    assert!(
        last.contains("authorization_violation")
            || last.contains("disconnected")
            || last.contains("max_reconnects"),
        "{last}"
    );
}
