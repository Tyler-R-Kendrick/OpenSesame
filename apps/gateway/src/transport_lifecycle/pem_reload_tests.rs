//! AT-ROTATE-ATOMIC for the `pem` identity source: an external renewer
//! replaces the files, the listener picks the successor up, and a bad
//! replacement changes nothing except a recorded fact.

use std::sync::Arc;

use chrono::{Duration, Utc};
use opensesame_domain::transport::ServiceBindingSet;
use opensesame_transport_security::testkit::DisposableCa;

use crate::app_state::AppState;
use crate::transport::test_support as fixtures;
use crate::transport_lifecycle::pem_reload::{pass, Pass, Watch};
use crate::transport_lifecycle::{facts, test_support as support, HOST_LISTENER_TARGET};

/// A state whose runtime serves `generations` from a `pem` pair on disk, with
/// the lifecycle attached exactly as `transport_lifecycle::boot` attaches it.
async fn wired(
    cert: std::path::PathBuf,
    key: std::path::PathBuf,
    generations: Arc<opensesame_transport_security::TransportGenerations>,
) -> AppState {
    let mut state = support::state().await;
    state.transport = Some(fixtures::runtime_serving(
        Arc::clone(&generations),
        ServiceBindingSet::empty(),
        fixtures::pem_config(cert, key),
    ));
    state
        .transport_lifecycle
        .attach_generations(generations, std::collections::BTreeMap::new());
    state
}

#[tokio::test]
async fn the_first_pass_only_learns_the_stamp_and_an_unchanged_pair_is_not_re_read() {
    let dir = tempfile::tempdir().expect("tempdir");
    let ca = DisposableCa::new("servers");
    let leaf = ca.issue_server("localhost");
    let (cert, key) = leaf.write_to(dir.path());
    let generations = support::generations(leaf.identity(), &ca);
    let state = wired(cert, key, Arc::clone(&generations)).await;

    let mut watch = Watch::new();
    assert_eq!(pass(&state, &mut watch).await, Pass::Primed);
    assert_eq!(pass(&state, &mut watch).await, Pass::Unchanged);
    assert_eq!(
        generations.current().number,
        1,
        "watching files must never activate anything by itself",
    );
}

#[tokio::test]
async fn a_replaced_pair_is_activated_as_the_next_generation() {
    let dir = tempfile::tempdir().expect("tempdir");
    let ca = DisposableCa::new("servers");
    let first = ca.issue_server("localhost");
    let (cert, key) = first.write_to(dir.path());
    let generations = support::generations(first.identity(), &ca);
    let state = wired(cert.clone(), key.clone(), Arc::clone(&generations)).await;

    let mut watch = Watch::new();
    assert_eq!(pass(&state, &mut watch).await, Pass::Primed);

    // The external renewer writes a successor over the same two paths.
    let now = Utc::now();
    let second =
        support::server_leaf_between(&ca, now - Duration::minutes(1), now + Duration::days(30));
    std::fs::write(&cert, &second.cert_pem).expect("write cert");
    std::fs::write(&key, secrecy::ExposeSecret::expose_secret(&second.key_pem)).expect("write key");

    assert_eq!(pass(&state, &mut watch).await, Pass::Reloaded(2));
    let current = generations.current();
    assert_eq!(current.number, 2);
    assert_eq!(
        current
            .identity
            .as_ref()
            .expect("identity")
            .leaf_thumbprint_sha256(),
        second.thumbprint,
    );
    let recorded = facts::load(&state, HOST_LISTENER_TARGET)
        .await
        .expect("facts");
    assert!(recorded.latest("loaded").is_some());
    assert!(recorded.latest("active").is_some());
}

#[tokio::test]
async fn a_mismatched_replacement_records_reload_failed_and_leaves_the_expiry_untouched() {
    let dir = tempfile::tempdir().expect("tempdir");
    let ca = DisposableCa::new("servers");
    let first = ca.issue_server("localhost");
    let (cert, key) = first.write_to(dir.path());
    let generations = support::generations(first.identity(), &ca);
    let state = wired(cert.clone(), key.clone(), Arc::clone(&generations)).await;
    let before = generations.current();
    let before_expiry = before.identity.as_ref().expect("identity").not_after();

    let mut watch = Watch::new();
    assert_eq!(pass(&state, &mut watch).await, Pass::Primed);

    // A certificate written over the old one while its key is still the
    // previous leaf's: the half-written state a file-based renewer really
    // produces.
    let other = ca.issue_server("localhost");
    std::fs::write(&cert, &other.cert_pem).expect("write cert");

    let outcome = pass(&state, &mut watch).await;
    let Pass::Refused(error) = outcome else {
        panic!("a mismatched pair must be refused, got {outcome:?}");
    };
    assert_eq!(error.code(), "key_pair_mismatch");

    let after = generations.current();
    assert_eq!(after.number, before.number, "the generation must not move");
    assert_eq!(
        after.identity.as_ref().expect("identity").not_after(),
        before_expiry,
        "a failed reload must leave the serving certificate's expiry exactly as it was",
    );
    let recorded = facts::load(&state, HOST_LISTENER_TARGET)
        .await
        .expect("facts");
    let latest = recorded
        .latest("reload_failed")
        .expect("a reload_failed fact");
    assert!(
        matches!(latest, facts::Fact::ReloadFailed { code, .. } if code == "key_pair_mismatch"),
        "{latest:?}",
    );
}

#[tokio::test]
async fn an_unreadable_replacement_is_refused_rather_than_taking_the_listener_down() {
    let dir = tempfile::tempdir().expect("tempdir");
    let ca = DisposableCa::new("servers");
    let leaf = ca.issue_server("localhost");
    let (cert, key) = leaf.write_to(dir.path());
    let generations = support::generations(leaf.identity(), &ca);
    let state = wired(cert.clone(), key, Arc::clone(&generations)).await;

    let mut watch = Watch::new();
    assert_eq!(pass(&state, &mut watch).await, Pass::Primed);
    std::fs::remove_file(&cert).expect("remove cert");

    let outcome = pass(&state, &mut watch).await;
    assert!(
        matches!(outcome, Pass::Refused(_)),
        "a vanished file is a refusal, not a panic: {outcome:?}",
    );
    assert_eq!(generations.current().number, 1);
}

#[tokio::test]
async fn a_non_pem_source_is_never_watched() {
    // A managed or SPIFFE identity has its own path; the file watcher must
    // not invent a second one for it.
    let state = support::state().await;
    assert_eq!(pass(&state, &mut Watch::new()).await, Pass::NotApplicable);
}

/// The production call site: the renewal loop runs this pass, and nothing
/// else does — there is no private expiry check here.
#[test]
fn the_renewal_loop_is_the_one_caller() {
    let src = include_str!("renewal.rs");
    assert!(src.contains("pem_reload::pass_and_log(&state, &mut pem_watch)"));
    let module = include_str!("pem_reload.rs");
    assert!(
        module.contains("activation::activate_pem"),
        "the reload must go through the one atomic activation path",
    );
    assert!(
        !module.contains("not_after() <") && !module.contains("renew_before"),
        "expiry is the ADR 0074 feed's business, never this module's",
    );
}
