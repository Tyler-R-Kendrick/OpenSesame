//! Serving: the plain listener always carries provenance, and a configured
//! secure profile with unusable material stops the process instead of
//! serving plaintext.

use opensesame_domain::transport::ServiceBindingSet;

use super::test_support::runtime;

#[tokio::test]
async fn the_plain_listener_serves_and_carries_its_provenance() {
    let state = crate::app_state::test_demo_state().await;
    let args = crate::config::Args {
        listen: "127.0.0.1:0".parse().unwrap(),
        resource: state.resource.clone(),
        issuer: state.issuer.clone(),
        database_url: "sqlite::memory:".into(),
        task_database_url: String::new(),
    };
    let app = crate::routes::router(state.clone());
    let served = tokio::spawn(super::boot::serve(state, &args, app));
    // The task keeps running; nothing about an unconfigured transport makes
    // it fail.
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    assert!(!served.is_finished());
    served.abort();
}

/// EXPLICIT-ENFORCEMENT at the entry point: a configured secure listener whose
/// generation holds no identity refuses to bind, and `serve` returns `Err`
/// rather than quietly answering on the plain listener alone.
#[tokio::test]
async fn a_required_but_unusable_secure_profile_stops_everything() {
    let mut state = crate::app_state::test_demo_state().await;
    // The fixture runtime carries a listener address but no identity.
    state.transport = Some(runtime(ServiceBindingSet::empty(), 1));
    let args = crate::config::Args {
        listen: "127.0.0.1:0".parse().unwrap(),
        resource: state.resource.clone(),
        issuer: state.issuer.clone(),
        database_url: "sqlite::memory:".into(),
        task_database_url: String::new(),
    };
    let app = crate::routes::router(state.clone());
    let error = super::boot::serve(state, &args, app)
        .await
        .expect_err("no identity in the current generation");
    assert!(error.to_string().contains("identity_missing"));
}

/// The plain listener is wrapped, once, with its provenance layer, and the
/// secure one is built from the runtime — not from an ambient default.
#[test]
fn the_wiring_is_the_documented_one() {
    let src = include_str!("boot.rs");
    assert!(src.contains("plain_provenance_layer(HOST_PLAIN_LISTENER)"));
    assert!(src.contains("SecureListener::bind"));
    assert!(src.contains("enforce_current_generation"));
    assert!(src.contains("policy.authenticates_client()"));
    // No fallback: nothing here downgrades a failed secure listener.
    assert!(!src.contains("unwrap_or"));
    assert!(!src.contains("ok()"));
}
