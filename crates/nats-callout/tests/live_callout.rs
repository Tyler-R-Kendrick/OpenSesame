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
use live_support::*;
use opensesame_nats_callout::bridge::{BridgeCore, Outcome};
use opensesame_nats_callout::fixtures::Parties;
use opensesame_nats_callout::jwt::peek_claims;
use opensesame_nats_callout::response::ResponseClaims;
use opensesame_nats_callout::xkey::{is_sealed, CalloutXKey};
use opensesame_nats_callout::CalloutError;

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

/// AT-CALLOUT-XKEY: with `auth_callout.xkey` set on the real server, the
/// whole callout runs sealed — and still admits, denies and binds decisions
/// to digests exactly as the bare path does.
#[tokio::test]
#[ignore = "needs the pinned nats-server: OPENSESAME_MTLS_FIXTURES=1"]
async fn xkey_sealed_callout_end_to_end() {
    if !enabled() {
        eprintln!("skipping: OPENSESAME_MTLS_FIXTURES/OPENSESAME_MTLS_BIN_NATS_SERVER not set");
        return;
    }
    let stack = Stack::start_sealed().await;

    // A valid upstream token is admitted across the sealed envelope, and what
    // reached the protected subject really was an `xkv1` box carrying the
    // server's xkey header.
    let (good, _events) = stack
        .app_client(GOOD_TOKEN)
        .await
        .expect("good token admitted over the sealed path");
    good.publish("app.hello", "hi".into()).await.unwrap();
    good.flush().await.unwrap();
    assert_eq!(stack.host.calls(), 1, "one decision for one CONNECT");
    let envelope = first_envelope(&stack).await;
    assert!(
        is_sealed(&envelope.payload),
        "the server sealed the request"
    );
    let server_xkey = envelope
        .server_xkey_header
        .as_deref()
        .expect("Nats-Server-Xkey header");

    // The reply travels sealed too: re-handling the exact envelope the server
    // sent yields an `xkv1` box back to the server's key, never a bare JWT on
    // a subject a leaked subscription could read.
    let now = chrono::Utc::now().timestamp();
    let calls_before = stack.host.calls();
    let reply = match stack
        .bridge_core_with_xkey()
        .handle(&envelope.payload, Some(server_xkey), now)
        .await
    {
        Outcome::Reply(bytes) => bytes,
        Outcome::Dropped(err) => panic!("sealed request dropped: {err:?}"),
    };
    assert!(
        is_sealed(&reply),
        "the reply must be sealed back to the server"
    );
    assert_eq!(
        stack.host.calls(),
        calls_before + 1,
        "the Host independently re-verified the replayed request"
    );

    // A forged token is refused across the sealed path just the same.
    let forged = stack.app_client(FORGED_TOKEN).await;
    assert!(forged.is_err(), "forged token must not connect");
    assert_eq!(stack.host.calls(), calls_before + 2);
    assert_eq!(stack.host.denials(), 1);
    drop(good);
    stack.stop().await;
}

/// AT-CALLOUT-XKEY: the sealed envelope the real server produced opens only
/// under the configured callout xkey. Every wrong key, missing header or
/// lying header is a typed refusal — never a fallback to reading the box as
/// bare text.
#[tokio::test]
#[ignore = "needs the pinned nats-server: OPENSESAME_MTLS_FIXTURES=1"]
async fn a_live_sealed_envelope_opens_only_under_the_configured_xkey() {
    if !enabled() {
        eprintln!("skipping: OPENSESAME_MTLS_FIXTURES/OPENSESAME_MTLS_BIN_NATS_SERVER not set");
        return;
    }
    let stack = Stack::start_sealed().await;
    let (_c, _e) = stack.app_client(GOOD_TOKEN).await.expect("admitted");
    let envelope = first_envelope(&stack).await;
    let server_xkey = envelope
        .server_xkey_header
        .as_deref()
        .expect("Nats-Server-Xkey header");
    let now = chrono::Utc::now().timestamp();
    let calls_before = stack.host.calls();

    // A bridge with no xkey must not read a sealed envelope as bare text.
    let dropped = stack
        .bridge_core()
        .handle(&envelope.payload, Some(server_xkey), now)
        .await;
    assert!(
        matches!(dropped, Outcome::Dropped(CalloutError::XkeyRequired)),
        "a sealed envelope without an xkey must be dropped: {dropped:?}"
    );

    // An unrelated callout xkey does not open the box.
    let dropped = stack
        .bridge_core_with_fresh_xkey()
        .handle(&envelope.payload, Some(server_xkey), now)
        .await;
    assert!(
        matches!(dropped, Outcome::Dropped(CalloutError::XkeyOpenFailed)),
        "the wrong xkey must not open the box: {dropped:?}"
    );

    // The right key without the server's header: no sender to open against.
    let dropped = stack
        .bridge_core_with_xkey()
        .handle(&envelope.payload, None, now)
        .await;
    assert!(
        matches!(dropped, Outcome::Dropped(CalloutError::XkeyOpenFailed)),
        "a sealed envelope with no sender header must be dropped: {dropped:?}"
    );

    // A header naming some other server key does not open the box either.
    let liar = CalloutXKey::generate().public_key();
    let dropped = stack
        .bridge_core_with_xkey()
        .handle(&envelope.payload, Some(&liar), now)
        .await;
    assert!(
        matches!(dropped, Outcome::Dropped(CalloutError::XkeyOpenFailed)),
        "a lying sender header must not open the box: {dropped:?}"
    );
    assert_eq!(
        stack.host.calls(),
        calls_before,
        "a dropped envelope reaches no Host"
    );

    // And with the right key and the right header it goes through.
    let reply = match stack
        .bridge_core_with_xkey()
        .handle(&envelope.payload, Some(server_xkey), now)
        .await
    {
        Outcome::Reply(bytes) => bytes,
        Outcome::Dropped(err) => panic!("the configured xkey must open the live envelope: {err:?}"),
    };
    assert!(is_sealed(&reply));
    assert_eq!(stack.host.calls(), calls_before + 1);
    stack.stop().await;
}

