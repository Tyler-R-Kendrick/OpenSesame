//! Who may use a run's proxy, for how long, and with what: the proxy
//! credential, run end and revocation, another run's surrogate, expiry,
//! un-surrogated traffic, passthrough, the body cap, and what a run hands
//! back. One test per attack.

mod support;

use std::time::Duration;

use bytes::Bytes;
use opensesame_invoke_through::{RefusalCode, DEFAULT_REQUEST_BODY_CAP};
use opensesame_surrogate_proxy::{RunError, RunSpec};
use support::client::{bearer, body_request, connect, proxy_authorization, request, through_proxy};
use support::{grant, harness, HOST, STATIC};

#[tokio::test]
async fn connect_without_the_runs_proxy_credential_is_refused() {
    let h = harness().await;
    let run = h.start("run-auth");
    let other = h.start("run-other");
    let (status, _) = connect(run.proxy_addr(), &format!("{HOST}:443"), None).await;
    assert_eq!(status, 407, "no credential");
    let (status, _) = connect(
        run.proxy_addr(),
        &format!("{HOST}:443"),
        Some("Basic b3BlbnNlc2FtZTp4"),
    )
    .await;
    assert_eq!(status, 407, "a guessed credential");
    let (status, _) = connect(
        run.proxy_addr(),
        &format!("{HOST}:443"),
        Some(&proxy_authorization(&other)),
    )
    .await;
    assert_eq!(status, 407, "another run's credential");
    let (status, _) = connect(
        run.proxy_addr(),
        &format!("{HOST}:443"),
        Some(&proxy_authorization(&run)),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(h.source_calls(), 0);
}

#[tokio::test]
async fn a_surrogate_reused_after_its_run_ends_is_refused_as_revoked() {
    let h = harness().await;
    let ended = h.start("run-ended");
    let live = h.start("run-live");
    assert_eq!(h.runs.end_run("run-ended"), 1);
    assert!(!h.runs.is_active("run-ended"));
    // The ended run's listener is gone: nothing answers on its port.
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(tokio::net::TcpStream::connect(ended.proxy_addr())
        .await
        .is_err());
    // Its surrogate, carried to a live run, is a tripwire, not noise.
    let seen = through_proxy(
        &live,
        HOST,
        request("GET", HOST, "/user", &[("authorization", &bearer(&ended))]),
    )
    .await
    .expect("answered");
    assert_eq!(seen.status, 403);
    assert_eq!(h.refusals.codes(), vec![RefusalCode::Revoked]);
    assert!(h.upstream.hits().is_empty());
    assert_eq!(
        h.runs.end_run("run-ended"),
        0,
        "ending twice revokes nothing new"
    );
}

#[tokio::test]
async fn a_surrogate_presented_through_another_runs_proxy_is_a_foreign_caller() {
    let h = harness().await;
    let victim = h.start("run-victim");
    let thief = h.start("run-thief");
    let seen = through_proxy(
        &thief,
        HOST,
        request("GET", HOST, "/user", &[("authorization", &bearer(&victim))]),
    )
    .await
    .expect("answered");
    assert_eq!(seen.status, 403);
    assert_eq!(h.refusals.codes(), vec![RefusalCode::ForeignCaller]);
    assert_eq!(h.source_calls(), 0);
}

#[tokio::test]
async fn an_expired_surrogate_is_refused() {
    let h = harness().await;
    let run = h.start("run-expiry");
    h.clock.advance(Duration::from_secs(601));
    let seen = through_proxy(
        &run,
        HOST,
        request("GET", HOST, "/user", &[("authorization", &bearer(&run))]),
    )
    .await
    .expect("answered");
    assert_eq!(seen.status, 403);
    assert_eq!(h.refusals.codes(), vec![RefusalCode::Expired]);
}

#[tokio::test]
async fn unsurrogated_traffic_is_refused_by_default() {
    let h = harness().await;
    let run = h.start("run-default");
    for host in [HOST, STATIC] {
        let seen = through_proxy(&run, host, request("GET", host, "/", &[]))
            .await
            .expect("answered");
        assert_eq!(seen.status, 403, "{host}");
    }
    assert!(h.upstream.hits().is_empty());
    assert!(h.passthrough.hits().is_empty());
    assert!(h.refusals.codes().is_empty(), "no surrogate, no tripwire");
}

#[tokio::test]
async fn a_passthrough_host_is_tunnelled_without_any_credential() {
    let h = harness().await;
    let run = h.start_with(
        "run-passthrough",
        &RunSpec {
            grants: vec![grant()],
            passthrough_hosts: vec![STATIC.to_uppercase()],
            ..RunSpec::default()
        },
    );
    let seen = through_proxy(&run, STATIC, request("GET", STATIC, "/pkg", &[]))
        .await
        .expect("forwarded");
    assert_eq!(seen.status, 200);
    let hits = h.passthrough.hits();
    assert_eq!(hits.len(), 1);
    assert_eq!(
        hits[0].authorization, None,
        "passthrough adds no credential"
    );
    assert!(hits[0]
        .all_values
        .iter()
        .all(|v| !v.contains("opensesame") && !v.starts_with("Basic ")));
    // A surrogate sent to the passthrough host is still a theft.
    let seen = through_proxy(
        &run,
        STATIC,
        request("GET", STATIC, "/pkg", &[("authorization", &bearer(&run))]),
    )
    .await
    .expect("answered");
    assert_eq!(seen.status, 403);
    assert_eq!(h.refusals.codes(), vec![RefusalCode::Misdirected]);
    assert_eq!(h.passthrough.hits().len(), 1);
    assert_eq!(h.source_calls(), 0);
    // The passthrough host on another port is not the host the run named.
    let auth = proxy_authorization(&run);
    let (status, stream) = connect(run.proxy_addr(), &format!("{STATIC}:8443"), Some(&auth)).await;
    assert_eq!(status, 200);
    let tunnel = support::client::tls(stream, support::client::run_trust(&run), STATIC)
        .await
        .expect("handshake");
    let seen = support::client::send(tunnel, request("GET", &format!("{STATIC}:8443"), "/", &[]))
        .await
        .expect("answered");
    assert_eq!(seen.status, 403);
    assert_eq!(h.passthrough.hits().len(), 1);
}

#[tokio::test]
async fn a_body_past_the_cap_is_refused_before_admission() {
    let h = harness().await;
    let run = h.start("run-cap");
    let mut body = vec![b'a'; DEFAULT_REQUEST_BODY_CAP];
    // The surrogate sits past the cap, where a scan that stopped early would
    // miss it.
    body.extend_from_slice(run.surrogates()[0].1.as_str().as_bytes());
    let seen = through_proxy(
        &run,
        HOST,
        body_request(
            "POST",
            HOST,
            "/gists",
            &[("authorization", &bearer(&run))],
            Bytes::from(body),
        ),
    )
    .await
    .expect("answered");
    assert_eq!(seen.status, 413);
    assert!(h.upstream.hits().is_empty());
    assert_eq!(h.source_calls(), 0);
}

#[tokio::test]
async fn the_run_ca_key_and_the_secrets_never_appear_in_what_a_run_returns() {
    let h = harness().await;
    let run = h.start("run-returns");
    assert!(run.ca_pem().starts_with("-----BEGIN CERTIFICATE-----"));
    assert!(!run.ca_pem().contains("PRIVATE KEY"));
    for (_, value) in run.child_env(std::path::Path::new("/tmp/ca.pem")) {
        assert!(!value.to_string_lossy().contains("PRIVATE KEY"));
    }
    let surrogate = run.surrogates()[0].1.as_str().to_owned();
    let secret = proxy_authorization(&run);
    let rendered = format!("{run:?} {:?} {:?}", run.surrogates(), h.runs);
    assert!(!rendered.contains(&surrogate), "{rendered}");
    assert!(!rendered.contains("PRIVATE"), "{rendered}");
    assert!(!rendered.contains(&secret[6..]), "{rendered}");
}

#[tokio::test]
async fn a_run_refuses_names_it_cannot_honour() {
    let h = harness().await;
    let reserved = RunSpec {
        grants: vec![{
            let mut g = grant();
            g.env_var = "HTTPS_PROXY".into();
            g
        }],
        passthrough_hosts: vec![],
        ..RunSpec::default()
    };
    assert!(matches!(
        h.runs.create_run("run-x", &reserved),
        Err(RunError::EnvVar(_))
    ));
    let twice = RunSpec {
        grants: vec![grant(), grant()],
        passthrough_hosts: vec![],
        ..RunSpec::default()
    };
    assert!(matches!(
        h.runs.create_run("run-x", &twice),
        Err(RunError::EnvVar(_))
    ));
    let bad_host = RunSpec {
        grants: vec![],
        passthrough_hosts: vec!["*.github.com".into()],
        ..RunSpec::default()
    };
    assert!(matches!(
        h.runs.create_run("run-x", &bad_host),
        Err(RunError::PassthroughHost(_))
    ));
    let mut unknown = grant();
    unknown.provider_id = "nope".into();
    let spec = RunSpec {
        grants: vec![grant_named("A"), unknown],
        passthrough_hosts: vec![],
        ..RunSpec::default()
    };
    assert!(matches!(
        h.runs.create_run("run-x", &spec),
        Err(RunError::Issue(_))
    ));
    assert!(!h.runs.is_active("run-x"));
    assert!(matches!(
        h.runs.create_run("", &RunSpec::default()),
        Err(RunError::EmptyRunId)
    ));
    h.start("run-dup");
    assert!(matches!(
        h.runs.create_run("run-dup", &RunSpec::default()),
        Err(RunError::AlreadyActive(_))
    ));
}

fn grant_named(env_var: &str) -> opensesame_surrogate_proxy::SurrogateGrant {
    let mut g = grant();
    g.env_var = env_var.into();
    g
}
