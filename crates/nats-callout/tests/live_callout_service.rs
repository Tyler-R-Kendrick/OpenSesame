//! The bridge as a NATS micro service, against the pinned nats-server:
//! discovery (`$SRV.PING|INFO`), statistics (`$SRV.STATS`, with the
//! allow / deny / drop split) and queue-group load balancing across two
//! instances — each callout decided by exactly one of them.
//!
//! Run with:
//! `OPENSESAME_MTLS_FIXTURES=1 OPENSESAME_MTLS_BIN_NATS_SERVER=$(bash scripts/mtls/mtls-fixtures.sh path nats-server) \
//!  cargo +1.88.0 test -p opensesame-nats-callout --test live_callout_service -- --ignored --nocapture`

mod live_support;

use std::time::Duration;

use futures::StreamExt as _;
use live_support::*;
use opensesame_nats_callout::service::{ENDPOINT_NAME, SERVICE_NAME};
use opensesame_nats_callout::{AUTH_SUBJECT, QUEUE_GROUP};
use serde_json::Value;

fn enabled() -> bool {
    std::env::var("OPENSESAME_MTLS_FIXTURES").as_deref() == Ok("1")
        && std::env::var("OPENSESAME_MTLS_BIN_NATS_SERVER").is_ok()
}

/// Every instance's answer to one `$SRV.<verb>.<service>` request.
async fn gather(client: &async_nats::Client, verb: &str) -> Vec<Value> {
    let inbox = client.new_inbox();
    let mut sub = client.subscribe(inbox.clone()).await.unwrap();
    client
        .publish_with_reply(format!("$SRV.{verb}.{SERVICE_NAME}"), inbox, "".into())
        .await
        .unwrap();
    client.flush().await.unwrap();
    let mut out = Vec::new();
    while let Ok(Some(msg)) = tokio::time::timeout(Duration::from_millis(500), sub.next()).await {
        out.push(serde_json::from_slice(&msg.payload).unwrap());
    }
    out
}

fn endpoint(response: &Value) -> &Value {
    let endpoints = response["endpoints"].as_array().expect("endpoints");
    assert_eq!(endpoints.len(), 1, "{response}");
    &endpoints[0]
}

#[tokio::test]
#[ignore = "needs the pinned nats-server: OPENSESAME_MTLS_FIXTURES=1"]
async fn the_bridge_is_a_discoverable_load_balanced_micro_service() {
    if !enabled() {
        eprintln!("skipping: OPENSESAME_MTLS_FIXTURES/OPENSESAME_MTLS_BIN_NATS_SERVER not set");
        return;
    }
    let stack = Stack::start().await;
    let second = stack.spawn_bridge().await;
    let observer = stack.auth_account_client().await;
    tokio::time::sleep(Duration::from_millis(300)).await;

    // Discovery: both instances answer PING, with distinct ids.
    let pings = gather(&observer, "PING").await;
    assert_eq!(pings.len(), 2, "{pings:?}");
    assert_ne!(pings[0]["id"], pings[1]["id"]);
    assert!(pings.iter().all(|p| p["name"] == SERVICE_NAME));

    // INFO names the protected subject, the shared queue group and only
    // public metadata.
    let info = gather(&observer, "INFO").await;
    assert_eq!(info.len(), 2);
    let ep = endpoint(&info[0]);
    assert_eq!(ep["name"], ENDPOINT_NAME);
    assert_eq!(ep["subject"], AUTH_SUBJECT);
    assert_eq!(ep["queue_group"], QUEUE_GROUP);
    let meta = info[0]["metadata"].as_object().expect("metadata");
    let mut keys: Vec<_> = meta.keys().map(String::as_str).collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        [
            "callout_account",
            "pinned_servers",
            "sealed",
            "target_account"
        ]
    );
    assert_eq!(meta["sealed"], "false");
    assert_eq!(meta["callout_account"], stack.callout_account());

    // Load balancing: six CONNECTs, each decided by exactly one instance.
    let mut clients = Vec::new();
    for _ in 0..4 {
        clients.push(stack.app_client(GOOD_TOKEN).await.expect("admitted"));
    }
    for _ in 0..2 {
        assert!(stack.app_client(FORGED_TOKEN).await.is_err());
    }
    assert_eq!(stack.host.calls(), 6);

    let stats = gather(&observer, "STATS").await;
    assert_eq!(stats.len(), 2);
    let sum = |field: &str| -> u64 {
        stats
            .iter()
            .map(|s| endpoint(s)["data"][field].as_u64().unwrap_or(0))
            .sum()
    };
    let requests: u64 = stats
        .iter()
        .map(|s| endpoint(s)["num_requests"].as_u64().unwrap())
        .sum();
    assert_eq!(requests, 6, "{stats:?}");
    assert_eq!(sum("allowed"), 4, "{stats:?}");
    assert_eq!(sum("denied"), 2, "{stats:?}");
    assert_eq!(sum("dropped"), 0, "{stats:?}");

    drop(clients);
    second.abort();
    stack.stop().await;
}
