//! Service bindings: precedence, bounds, and compare-and-set.
//!
//! Configuration is authority, so the failure modes matter more than the
//! happy path: a stored document that no longer parses is an error (never an
//! empty, permissive-looking default), an oversized document is refused
//! before it is parsed, and a replacement is validated before it is stored.

use opensesame_domain::transport::{BindingPurpose, ServiceBindingSet};
use opensesame_storage::Db;

use super::bindings::{self, BindingsSource, PutError, KV_SERVICE_BINDINGS, MAX_BINDINGS_BYTES};
use super::test_support::{binding, set};

fn one() -> ServiceBindingSet {
    set(vec![binding(
        "b1",
        "bridge.test",
        BindingPurpose::NatsAuthBridge,
        &["nats.callout.decide"],
        opensesame_domain::transport::BindingScope::Deployment,
    )])
}

#[tokio::test]
async fn precedence_is_env_file_then_store_then_empty() {
    let db = Db::connect_memory().await.expect("db");
    let empty = bindings::load(&db, None).await.expect("default");
    assert_eq!(empty.source, BindingsSource::Default);
    assert!(empty.set.bindings.is_empty());

    db.set_host_kv(KV_SERVICE_BINDINGS, &serde_json::to_string(&one()).unwrap())
        .await
        .expect("store");
    let stored = bindings::load(&db, None).await.expect("stored");
    assert_eq!(stored.source, BindingsSource::Stored);
    assert_eq!(stored.set.bindings.len(), 1);

    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("bindings.json");
    std::fs::write(
        &path,
        serde_json::to_string(&ServiceBindingSet::empty()).unwrap(),
    )
    .unwrap();
    let from_env = bindings::load(&db, Some(&path)).await.expect("env");
    assert_eq!(from_env.source, BindingsSource::Env);
    assert!(from_env.set.bindings.is_empty());
}

#[tokio::test]
async fn an_invalid_stored_document_is_an_error_not_an_empty_default() {
    let db = Db::connect_memory().await.expect("db");
    db.set_host_kv(KV_SERVICE_BINDINGS, "{\"revision\":1,\"bindings\":[{}]}")
        .await
        .expect("store");
    assert!(bindings::load(&db, None).await.is_err());
}

#[test]
fn unknown_fields_and_oversized_documents_are_refused() {
    assert!(bindings::parse_bounded("{\"revision\":1,\"bindings\":[],\"extra\":1}").is_err());
    let oversized = format!(
        "{{\"revision\":1,\"bindings\":[],\"pad\":\"{}\"}}",
        "p".repeat(MAX_BINDINGS_BYTES)
    );
    assert!(bindings::parse_bounded(&oversized).is_err());
}

#[test]
fn a_missing_or_unreadable_file_is_an_error() {
    let dir = tempfile::tempdir().expect("tempdir");
    assert!(bindings::load_file(&dir.path().join("absent.json")).is_err());
    let path = dir.path().join("bad.json");
    std::fs::write(&path, "not json").unwrap();
    assert!(bindings::load_file(&path).is_err());
}

#[tokio::test]
async fn put_is_compare_and_set_and_the_env_file_wins() {
    let db = Db::connect_memory().await.expect("db");
    let live = std::sync::RwLock::new(ServiceBindingSet::empty());

    // Stale revision refused.
    let mut stale = one();
    stale.revision = 7;
    assert_eq!(
        bindings::put_cas(&db, BindingsSource::Default, Some(&live), stale).await,
        Err(PutError::StaleRevision { current: 1 })
    );

    // Correct revision stores and advances.
    let stored = bindings::put_cas(&db, BindingsSource::Default, Some(&live), one())
        .await
        .expect("stored");
    assert_eq!(stored.revision, 2);
    assert_eq!(live.read().unwrap().revision, 2);
    assert_eq!(
        bindings::load(&db, None)
            .await
            .expect("reload")
            .set
            .revision,
        2
    );

    // The env file is the deployment plane's; the store is not consulted.
    assert_eq!(
        bindings::put_cas(&db, BindingsSource::Env, Some(&live), one()).await,
        Err(PutError::EnvOverride)
    );
}

#[tokio::test]
async fn a_replacement_is_validated_before_it_is_stored() {
    let db = Db::connect_memory().await.expect("db");
    let live = std::sync::RwLock::new(ServiceBindingSet::empty());
    let mut invalid = one();
    invalid.bindings[0].allowed_operations.clear();
    assert!(matches!(
        bindings::put_cas(&db, BindingsSource::Default, Some(&live), invalid).await,
        Err(PutError::Invalid(_))
    ));
    // Nothing was written and the live set is untouched.
    assert!(db
        .get_host_kv(KV_SERVICE_BINDINGS)
        .await
        .expect("read")
        .is_none());
    assert_eq!(live.read().unwrap().revision, 1);
}

#[test]
fn a_denied_thumbprint_is_visible_to_the_listener_hook() {
    let mut bindings_set = one();
    bindings_set.bindings[0]
        .denied_thumbprints
        .push("a".repeat(64));
    assert!(bindings::denies_thumbprint(&bindings_set, &"a".repeat(64)));
    assert!(!bindings::denies_thumbprint(&bindings_set, &"b".repeat(64)));
}
