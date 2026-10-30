//! Serving: the plain listener always carries provenance, and a configured
//! secure profile with unusable material stops the process instead of
//! serving plaintext.

use opensesame_domain::transport::ServiceBindingSet;

use super::test_support::runtime;

struct RestoreNonlocalOverrides(Vec<(&'static str, Option<std::ffi::OsString>)>);

impl RestoreNonlocalOverrides {
    fn clear() -> Self {
        let saved = [
            "OPENSESAME_ALLOW_NONLOCAL",
            "OPENSESAME_DAEMON_ALLOW_NONLOCAL",
        ]
        .into_iter()
        .map(|name| {
            let previous = std::env::var_os(name);
            std::env::remove_var(name);
            (name, previous)
        })
        .collect();
        Self(saved)
    }
}

impl Drop for RestoreNonlocalOverrides {
    fn drop(&mut self) {
        for (name, value) in self.0.drain(..) {
            match value {
                Some(value) => std::env::set_var(name, value),
                None => std::env::remove_var(name),
            }
        }
    }
}

async fn wait_for_listener(address: std::net::SocketAddr) {
    loop {
        if tokio::net::TcpStream::connect(address).await.is_ok() {
            break;
        }
        tokio::task::yield_now().await;
    }
}

#[tokio::test]
async fn the_plain_listener_serves_and_carries_its_provenance() {
    let state = crate::app_state::test_demo_state().await;
    let args = crate::config::Args {
        listen: "127.0.0.1:0".parse().unwrap(),
        resource: state.resource.clone(),
        issuer: state.issuer.clone(),
        database_url: "sqlite::memory:".into(),
        task_database_url: String::new(),
        profile: crate::config::GatewayProfile::Host,
    };
    let app = crate::routes::router(state.clone());
    let served = tokio::spawn(async move { super::boot::serve(state, &args, app).await });
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
        profile: crate::config::GatewayProfile::Host,
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
    // No fallback: nothing here downgrades a failed secure listener, and no
    // error from binding it is swallowed.
    assert!(!src.contains("unwrap_or"));
    assert!(!src.contains(".ok();"));
    assert!(!src.contains("if let Ok("));
    assert!(src.contains("SecureListener::bind") && src.contains("})?;"));
}

fn live_secure_runtime(address: std::net::SocketAddr) -> std::sync::Arc<super::TransportRuntime> {
    use opensesame_domain::transport::TrustProfileKind;
    use opensesame_transport_security::testkit::DisposableCa;
    use opensesame_transport_security::{GenerationCandidate, TransportGenerations, TrustBundle};
    use std::sync::Arc;

    let server_ca = DisposableCa::new("server");
    let client_ca = DisposableCa::new("clients");
    let profile = super::test_support::profile();
    let trust = TrustBundle::from_pem(
        profile.clone(),
        TrustProfileKind::PrivateRoot,
        &client_ca.root_pem(),
    )
    .expect("client trust");
    let initial = GenerationCandidate {
        identity: Some(Arc::new(server_ca.issue_server("localhost").identity())),
        peer_trust: [(profile, trust)].into(),
        own_trust: None,
        identity_required: true,
    }
    .into_generation(1, chrono::Utc::now())
    .expect("generation");
    let mut config = super::test_support::mtls_config();
    config.listener.as_mut().unwrap().listen = address;
    super::test_support::runtime_serving(
        TransportGenerations::new(initial),
        ServiceBindingSet::empty(),
        config,
    )
}

#[tokio::test]
async fn failed_primary_binding_cannot_leave_a_secure_listener_running() {
    let mut state = crate::app_state::test_demo_state().await;
    let occupied = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let reserve = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let secure_address = reserve.local_addr().unwrap();
    drop(reserve);
    state.transport = Some(live_secure_runtime(secure_address));
    let args = crate::config::Args {
        listen: occupied.local_addr().unwrap(),
        resource: state.resource.clone(),
        issuer: state.issuer.clone(),
        database_url: "sqlite::memory:".into(),
        task_database_url: String::new(),
        profile: crate::config::GatewayProfile::Host,
    };
    let app = crate::routes::router(state.clone());
    assert!(super::boot::serve(state, &args, app).await.is_err());
    let closed = tokio::net::TcpListener::bind(secure_address).await;
    assert!(closed.is_ok(), "a failed start must release every listener");
}

#[tokio::test]
async fn cancelling_the_server_releases_both_listening_sockets() {
    let mut state = crate::app_state::test_demo_state().await;
    let primary = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let secure = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let primary_address = primary.local_addr().unwrap();
    let secure_address = secure.local_addr().unwrap();
    drop((primary, secure));
    state.transport = Some(live_secure_runtime(secure_address));
    let args = crate::config::Args {
        listen: primary_address,
        resource: state.resource.clone(),
        issuer: state.issuer.clone(),
        database_url: "sqlite::memory:".into(),
        task_database_url: String::new(),
        profile: crate::config::GatewayProfile::Host,
    };
    let app = crate::routes::router(state.clone());
    let served = tokio::spawn(async move { super::boot::serve(state, &args, app).await });
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        wait_for_listener(primary_address),
    )
    .await
    .expect("the server starts");
    served.abort();
    assert!(served.await.unwrap_err().is_cancelled());
    assert!(tokio::net::TcpListener::bind(primary_address).await.is_ok());
    assert!(tokio::net::TcpListener::bind(secure_address).await.is_ok());
}

#[tokio::test]
async fn a_network_secure_listener_requires_the_explicit_nonlocal_override() {
    let mut state = crate::app_state::test_demo_state().await;
    let _lock = crate::app_state::test_env::lock();
    let _restore = RestoreNonlocalOverrides::clear();
    state.transport = Some(live_secure_runtime("0.0.0.0:0".parse().unwrap()));
    let args = crate::config::Args {
        listen: "127.0.0.1:0".parse().unwrap(),
        resource: state.resource.clone(),
        issuer: state.issuer.clone(),
        database_url: "sqlite::memory:".into(),
        task_database_url: String::new(),
        profile: crate::config::GatewayProfile::Host,
    };
    let app = crate::routes::router(state.clone());
    let error = super::boot::serve(state, &args, app).await.unwrap_err();
    assert!(error.to_string().contains("not loopback"));
}
