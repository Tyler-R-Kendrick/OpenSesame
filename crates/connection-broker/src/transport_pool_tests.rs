//! What the pool key separates, what eviction bounds, and what forgetting a
//! connection does.

use std::sync::atomic::{AtomicUsize, Ordering};

use opensesame_domain::transport::TransportPolicy;
use opensesame_invoke_through::{AuthStyle, EgressRule, Invoker};

use super::{ConnectorClientPool, ConnectorPoolKey};
use crate::transport::ConnectorExecutionTarget;

fn rules() -> Vec<EgressRule> {
    vec![EgressRule {
        provider_id: "acme",
        hosts: &["connector.example"],
        scheme: "https",
        auth: AuthStyle::Bearer,
    }]
}

fn key(org: &str, connection: &str) -> ConnectorPoolKey {
    ConnectorPoolKey {
        organization_id: org.into(),
        connection_id: connection.into(),
        executor: ConnectorExecutionTarget::Host,
        authority: "connector.example:443".into(),
        credential_thumbprint: Some("a".repeat(64)),
        trust_profile: Some("acme-root".into()),
        trust_generation: 1,
        policy: TransportPolicy::MtlsRequired,
    }
}

fn counting(
    built: &AtomicUsize,
) -> impl FnOnce() -> Result<Invoker, opensesame_domain::transport::TransportError> + '_ {
    move || {
        built.fetch_add(1, Ordering::SeqCst);
        Ok(Invoker::with_rules(rules()))
    }
}

#[test]
fn one_scope_builds_one_client_and_reuses_it() {
    let pool = ConnectorClientPool::with_capacity(8);
    let built = AtomicUsize::new(0);
    let first = pool
        .get_or_build(&key("org-a", "conn-1"), counting(&built))
        .unwrap();
    let second = pool
        .get_or_build(&key("org-a", "conn-1"), counting(&built))
        .unwrap();
    assert_eq!(built.load(Ordering::SeqCst), 1);
    assert!(std::sync::Arc::ptr_eq(&first, &second));
    assert_eq!(pool.len(), 1);
}

#[test]
fn every_part_of_the_scope_separates_clients() {
    // AT-CONNECTOR-POOLS / AT-TLS-TENANT / AT-ROTATE-VALID: none of these may
    // ever share a TLS connection, because each one changes what the upstream
    // authenticates or what the request is authorized for.
    let base = key("org-a", "conn-1");
    let variants = [
        ConnectorPoolKey {
            organization_id: "org-b".into(),
            ..base.clone()
        },
        ConnectorPoolKey {
            connection_id: "conn-2".into(),
            ..base.clone()
        },
        ConnectorPoolKey {
            executor: ConnectorExecutionTarget::WorkloadWorker,
            ..base.clone()
        },
        ConnectorPoolKey {
            authority: "other.example:443".into(),
            ..base.clone()
        },
        ConnectorPoolKey {
            credential_thumbprint: Some("b".repeat(64)),
            ..base.clone()
        },
        ConnectorPoolKey {
            credential_thumbprint: None,
            ..base.clone()
        },
        ConnectorPoolKey {
            trust_profile: Some("other-root".into()),
            ..base.clone()
        },
        ConnectorPoolKey {
            trust_generation: 2,
            ..base.clone()
        },
        ConnectorPoolKey {
            policy: TransportPolicy::ServerTls,
            ..base.clone()
        },
    ];
    let pool = ConnectorClientPool::with_capacity(64);
    let built = AtomicUsize::new(0);
    pool.get_or_build(&base, counting(&built)).unwrap();
    for variant in &variants {
        assert_ne!(*variant, base);
        pool.get_or_build(variant, counting(&built)).unwrap();
    }
    assert_eq!(built.load(Ordering::SeqCst), variants.len() + 1);
    assert_eq!(pool.len(), variants.len() + 1);
}

#[test]
fn the_pool_is_bounded_and_evicts_least_recently_used() {
    let pool = ConnectorClientPool::with_capacity(2);
    let built = AtomicUsize::new(0);
    let a = key("org-a", "conn-1");
    let b = key("org-a", "conn-2");
    let c = key("org-a", "conn-3");
    pool.get_or_build(&a, counting(&built)).unwrap();
    pool.get_or_build(&b, counting(&built)).unwrap();
    // Touch `a` so `b` becomes the least recent.
    pool.get_or_build(&a, counting(&built)).unwrap();
    pool.get_or_build(&c, counting(&built)).unwrap();
    assert_eq!(pool.len(), 2);
    assert!(pool.contains(&a));
    assert!(pool.contains(&c));
    assert!(!pool.contains(&b));
}

#[test]
fn forgetting_a_connection_drops_only_its_clients() {
    let pool = ConnectorClientPool::with_capacity(16);
    let built = AtomicUsize::new(0);
    let mine = key("org-a", "conn-1");
    let rotated = ConnectorPoolKey {
        credential_thumbprint: Some("b".repeat(64)),
        ..mine.clone()
    };
    let other_connection = key("org-a", "conn-2");
    let other_tenant = key("org-b", "conn-1");
    for entry in [&mine, &rotated, &other_connection, &other_tenant] {
        pool.get_or_build(entry, counting(&built)).unwrap();
    }
    assert_eq!(pool.len(), 4);

    pool.forget_connection("org-a", "conn-1");
    assert!(!pool.contains(&mine));
    assert!(!pool.contains(&rotated));
    assert!(pool.contains(&other_connection));
    // A same-id connection in another tenant is a different connection.
    assert!(pool.contains(&other_tenant));

    pool.clear();
    assert!(pool.is_empty());
}

#[test]
fn a_failed_build_pools_nothing() {
    let pool = ConnectorClientPool::with_capacity(4);
    let outcome = pool.get_or_build(&key("org-a", "conn-1"), || {
        Err(opensesame_domain::transport::TransportError::TrustUnknown)
    });
    let Err(error) = outcome else {
        panic!("a build failure is not a client");
    };
    assert_eq!(error.code(), "trust_unknown");
    assert!(pool.is_empty());
}

#[test]
fn a_pool_label_names_no_secret() {
    let label = key("org-a", "conn-1").label();
    assert!(label.contains("org-a"));
    assert!(label.contains("mtls_required"));
    // Eight characters of a public digest, never the whole thumbprint.
    assert!(!label.contains(&"a".repeat(64)));
    assert!(label.contains("cred=aaaaaaaa"));
}
