//! AT-CALLOUT-* / AT-NATS-SYSTEM against the pinned nats-server in
//! **config mode** (`authorization { auth_callout { … } }`); operator mode
//! is not exercised and not claimed.
//!
//! Run with:
//! `OPENSESAME_MTLS_FIXTURES=1 OPENSESAME_MTLS_BIN_NATS_SERVER=$(bash scripts/mtls-fixtures.sh path nats-server) \
//!  cargo +1.88.0 test -p opensesame-nats-callout --test live_callout -- --ignored --nocapture`
//!
//! Topology: nats-server (TLS client listener, testkit PKI) → in-process
//! bridge (nkey user in the AUTH account) → mock Host (an axum
//! `SecureListener` that requires the bridge's client certificate, records
//! every decision by request digest, and echoes the digest/user/server).

mod live_support;

use std::sync::Arc;
use std::time::Duration;

use futures::StreamExt as _;
use live_support::tokens::SHORT_TOKEN;
use live_support::*;
use opensesame_nats_callout::bridge::{BridgeCore, Outcome};
use opensesame_nats_callout::fixtures::Parties;
use opensesame_nats_callout::jwt::peek_claims;
use opensesame_nats_callout::response::ResponseClaims;

fn enabled() -> bool {
    std::env::var("OPENSESAME_MTLS_FIXTURES").as_deref() == Ok("1")
        && std::env::var("OPENSESAME_MTLS_BIN_NATS_SERVER").is_ok()
}

#[tokio::test]
#[ignore = "needs the pinned nats-server: OPENSESAME_MTLS_FIXTURES=1"]
async fn config_mode_callout_end_to_end() {
    if !enabled() {
        eprintln!("skipping: OPENSESAME_MTLS_FIXTURES/OPENSESAME_MTLS_BIN_NATS_SERVER not set");
        return;
    }
    let stack = Stack::start().await;

    // 1. A client with a valid upstream token is admitted with the Host's
    //    permissions and can use them.
    let (good, good_events) = stack
        .app_client(GOOD_TOKEN)
        .await
        .expect("good token admitted");
    good.publish("app.hello", "hi".into()).await.unwrap();
    good.flush().await.unwrap();
    assert_eq!(stack.host.calls(), 1, "one decision for one CONNECT");
    let first_digest = stack.host.digests()[0].clone();

    // 2. AT-NATS-SYSTEM: the admitted user cannot reach the auth subject or
    //    system subjects; no decision is made because of the attempt.
    let mut sys_sub = good.subscribe("$SYS.REQ.USER.AUTH").await.unwrap();
    good.publish("$SYS.REQ.USER.AUTH", "forged".into())
        .await
        .unwrap();
    good.publish("opensesame.events.system.x", "x".into())
        .await
        .unwrap();
    good.flush().await.unwrap();
    let violations = wait_for_permission_violations(&good_events, 2).await;
    assert!(
        violations >= 2,
        "expected subscribe+publish violations, saw {violations}"
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(300), sys_sub.next())
            .await
            .is_err(),
        "the app user must never receive a callout"
    );
    assert_eq!(stack.host.calls(), 1, "a denied publish makes no decision");

    // 3. A forged token is refused at CONNECT.
    let forged = stack.app_client(FORGED_TOKEN).await;
    assert!(forged.is_err(), "forged token must not connect");
    assert_eq!(stack.host.calls(), 2);
    assert_eq!(stack.host.denials(), 1);

    // 4. Replay: the exact request the server signed, handed to the bridge
    //    core twice, reaches the Host twice and yields the identical
    //    decision (same digest, same permissions, same expiry).
    let raw = stack.host.raw_requests()[0].clone();
    let core = stack.bridge_core();
    let now = chrono::Utc::now().timestamp();
    let a = reply_of(core.handle(raw.as_bytes(), None, now).await);
    let b = reply_of(core.handle(raw.as_bytes(), None, now + 1).await);
    assert_eq!(stack.host.calls(), 4);
    assert_eq!(
        a.user_jwt().map(user_permissions),
        b.user_jwt().map(user_permissions)
    );
    assert_eq!(stack.host.digests()[2], first_digest);
    assert_eq!(stack.host.digests()[3], first_digest);
    assert_eq!(
        stack.host.decisions_for(&first_digest),
        1,
        "one immutable decision per digest"
    );

    // 5. A short-lived user JWT: the server disconnects the client when it
    //    expires (receiver-enforced), which shows up as a reconnect and a
    //    fresh decision.
    let (short, short_events) = stack
        .app_client(SHORT_TOKEN)
        .await
        .expect("short token admitted");
    let calls_before = stack.host.calls();
    let disconnected = wait_for_disconnect(&short_events, Duration::from_secs(12)).await;
    assert!(
        disconnected,
        "server must disconnect the client at user JWT expiry"
    );
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(
        stack.host.calls() > calls_before,
        "reconnect triggers a new callout"
    );
    drop(short);
    drop(good);
    stack.stop().await;
}

