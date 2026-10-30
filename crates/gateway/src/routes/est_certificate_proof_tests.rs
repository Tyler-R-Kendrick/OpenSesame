//! EST certificates authenticate the enrollee, never a shared TLS proxy.
use super::{basic, router, sealed_state, seed_self_signed_profile};
use crate::app_state::{test_env, AppState};
use crate::transport::test_support::{self, THUMB_A, THUMB_B};
use axum::{body::Body, http::Request, http::StatusCode};
use opensesame_domain::transport::attest::AttestedPeer;
use opensesame_domain::transport::{
    EvidenceSource, TransportPolicy, TrustProfileKind, VerifiedPeer,
};
use opensesame_ingress_evidence::OriginatingPeerExtension;
use opensesame_storage::StoredEstConfig;
use opensesame_transport_security::testkit::DisposableCa;
use opensesame_transport_security::{
    GenerationCandidate, PeerExtension, TransportGenerations, TrustBundle,
};
use std::sync::Arc;
use tower::ServiceExt;

#[path = "est_certificate_tls_tests.rs"]
mod tls;

#[path = "est_certificate_freshness_tests.rs"]
mod freshness;

fn attested(policy: TransportPolicy) -> AttestedPeer {
    let peer = test_support::peer("enrollee.test", THUMB_A, 1);
    AttestedPeer {
        source: EvidenceSource::DirectTls,
        identities: peer.identities().to_vec(),
        leaf_thumbprint_sha256: peer.leaf_thumbprint_sha256().into(),
        not_before: peer.not_before(),
        not_after: peer.not_after(),
        trust_profile: peer.trust_profile().clone(),
        trust_generation: peer.trust_generation(),
        credential_generation: peer.credential_generation(),
        listener: peer.listener().into(),
        policy,
        tls_version: peer.tls_version(),
        authenticated_at: peer.authenticated_at(),
        usable_until: peer.usable_until(),
        ingress: None,
    }
}

async fn config(state: &AppState, profile: &str) -> StoredEstConfig {
    state
        .db
        .get_est_config(&state.connection_organization.to_string(), profile)
        .await
        .unwrap()
        .unwrap()
}

async fn request(
    state: &AppState,
    profile: &str,
    endpoint: &str,
    peer: Option<&VerifiedPeer>,
    origin: Option<&VerifiedPeer>,
    password: Option<&str>,
) -> StatusCode {
    let mut request = Request::post(format!("/.well-known/est/{profile}/{endpoint}"))
        // A refusal before CSR parsing proves no signer or issuance ran.
        .body(Body::from("not a csr"))
        .unwrap();
    if let Some(peer) = peer {
        request
            .extensions_mut()
            .insert(PeerExtension(Arc::new(peer.clone())));
    }
    if let Some(origin) = origin {
        request
            .extensions_mut()
            .insert(OriginatingPeerExtension(Arc::new(origin.clone())));
    }
    if let Some(password) = password {
        request.headers_mut().insert(
            axum::http::header::AUTHORIZATION,
            basic("est", password).parse().unwrap(),
        );
    }
    router(state.clone())
        .oneshot(request)
        .await
        .unwrap()
        .status()
}

fn install_trust(state: &mut AppState, chain: &str) {
    let profile = test_support::profile();
    let trust = TrustBundle::from_pem(
        profile.clone(),
        TrustProfileKind::PrivateRoot,
        chain.as_bytes(),
    )
    .unwrap();
    let generation = GenerationCandidate {
        peer_trust: [(profile, trust)].into(),
        ..GenerationCandidate::default()
    }
    .into_generation(1, chrono::Utc::now())
    .unwrap();
    state.transport = Some(test_support::runtime_serving(
        TransportGenerations::new(generation),
        test_support::set(vec![]),
        test_support::mtls_config(),
    ));
}

