//! Exercise EST's proof decision through real rustls client authentication.
use super::{config, router, sealed_state, seed_self_signed_profile};
use crate::app_state::{test_env, AppState};
use crate::transport::test_support;
use crate::transport_lifecycle::test_support as tls;
use base64::Engine as _;
use opensesame_domain::transport::{
    BindingPurpose, BindingScope, PeerIdentitySelector, TransportPolicy, TrustProfileKind,
};
use opensesame_ingress_evidence::{originating_peer_layer, BindingSetAdmission, IngressLimits};
use opensesame_transport_security::testkit::{DisposableCa, IssuedLeaf};
use opensesame_transport_security::{
    GenerationCandidate, ServerProfile, TransportGenerations, TrustBundle,
};
use rustls_pki_types::pem::PemObject;
use std::sync::{Arc, RwLock};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

async fn serve(
    mut state: AppState,
    server: &DisposableCa,
    client_roots: &[u8],
    origin: &DisposableCa,
    policy: TransportPolicy,
) -> tls::Served {
    let profile = test_support::profile();
    let trust = TrustBundle::from_pem(profile.clone(), TrustProfileKind::PrivateRoot, client_roots)
        .unwrap();
    let generation = GenerationCandidate {
        identity: Some(Arc::new(server.issue_server("localhost").identity())),
        peer_trust: [(profile.clone(), trust)].into(),
        identity_required: true,
        own_trust: None,
    }
    .into_generation(1, chrono::Utc::now())
    .unwrap();
    let generations = TransportGenerations::new(generation);
    let mut runtime = test_support::runtime_serving(
        generations.clone(),
        test_support::set(vec![]),
        test_support::mtls_config(),
    );
    Arc::get_mut(&mut runtime).unwrap().policy = policy;
    state.transport = Some(runtime);
    let mut app = router(state);
    if policy == TransportPolicy::TrustedIngress {
        let binding = test_support::binding(
            "edge",
            "edge.test",
            BindingPurpose::TrustedIngress,
            &["ingress.forward"],
            BindingScope::Deployment,
        );
        let admission = Arc::new(BindingSetAdmission::new(Arc::new(RwLock::new(
            test_support::set(vec![binding]),
        ))));
        let trust = TrustBundle::from_pem(
            test_support::profile(),
            TrustProfileKind::PrivateRoot,
            &origin.root_pem(),
        )
        .unwrap();
        app = app.layer(originating_peer_layer(
            admission,
            Arc::new(trust),
            IngressLimits::DEFAULT,
        ));
    }
    tls::serve(
        generations,
        move |generation| {
            let mut server = ServerProfile::new(
                policy,
                generation.identity.clone().unwrap(),
                crate::transport::HOST_TLS_LISTENER,
            );
            server.client_trust = Some(generation.trust(&profile)?.clone());
            Ok(server)
        },
        app,
    )
    .await
}

async fn post(
    server: &DisposableCa,
    client: &IssuedLeaf,
    listener: &tls::Served,
    profile: &str,
    endpoint: &str,
    extra_headers: &str,
) -> u16 {
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        let client = tls::client(server, Some(Arc::new(client.identity())));
        let mut stream = tls::connect(client, listener.addr).await.unwrap();
        let request = format!("POST /.well-known/est/{profile}/{endpoint} HTTP/1.1\r\nHost: localhost\r\nContent-Length: 9\r\nConnection: close\r\n{extra_headers}\r\nnot a csr");
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut response = Vec::new();
        while !response.ends_with(b"\r\n\r\n") {
            assert!(response.len() < 16 * 1024);
            response.push(stream.read_u8().await.unwrap());
        }
        String::from_utf8_lossy(&response).split_whitespace().nth(1).unwrap().parse().unwrap()
    }).await.unwrap()
}

#[tokio::test]
async fn real_mtls_preserves_direct_client_proof_and_refuses_other_trusted_cas() {
    let _guard = test_env::lock();
    let state = sealed_state().await;
    let profile = seed_self_signed_profile(&state, "random-value-16b").await;
    let server = DisposableCa::new("est-server");
    let a = DisposableCa::new("est-bootstrap");
    let b = DisposableCa::new("other-clients");
    let mut config = config(&state, &profile).await;
    config.require_bootstrap = true;
    config.bootstrap_chain_pem = Some(String::from_utf8(a.root_pem()).unwrap());
    assert!(state.db.update_est_config(&config).await.unwrap());
    let client_a = a.issue_client(PeerIdentitySelector::DnsName("enrollee.test".into()));
    let client_b = b.issue_client(PeerIdentitySelector::DnsName("other.test".into()));
    let direct = serve(
        state.clone(),
        &server,
        &a.root_pem(),
        &a,
        TransportPolicy::MtlsRequired,
    )
    .await;
    for endpoint in ["simpleenroll", "simplereenroll"] {
        assert_eq!(
            post(&server, &client_a, &direct, &profile, endpoint, "").await,
            400
        );
    }
    let roots = [a.root_pem(), b.root_pem()].concat();
    let broader = serve(state, &server, &roots, &a, TransportPolicy::MtlsRequired).await;
    // The handshake really accepts B; EST then refuses because the path is
    // not retained and the listener's complete anchor set does not match A.
    for endpoint in ["simpleenroll", "simplereenroll"] {
        assert_eq!(
            post(&server, &client_b, &broader, &profile, endpoint, "").await,
            401
        );
    }
}

