//! Mixed mode on the callout profile (`ops/nats/secure-callout.conf`): the
//! Host's service roles are static nkey users in `auth_users` and never
//! reach the callout, while an end user is decided per connection by the
//! (xkey-sealed) callout — both on one server, one account.

use super::live_callout::{connect_as, start_responder};
use super::live_harness::{free_port, Pki, Roles, Server};
use super::live_tests::{backup_config, config, event};
use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

#[tokio::test]
#[ignore = "requires OPENSESAME_MTLS_FIXTURES=1"]
async fn service_roles_bypass_the_callout_and_end_users_do_not() {
    if !super::live_harness::enabled() {
        return;
    }
    let pki = Pki::new();
    let roles = Roles::new();
    let issuer = nkeys::KeyPair::new_account();
    let mut env = roles.env(&pki, free_port());
    env.push(("OPENSESAME_NATS_CALLOUT_ISSUER", issuer.public_key()));
    let server = Server::start("secure-callout.conf", &env);
    let url = server.url();

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

    // Service roles: provisioning, the Host and the backup consumer all
    // connect on their static nkeys; not one callout is made for them.
    let leaf = pki.client("host.nats.opensesame.test");
    let provisioner_spec = pki.client_spec(Some(&leaf), Some(&roles.provisioner.0), true);
    NatsJetStreamTaskBus::connect(config(
        &url,
        provisioner_spec.clone(),
        NatsRole::Provisioner,
        true,
    ))
    .await
    .unwrap_or_else(|e| panic!("provisioner: {e:#}\n{}", server.log_text()));
    NatsJetStreamTaskBus::connect(backup_config(&url, provisioner_spec, true))
        .await
        .expect("backup consumer provisioned");
    let host = NatsJetStreamTaskBus::connect(config(
        &url,
        pki.client_spec(Some(&leaf), Some(&roles.host.0), true),
        NatsRole::Host,
        false,
    ))
    .await
    .expect("host connects on its static nkey");
    host.publish(event("m1", "principal.created"))
        .await
        .expect("host publishes");
    host.publish(event("m2", "system.backup.wake"))
        .await
        .expect("host publishes a system wake");
    let drained = host.drain(10).await.expect("host drains");
    assert!(drained.iter().any(|e| e.id == "m1"), "{drained:?}");
    let backup = NatsJetStreamTaskBus::connect(backup_config(
        &url,
        pki.client_spec(Some(&leaf), Some(&roles.backup.0), true),
        false,
    ))
    .await
    .expect("backup connects on its static nkey");
    let wakes = backup.drain(10).await.expect("backup drains");
    assert!(wakes.iter().any(|e| e.id == "m2"), "{wakes:?}");
    assert_eq!(
        admissions.load(Ordering::SeqCst),
        0,
        "no service role may depend on the callout"
    );

    observer_may_only_ask_srv(&pki, &roles, &server).await;
    assert_eq!(
        admissions.load(Ordering::SeqCst),
        0,
        "observer bypassed the callout"
    );

    // An end user goes through the sealed callout and gets only what it
    // issued.
    let alice = Box::pin(connect_as(
        &pki,
        &url,
        "alice.nats.opensesame.test",
        &alice_seed,
        Arc::new(BusHealth::default()),
    ))
    .await
    .unwrap_or_else(|e| panic!("alice via callout: {e}\n{}", server.log_text()));
    assert_eq!(admissions.load(Ordering::SeqCst), 1);
    alice
        .publish("opensesame.events.test", "hi".into())
        .await
        .expect("publish");
    alice.flush().await.expect("flush");

    // An unknown nkey is not a service role and is refused by the callout.
    let (mallory_seed, _) = super::live_harness::user_nkey();
    let refused = Box::pin(connect_as(
        &pki,
        &url,
        "mallory.nats.opensesame.test",
        &mallory_seed,
        Arc::new(BusHealth::default()),
    ))
    .await;
    assert!(
        refused.is_err(),
        "an unlisted nkey must go through the callout"
    );
    assert_eq!(admissions.load(Ordering::SeqCst), 2);
}

/// The discovery observer connects on its static nkey and may ask `$SRV`:
/// with no micro service registered the request fails fast with "no
/// responders" — a denied publish would time out instead.
async fn observer_may_only_ask_srv(pki: &Pki, roles: &Roles, server: &Server) {
    let observer = Box::pin(connect_as(
        pki,
        &server.url(),
        "observer.nats.opensesame.test",
        &roles.callout_observer.0,
        Arc::new(BusHealth::default()),
    ))
    .await
    .unwrap_or_else(|e| panic!("observer: {e}\n{}", server.log_text()));
    let ping = tokio::time::timeout(
        Duration::from_secs(5),
        observer.request("$SRV.PING", "".into()),
    )
    .await
    .expect("a permitted $SRV request is answered, not left to time out");
    assert!(
        matches!(&ping, Err(e) if e.kind() == async_nats::RequestErrorKind::NoResponders),
        "{ping:?}"
    );
}