#[tokio::test]
async fn proxy_identity_and_forwarded_assertions_never_replace_direct_est_proof() {
    let _guard = test_env::lock();
    let state = sealed_state().await;
    let profile = seed_self_signed_profile(&state, "random-value-16b").await;
    let mut config = config(&state, &profile).await;
    config.require_bootstrap = true;
    assert!(state.db.update_est_config(&config).await.unwrap());
    let proxy = attested(TransportPolicy::TrustedIngress)
        .into_verified()
        .unwrap();
    let origin = test_support::forwarded("client.test", THUMB_B, &proxy);
    let mut local = attested(TransportPolicy::ExistingLocal);
    local.source = EvidenceSource::LocalIpc;
    let local = local.into_verified().unwrap();
    for endpoint in ["simpleenroll", "simplereenroll"] {
        for (peer, forwarded) in [
            (None, None),
            (Some(&proxy), None),
            (Some(&proxy), Some(&origin)),
            (Some(&local), None),
            (Some(&origin), None),
        ] {
            assert_eq!(
                request(&state, &profile, endpoint, peer, forwarded, None).await,
                StatusCode::UNAUTHORIZED
            );
            assert_eq!(
                request(
                    &state,
                    &profile,
                    endpoint,
                    peer,
                    forwarded,
                    Some("random-value-16b")
                )
                .await,
                StatusCode::UNAUTHORIZED
            );
        }
    }
}