fn reply_of(outcome: Outcome) -> ResponseClaims {
    match outcome {
        Outcome::Reply(bytes) => peek_claims(std::str::from_utf8(&bytes).unwrap()).unwrap(),
        Outcome::Dropped(err) => panic!("dropped: {err:?}"),
    }
}

fn user_permissions(jwt: &str) -> (Vec<String>, Vec<String>, i64) {
    let u: opensesame_nats_callout::response::UserClaims = peek_claims(jwt).unwrap();
    (
        u.publish_allow().to_vec(),
        u.subscribe_allow().to_vec(),
        u.exp,
    )
}

#[tokio::test]
#[ignore = "needs the pinned nats-server: OPENSESAME_MTLS_FIXTURES=1"]
async fn bridge_with_the_wrong_client_certificate_is_refused_by_the_host() {
    if !enabled() {
        return;
    }
    let stack = Stack::start().await;
    // AT-CALLOUT-BRIDGE at the mock Host: a worker-purpose certificate from
    // the same CA is not the bridge's identity.
    let core = stack.bridge_core_with_worker_certificate();
    let raw = {
        let (_c, _e) = stack.app_client(GOOD_TOKEN).await.expect("admitted");
        stack.host.raw_requests()[0].clone()
    };
    let now = chrono::Utc::now().timestamp();
    let resp = reply_of(core.handle(raw.as_bytes(), None, now).await);
    assert_eq!(
        resp.error(),
        Some("host_error"),
        "Host refused the worker certificate; bridge denied"
    );
    assert!(resp.user_jwt().is_none());
    stack.stop().await;
}

#[tokio::test]
#[ignore = "needs the pinned nats-server: OPENSESAME_MTLS_FIXTURES=1"]
async fn a_self_signed_server_envelope_is_refused_by_the_host() {
    if !enabled() {
        return;
    }
    let stack = Stack::start().await;
    // AT-CALLOUT-PROVENANCE: a well-formed `authorization_request` signed by
    // a server nkey this deployment never configured. The bridge in the live
    // stack pins nothing (it trusts the authenticated NATS connection it is
    // subscribed on), so the envelope reaches the Host — which pins the real
    // server's key and refuses it. A forged envelope cannot become an allow
    // by being laundered through the bridge.
    let forger = Parties::generate();
    let now = chrono::Utc::now().timestamp();
    let core = stack.bridge_core();

    // Addressed to some other deployment's callout account: the bridge does
    // not even forward it, and the Host is never called.
    let foreign = forger.signed_request(now, GOOD_TOKEN);
    assert!(matches!(
        core.handle(foreign.as_bytes(), None, now).await,
        Outcome::Dropped(_)
    ));
    assert_eq!(stack.host.calls(), 0);

    // Addressed to *this* callout account, so the bridge forwards it: the
    // Host pins the real server's key and refuses. A forged envelope cannot
    // become an allow by being laundered through the bridge.
    let mut claims = forger.request_claims(now, GOOD_TOKEN);
    claims.sub = stack.callout_account();
    let envelope = forger.sign_request(claims);
    let resp = reply_of(core.handle(envelope.as_bytes(), None, now).await);
    assert_eq!(resp.error(), Some("server_unknown"));
    assert!(resp.user_jwt().is_none());
    assert_eq!(stack.host.calls(), 1);
    assert_eq!(stack.host.denials(), 1);
    stack.stop().await;
}

/// Keep the shared `Arc<BridgeCore>` type in scope for the helpers.
#[allow(dead_code)]
type SharedCore = Arc<BridgeCore>;