/// AT-CALLOUT-XKEY: a server configured to seal never falls back to bare
/// callouts. A bridge without the xkey drops the sealed request — it has no
/// key for it — so the server's callout is never answered, no client gets a
/// usable session, and no decision is ever made.
#[tokio::test]
#[ignore = "needs the pinned nats-server: OPENSESAME_MTLS_FIXTURES=1"]
async fn a_sealing_server_never_serves_a_bridge_without_the_xkey() {
    if !enabled() {
        eprintln!("skipping: OPENSESAME_MTLS_FIXTURES/OPENSESAME_MTLS_BIN_NATS_SERVER not set");
        return;
    }
    let xkey = CalloutXKey::generate();
    let stack = Stack::start_with(StackOptions {
        server_xkey: Some(xkey.public_key()),
        bridge_xkey_seed: None,
    })
    .await;
    // Depending on timing the client library hands out a connection object
    // (and even answers a PING) before the server's rejection lands, so the
    // property asserted is admission, not the shape of one error: whatever
    // comes back, no message is ever delivered and the server closes it.
    if let Ok((client, log)) = stack.app_client(GOOD_TOKEN).await {
        let mut sub = client.subscribe("probe.subject").await.expect("subscribe");
        let _ = client.publish("probe.subject", "hi".into()).await;
        let delivered = tokio::time::timeout(Duration::from_secs(6), sub.next()).await;
        let events = log.lock().expect("events").clone();
        assert!(
            delivered.is_err(),
            "a bare bridge admitted a client against a sealing server: a message was delivered ({events:?})"
        );
        assert!(
            wait_for_disconnect(&log, Duration::from_secs(12)).await,
            "the server must close a client whose callout was never answered ({events:?})"
        );
    }
    assert_eq!(stack.host.calls(), 0, "no decision is ever requested");
    stack.stop().await;
}

/// The envelope mode is the server's choice: a bridge holding an xkey still
/// serves a server that seals nothing, and seals to nobody in return.
#[tokio::test]
#[ignore = "needs the pinned nats-server: OPENSESAME_MTLS_FIXTURES=1"]
async fn an_xkey_bridge_still_serves_a_bare_server() {
    if !enabled() {
        eprintln!("skipping: OPENSESAME_MTLS_FIXTURES/OPENSESAME_MTLS_BIN_NATS_SERVER not set");
        return;
    }
    let stack = Stack::start().await;
    let (good, _events) = stack.app_client(GOOD_TOKEN).await.expect("admitted");
    good.flush().await.unwrap();
    let envelope = first_envelope(&stack).await;
    assert!(!is_sealed(&envelope.payload), "this server seals nothing");
    assert!(envelope.server_xkey_header.is_none());

    let now = chrono::Utc::now().timestamp();
    let reply = match stack
        .bridge_core_with_fresh_xkey()
        .handle(&envelope.payload, None, now)
        .await
    {
        Outcome::Reply(bytes) => bytes,
        Outcome::Dropped(err) => panic!("a bare request must still be served: {err:?}"),
    };
    assert!(!is_sealed(&reply), "there is nobody to seal a reply to");
    drop(good);
    stack.stop().await;
}

/// The first envelope the recorder saw, waiting briefly for it to arrive.
async fn first_envelope(stack: &Stack) -> RecordedEnvelope {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
    loop {
        if let Some(envelope) = stack.envelopes().into_iter().next() {
            return envelope;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "no callout envelope was recorded"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// Keep the shared `Arc<BridgeCore>` type in scope for the helpers.
#[allow(dead_code)]
type SharedCore = Arc<BridgeCore>;
