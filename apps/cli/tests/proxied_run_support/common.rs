//! Shared by the proxied-run test files: a ready sandbox, the control process
//! for the process sweep, and the checks more than one test makes.

use std::process::{Child, Command, Stdio};

use serde_json::{json, Value};

use super::run::{request, with_authorization, Finished, RunOptions};
use super::upstream::Upstream;
use super::{Sandbox, CONNECTION_ENTRY, GENERIC_REFUSAL, SCOPED_LINE};

/// What the recording upstream answers every request with.
pub const UPSTREAM_BODY: &str = "{\"user\":{\"username\":\"octo\"}}";

/// A sandbox with the plugin installed and on, a sealed store holding the
/// token for `conn://acme/vercel`, and the scoped schema line.
pub fn ready() -> Sandbox {
    let sandbox = Sandbox::new();
    sandbox.install_plugin();
    sandbox.init_store();
    sandbox.seal(CONNECTION_ENTRY, &sandbox.token);
    sandbox.write_schema(SCOPED_LINE);
    sandbox
}

/// A process that holds `value` in its environment: the control that proves
/// the process sweep can see a value when one is there.
pub struct Decoy(pub Child);

impl Decoy {
    pub fn start(value: &str) -> Self {
        Self(
            Command::new("sleep")
                .arg("300")
                .env("DECOY", value)
                .stdout(Stdio::null())
                .spawn()
                .unwrap(),
        )
    }
}

impl Drop for Decoy {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

pub fn statuses(results: &[Value]) -> Vec<u64> {
    results
        .iter()
        .filter_map(|r| r["status"].as_u64())
        .collect()
}

pub fn bodies(results: &[Value]) -> Vec<&str> {
    results.iter().filter_map(|r| r["body"].as_str()).collect()
}

/// A request carrying `surrogate` (from a run that is over) to a live run's
/// proxy is refused like any other guess, and spends nothing upstream.
pub fn assert_dead(sandbox: &Sandbox, upstream: &Upstream, surrogate: &str) {
    let dead = sandbox.path("dead-surrogate");
    std::fs::write(&dead, surrogate).unwrap();
    let before = upstream.hits().len();
    let replay = with_authorization(
        request("replay", "GET", "/v2/user"),
        json!({ "bearerFile": dead }),
    );
    let finished = sandbox.run(&RunOptions::new(
        Some(upstream),
        vec![replay, request("own", "GET", "/v2/user")],
    ));
    assert_eq!(finished.code(), Some(0), "{}", finished.stderr());
    let results = finished.results();
    assert_eq!(statuses(&results), [403, 200], "{results:?}");
    assert_eq!(results[0]["body"], GENERIC_REFUSAL);
    assert_ne!(finished.env()["VERCEL_TOKEN"], surrogate);
    let hits = upstream.hits();
    assert_eq!(
        hits.len(),
        before + 1,
        "only the live run's own call: {hits:?}"
    );
}

/// A run that kept its placeholder: it ran, got an `ostest_` value for the
/// connection and no proxy, and holds nothing of `token`.
pub fn assert_placeholder(finished: &Finished, token: &str) {
    assert_eq!(finished.code(), Some(0), "{}", finished.stderr());
    assert!(finished.child_ran());
    let env = finished.env();
    let placeholder = &env["VERCEL_TOKEN"];
    assert!(placeholder.starts_with("ostest_"), "{placeholder}");
    assert!(!env.contains_key("HTTPS_PROXY"), "no proxy was set");
    assert!(env.values().all(|v| !v.contains(token)));
}
