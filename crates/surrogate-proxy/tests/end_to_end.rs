//! ADR 0150 §6.1's acceptance run, on real sockets: an unmodified HTTPS
//! client holding only a surrogate talks through the run's proxy to a
//! loopback TLS upstream, and the real bearer exists on exactly one wire.

mod support;

use opensesame_invoke_through::Refusal;
use support::client::{bearer, request, through_proxy};
use support::{harness, CANARY, HOST};

#[tokio::test]
async fn the_child_holds_only_the_surrogate_and_the_upstream_sees_the_bearer_once() {
    let h = harness().await;
    let run = h.start("run-e2e");
    let surrogate = run.surrogates()[0].1.as_str().to_owned();
    let env = run.child_env(std::path::Path::new("/tmp/run-ca.pem"));
    // Everything the child is given, and nothing it is given holds the token.
    assert!(env
        .iter()
        .any(|(name, value)| name == "GITHUB_TOKEN" && value.to_str() == Some(&*surrogate)));
    assert!(env
        .iter()
        .all(|(_, value)| !value.to_string_lossy().contains(CANARY)));

    let seen = through_proxy(
        &run,
        HOST,
        request(
            "GET",
            HOST,
            "/user",
            &[
                ("authorization", &bearer(&run)),
                ("accept", "application/vnd.github+json"),
                ("x-github-api-version", "2022-11-28"),
                ("accept-encoding", "gzip"),
                ("cookie", "child=planted"),
            ],
        ),
    )
    .await
    .expect("brokered");
    assert_eq!(seen.status, 200);
    assert_eq!(seen.body, "{\"login\":\"octo\"}");
    // invoke-through's response allowlist: an upstream cookie never returns.
    assert!(seen.headers.get("set-cookie").is_none());

    let hits = h.upstream.hits();
    assert_eq!(hits.len(), 1, "one call, one upstream request");
    assert_eq!(hits[0].path, "/user");
    assert_eq!(
        hits[0].authorization.as_deref(),
        Some(&*format!("Bearer {CANARY}"))
    );
    let bearers = hits[0]
        .all_values
        .iter()
        .filter(|v| v.contains(CANARY))
        .count();
    assert_eq!(bearers, 1, "the bearer is placed exactly once");
    for value in &hits[0].all_values {
        assert!(
            !value.contains(&surrogate),
            "the surrogate never goes upstream"
        );
        assert!(
            !value.contains("planted"),
            "only forwardable headers travel"
        );
        assert!(!value.contains("gzip"), "no encoding the scrub cannot read");
    }
    assert!(hits[0].all_values.iter().any(|v| v == "2022-11-28"));
    assert_eq!(h.source_calls(), 1);
    assert!(h.refusals.codes().is_empty());

    let receipts = h.receipts.0.lock().unwrap();
    assert_eq!(receipts.len(), 1);
    let (admission, receipt) = &receipts[0];
    assert_eq!(admission.connection_ref, "conn://acme/gh");
    assert_eq!(admission.run_id, "run-e2e");
    assert_eq!(
        (receipt.host.as_str(), receipt.path.as_str()),
        (HOST, "/user")
    );
    assert!(!receipt.credential_reflected);
}

#[tokio::test]
async fn a_reflected_credential_comes_back_scrubbed() {
    let h = harness().await;
    let run = h.start("run-reflect");
    let seen = through_proxy(
        &run,
        HOST,
        request("GET", HOST, "/reflect", &[("authorization", &bearer(&run))]),
    )
    .await
    .expect("brokered");
    assert_eq!(seen.status, 200);
    assert!(!seen.body.contains(CANARY), "{}", seen.body);
    assert!(seen.body.contains("[redacted:credential]"));
    let echoed = seen
        .headers
        .get("x-github-request-id")
        .expect("allowlisted header");
    assert!(!echoed.to_str().unwrap().contains(CANARY));
    // The upstream did receive it: the scrub, not luck, kept it from the child.
    assert_eq!(
        h.upstream.hits()[0].authorization.as_deref(),
        Some(&*format!("Bearer {CANARY}"))
    );
    let receipts = h.receipts.0.lock().unwrap();
    assert!(receipts[0].1.credential_reflected);
}

#[tokio::test]
async fn keep_alive_requests_in_one_tunnel_are_each_admitted() {
    let h = harness().await;
    let run = h.start("run-keepalive");
    let auth = support::client::proxy_authorization(&run);
    let (status, stream) =
        support::client::connect(run.proxy_addr(), &format!("{HOST}:443"), Some(&auth)).await;
    assert_eq!(status, 200);
    let tls = support::client::tls(stream, support::client::run_trust(&run), HOST)
        .await
        .expect("handshake");
    let (mut sender, conn) =
        hyper::client::conn::http1::handshake(hyper_util::rt::TokioIo::new(tls))
            .await
            .unwrap();
    tokio::spawn(conn);
    let first = sender
        .send_request(request(
            "GET",
            HOST,
            "/user",
            &[("authorization", &bearer(&run))],
        ))
        .await
        .unwrap();
    assert_eq!(first.status(), 200);
    drop(first);
    sender.ready().await.unwrap();
    // The second request on the same tunnel carries no surrogate: refused on
    // its own merits, not waved through because the first was admitted.
    let second = sender
        .send_request(request("GET", HOST, "/user", &[]))
        .await
        .unwrap();
    assert_eq!(second.status(), 403);
    let body = http_body_util::BodyExt::collect(second.into_body())
        .await
        .unwrap()
        .to_bytes();
    assert_eq!(&body[..], Refusal::CLIENT_MESSAGE.as_bytes());
    assert_eq!(h.upstream.hits().len(), 1);
}
