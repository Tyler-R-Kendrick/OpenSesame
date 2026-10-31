//! Every EST certificate branch shares the current live-generation fence.
use super::{
    attested, config, install_trust, request, sealed_state, seed_inventory,
    seed_self_signed_profile,
};
use crate::app_state::test_env;
use axum::http::StatusCode;
use opensesame_domain::transport::{TransportError, TransportPolicy};
use opensesame_transport_security::testkit::DisposableCa;

#[tokio::test]
async fn default_bootstrap_trust_still_requires_current_live_evidence() {
    let _guard = test_env::lock();
    let mut state = sealed_state().await;
    let profile = seed_self_signed_profile(&state, "random-value-16b").await;
    let mut config = config(&state, &profile).await;
    config.require_bootstrap = true;
    assert!(config.bootstrap_chain_pem.is_none());
    assert!(state.db.update_est_config(&config).await.unwrap());
    let roots = String::from_utf8(DisposableCa::new("bootstrap").root_pem()).unwrap();
    install_trust(&mut state, &roots);
    let direct = attested(TransportPolicy::MtlsRequired)
        .into_verified()
        .unwrap();
    let mut mismatch = attested(TransportPolicy::MtlsRequired);
    mismatch.trust_generation = 2;
    let mismatch = mismatch.into_verified().unwrap();
    for endpoint in ["simpleenroll", "simplereenroll"] {
        assert_eq!(
            request(&state, &profile, endpoint, Some(&direct), None, None).await,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            request(&state, &profile, endpoint, Some(&mismatch), None, None).await,
            StatusCode::UNAUTHORIZED
        );
    }
    state
        .transport
        .as_ref()
        .unwrap()
        .generations
        .withdraw(TransportError::GenerationStale);
    for endpoint in ["simpleenroll", "simplereenroll"] {
        assert_eq!(
            request(&state, &profile, endpoint, Some(&direct), None, None).await,
            StatusCode::UNAUTHORIZED
        );
    }
}

#[tokio::test]
async fn active_inventory_cannot_bypass_current_live_evidence() {
    let _guard = test_env::lock();
    let mut state = sealed_state().await;
    let profile = seed_self_signed_profile(&state, "random-value-16b").await;
    let mut config = config(&state, &profile).await;
    config.require_bootstrap = true;
    config.bootstrap_chain_pem =
        Some(String::from_utf8(DisposableCa::new("other").root_pem()).unwrap());
    assert!(state.db.update_est_config(&config).await.unwrap());
    seed_inventory(&state).await;
    let roots = String::from_utf8(DisposableCa::new("clients").root_pem()).unwrap();
    install_trust(&mut state, &roots);
    let direct = attested(TransportPolicy::MtlsRequired)
        .into_verified()
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
        StatusCode::BAD_REQUEST
    );
    let mut mismatch = attested(TransportPolicy::MtlsRequired);
    mismatch.credential_generation = 2;
    let mismatch = mismatch.into_verified().unwrap();
    assert_eq!(
        request(
            &state,
            &profile,
            "simplereenroll",
            Some(&mismatch),
            None,
            None
        )
        .await,
        StatusCode::UNAUTHORIZED
    );
    state
        .transport
        .as_ref()
        .unwrap()
        .generations
        .withdraw(TransportError::GenerationStale);
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
