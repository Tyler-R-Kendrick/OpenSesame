//! The live-sync hub under the oracle (ADR 0148 §7): Microsoft's `SignalR`
//! client, at the version Bitwarden's apps pin and configured as they
//! configure it (`WebSockets`, no negotiation, `MessagePack`), connects to the
//! hub, hears "sync" when the vault changes and "log out" when the security
//! stamp does, and is refused with a stale token.
//!
//! `#[ignore]`d like the other oracle suites; `pnpm test:bitwarden-oracle`
//! installs the pinned client and runs it, and fails, never skips, without
//! it.
mod common;

use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use common::orgs::account;
use common::Harness;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt as _, BufReader, Lines};
use tokio::process::{Child, ChildStdout, Command};

struct HubClient {
    _child: Child,
    lines: Lines<BufReader<ChildStdout>>,
}

impl HubClient {
    fn start(harness: &Harness, token: &str) -> Self {
        let dir = std::env::var_os("OPENSESAME_SIGNALR_DIR").expect(
            "OPENSESAME_SIGNALR_DIR must name the pinned @microsoft/signalr install; run \
             `pnpm test:bitwarden-oracle`",
        );
        let script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../scripts/test/bitwarden-hub-client.mjs");
        let mut command = Command::new("node");
        command
            .arg(script)
            .env("OPENSESAME_SIGNALR_DIR", dir)
            .env("HUB_URL", format!("{}/notifications/hub", harness.http_url))
            .env("HUB_TOKEN", token)
            .env("NODE_NO_WARNINGS", "1")
            .stdout(Stdio::piped())
            .kill_on_drop(true);
        for proxy in [
            "HTTPS_PROXY",
            "https_proxy",
            "HTTP_PROXY",
            "http_proxy",
            "ALL_PROXY",
            "all_proxy",
        ] {
            command.env_remove(proxy);
        }
        let mut child = command.spawn().expect("node runs the hub client");
        let lines = BufReader::new(child.stdout.take().unwrap()).lines();
        Self {
            _child: child,
            lines,
        }
    }

    async fn next(&mut self) -> Value {
        let line = tokio::time::timeout(Duration::from_secs(20), self.lines.next_line())
            .await
            .expect("the hub client answers in time")
            .unwrap()
            .expect("the hub client printed a line");
        serde_json::from_str(&line).unwrap()
    }
}

#[tokio::test]
#[ignore = "needs the pinned SignalR client: pnpm test:bitwarden-oracle"]
async fn bitwardens_signalr_client_hears_sync_and_log_out() {
    let harness = Harness::start().await;
    let (account, api) = account(&harness, "live@example.com").await;
    let user_id = api.user_id().await;
    let mut client = HubClient::start(&harness, &api.token);
    assert_eq!(client.next().await["event"], "connected");

    api.ok(
        "POST",
        "/folders",
        Some(json!({"name": "2.aGk=|aGk=|aGk="})),
    )
    .await;
    let heard = client.next().await;
    assert_eq!(heard["event"], "message", "{heard}");
    assert_eq!(heard["type"], 5, "SyncVault: {heard}");
    assert_eq!(heard["userId"], user_id.as_str());
    assert!(
        heard["date"].is_string(),
        "the date decodes as a timestamp: {heard}"
    );

    api.ok(
        "POST",
        "/accounts/security-stamp",
        Some(json!({"masterPasswordHash": account.password_hash()})),
    )
    .await;
    let heard = client.next().await;
    assert_eq!(heard["type"], 11, "LogOut: {heard}");
    assert_eq!(client.next().await["event"], "closed");

    let mut stale = HubClient::start(&harness, &api.token);
    assert_eq!(stale.next().await["event"], "refused");
}