#[tokio::test]
async fn a_proxy_without_origin_cannot_use_password_fallback() {
    let _guard = test_env::lock();
    let state = sealed_state().await;
    let profile = seed_self_signed_profile(&state, "random-value-16b").await;
    let proxy = attested(TransportPolicy::TrustedIngress)
        .into_verified()
        .unwrap();
    for endpoint in ["simpleenroll", "simplereenroll"] {
        assert_eq!(
            request(&state, &profile, endpoint, Some(&proxy), None, None).await,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            request(
                &state,
                &profile,
                endpoint,
                Some(&proxy),
                None,
                Some("random-value-16b")
            )
            .await,
            StatusCode::SERVICE_UNAVAILABLE
        );
    }
    let mut config = config(&state, &profile).await;
    config.sealed_passphrase = None;
    assert!(state.db.update_est_config(&config).await.unwrap());
    assert_eq!(
        request(
            &state,
            &profile,
            "simpleenroll",
            Some(&proxy),
            None,
            Some("random-value-16b")
        )
        .await,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn direct_client_certificates_work_but_expired_evidence_does_not() {
    let _guard = test_env::lock();
    let state = sealed_state().await;
    let profile = seed_self_signed_profile(&state, "random-value-16b").await;
    let mut config = config(&state, &profile).await;
    config.require_bootstrap = true;
    assert!(state.db.update_est_config(&config).await.unwrap());
    let valid = attested(TransportPolicy::MtlsRequired)
        .into_verified()
        .unwrap();
    let mut expired = attested(TransportPolicy::MtlsRequired);
    expired.authenticated_at = chrono::Utc::now() - chrono::Duration::minutes(2);
    expired.usable_until = chrono::Utc::now() - chrono::Duration::minutes(1);
    let expired = expired.into_verified().unwrap();
    for endpoint in ["simpleenroll", "simplereenroll"] {
        assert_eq!(
            request(&state, &profile, endpoint, Some(&valid), None, None).await,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            request(&state, &profile, endpoint, Some(&expired), None, None).await,
            StatusCode::UNAUTHORIZED
        );
    }
}

#[tokio::test]
async fn a_bootstrap_pin_rejects_additional_listener_anchors_and_wrong_generations() {
    let _guard = test_env::lock();
    let mut state = sealed_state().await;
    let profile = seed_self_signed_profile(&state, "random-value-16b").await;
    let ca_a = DisposableCa::new("bootstrap-only");
    let ca_b = DisposableCa::new("other-clients");
    let a = String::from_utf8(ca_a.root_pem()).unwrap();
    let b = String::from_utf8(ca_b.root_pem()).unwrap();
    let mut config = config(&state, &profile).await;
    config.require_bootstrap = true;
    config.bootstrap_chain_pem = Some(a.clone());
    assert!(state.db.update_est_config(&config).await.unwrap());
    let direct = attested(TransportPolicy::MtlsRequired)
        .into_verified()
        .unwrap();
    // A TLS peer authenticated by B cannot be attributed to A merely because
    // the same listener also trusts A. Evidence does not retain its path.
    for chain in [format!("{a}\n{b}"), b] {
        install_trust(&mut state, &chain);
        for endpoint in ["simpleenroll", "simplereenroll"] {
            assert_eq!(
                request(&state, &profile, endpoint, Some(&direct), None, None).await,
                StatusCode::UNAUTHORIZED
            );
        }
    }
    install_trust(&mut state, &a);
    assert_eq!(
        request(&state, &profile, "simpleenroll", Some(&direct), None, None).await,
        StatusCode::BAD_REQUEST
    );
    let mut mismatched = attested(TransportPolicy::MtlsRequired);
    mismatched.trust_generation = 2;
    let mismatched = mismatched.into_verified().unwrap();
    assert_eq!(
        request(
            &state,
            &profile,
            "simpleenroll",
            Some(&mismatched),
            None,
            None
        )
        .await,
        StatusCode::UNAUTHORIZED
    );
    let proxy = attested(TransportPolicy::TrustedIngress)
        .into_verified()
        .unwrap();
    assert_eq!(
        request(&state, &profile, "simpleenroll", Some(&proxy), None, None).await,
        StatusCode::UNAUTHORIZED
    );
}

/// Minimal public inventory fixtures; no signing key is opened by these tests.
async fn seed_inventory(state: &AppState) {
    let organization = state.connection_organization.to_string();
    sqlx::query("INSERT INTO certificate_authorities (id, organization_id, issuer_kind, display_name, public_metadata_json, sealed_key_id, sealed_ciphertext, sealed_nonce, sealed_aad_digest, status, created_at, updated_at) VALUES ('est-proof-ca', ?, 'local', 'fixture', '{}', 'fixture', X'01', X'01', 'fixture', 'active', 't', 't')")
        .bind(&organization).execute(state.db.pool()).await.unwrap();
    sqlx::query("INSERT INTO certificate_issuance_requests (id, organization_id, authority_id, request_digest, idempotency_key, created_by, state, common_name, san_json, expires_at, created_at, updated_at) VALUES ('est-proof-request', ?, 'est-proof-ca', 'fixture', 'fixture', 'fixture', 'completed', 'fixture', '[]', 't', 't', 't')")
        .bind(&organization).execute(state.db.pool()).await.unwrap();
    sqlx::query("INSERT INTO issued_certificates (id, organization_id, authority_id, request_id, certificate_digest, serial_number, common_name, san_json, not_before, expires_at, status, fingerprint_sha256, created_at, updated_at) VALUES ('est-proof-cert', ?, 'est-proof-ca', 'est-proof-request', ?, '1', 'fixture', '[]', 't', 't', 'active', ?, 't', 't')")
        .bind(&organization).bind(THUMB_A).bind(THUMB_A).execute(state.db.pool()).await.unwrap();
}

#[tokio::test]
async fn renewal_inventory_never_turns_a_proxy_or_expired_peer_into_the_enrollee() {
    let _guard = test_env::lock();
    let state = sealed_state().await;
    let profile = seed_self_signed_profile(&state, "random-value-16b").await;
    let mut config = config(&state, &profile).await;
    config.require_bootstrap = true;
    // No runtime can prove this bootstrap pin, so only a valid replacement
    // credential may pass. An inventory record alone proves no possession.
    config.bootstrap_chain_pem =
        Some(String::from_utf8(DisposableCa::new("bootstrap").root_pem()).unwrap());
    assert!(state.db.update_est_config(&config).await.unwrap());
    seed_inventory(&state).await;
    let direct = attested(TransportPolicy::MtlsRequired)
        .into_verified()
        .unwrap();
    assert_eq!(
        request(&state, &profile, "simpleenroll", Some(&direct), None, None).await,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        request(
            &state,
            &profile,
            "simplereenroll",
            Some(&direct),
            None,
            None
        )
        .await,
        StatusCode::BAD_REQUEST
    );
    let proxy = attested(TransportPolicy::TrustedIngress)
        .into_verified()
        .unwrap();
    let origin = test_support::forwarded("enrollee.test", THUMB_A, &proxy);
    let mut expired = attested(TransportPolicy::MtlsRequired);
    expired.authenticated_at = chrono::Utc::now() - chrono::Duration::minutes(2);
    expired.usable_until = chrono::Utc::now() - chrono::Duration::minutes(1);
    let expired = expired.into_verified().unwrap();
    let unknown = test_support::peer("unknown.test", THUMB_B, 1);
    for (peer, origin) in [
        (Some(&proxy), None),
        (Some(&proxy), Some(&origin)),
        (Some(&expired), None),
        (Some(&unknown), None),
        (None, None),
    ] {
        assert_eq!(
            request(&state, &profile, "simplereenroll", peer, origin, None).await,
            StatusCode::UNAUTHORIZED
        );
    }
    sqlx::query("UPDATE issued_certificates SET status = 'revoked' WHERE id = 'est-proof-cert'")
        .execute(state.db.pool())
        .await
        .unwrap();
    assert_eq!(
        request(
            &state,
            &profile,
            "simplereenroll",
            Some(&direct),
            None,
            None
        )
        .await,
        StatusCode::UNAUTHORIZED
    );
}