#[tokio::test]
async fn a_bound_live_ingress_cannot_enroll_with_its_own_or_forwarded_certificate() {
    let _guard = test_env::lock();
    let state = sealed_state().await;
    let profile = seed_self_signed_profile(&state, "random-value-16b").await;
    let mut config = config(&state, &profile).await;
    config.require_bootstrap = true;
    assert!(state.db.update_est_config(&config).await.unwrap());
    let server = DisposableCa::new("est-server");
    let proxy_ca = DisposableCa::new("ingresses");
    let origin_ca = DisposableCa::new("originating-clients");
    let proxy = proxy_ca.issue_client(PeerIdentitySelector::DnsName("edge.test".into()));
    let origin = origin_ca.issue_client(PeerIdentitySelector::DnsName("enrollee.test".into()));
    let origin_der = rustls_pki_types::CertificateDer::from_pem_slice(&origin.leaf_pem).unwrap();
    let field = format!(
        "Client-Cert: :{}:\r\n",
        base64::engine::general_purpose::STANDARD.encode(origin_der)
    );
    let live = serve(
        state,
        &server,
        &proxy_ca.root_pem(),
        &origin_ca,
        TransportPolicy::TrustedIngress,
    )
    .await;
    for endpoint in ["simpleenroll", "simplereenroll"] {
        assert_eq!(
            post(&server, &proxy, &live, &profile, endpoint, "").await,
            401
        );
        // Valid originating evidence is correctly processed by ingress, but
        // EST deliberately requires direct end-client possession proof.
        assert_eq!(
            post(&server, &proxy, &live, &profile, endpoint, &field).await,
            401
        );
    }
}

#[tokio::test]
async fn password_sources_remain_independent_through_a_real_bound_ingress() {
    let _guard = test_env::lock();
    let state = sealed_state().await;
    let profile = seed_self_signed_profile(&state, "random-value-16b").await;
    let server = DisposableCa::new("est-server");
    let proxy_ca = DisposableCa::new("ingresses");
    let origin_ca = DisposableCa::new("originating-clients");
    let proxy = proxy_ca.issue_client(PeerIdentitySelector::DnsName("edge.test".into()));
    let attacker = origin_ca.issue_client(PeerIdentitySelector::DnsName("attacker.test".into()));
    let legitimate =
        origin_ca.issue_client(PeerIdentitySelector::DnsName("legitimate.test".into()));
    let live = serve(
        state,
        &server,
        &proxy_ca.root_pem(),
        &origin_ca,
        TransportPolicy::TrustedIngress,
    )
    .await;
    for index in 0..6 {
        let der = rustls_pki_types::CertificateDer::from_pem_slice(&attacker.leaf_pem).unwrap();
        let headers = format!(
            "Client-Cert: :{}:\r\nAuthorization: {}\r\nX-Forwarded-For: 192.0.2.{index}\r\n",
            base64::engine::general_purpose::STANDARD.encode(der),
            super::basic("est", "wrong")
        );
        assert_eq!(
            post(
                &server,
                &proxy,
                &live,
                &profile,
                ["simpleenroll", "simplereenroll"][index % 2],
                &headers
            )
            .await,
            if index < 5 { 401 } else { 429 }
        );
    }
    let der = rustls_pki_types::CertificateDer::from_pem_slice(&legitimate.leaf_pem).unwrap();
    let headers = format!(
        "Client-Cert: :{}:\r\nAuthorization: {}\r\n",
        base64::engine::general_purpose::STANDARD.encode(der),
        super::basic("est", "random-value-16b")
    );
    assert_eq!(
        post(&server, &proxy, &live, &profile, "simpleenroll", &headers).await,
        400
    );
    let no_origin = format!(
        "Authorization: {}\r\nX-Forwarded-For: 192.0.2.99\r\n",
        super::basic("est", "random-value-16b")
    );
    assert_eq!(
        post(&server, &proxy, &live, &profile, "simpleenroll", &no_origin).await,
        503
    );
    let forged = format!("Client-Cert: :Zm9yZ2Vk:\r\n{no_origin}");
    assert_eq!(
        post(&server, &proxy, &live, &profile, "simpleenroll", &forged).await,
        403
    );
}
