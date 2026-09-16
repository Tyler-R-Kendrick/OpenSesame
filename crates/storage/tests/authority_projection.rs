//! Projections, freshness fences, and the writer topology.
//!
//! The cases here are the ones the storage swarm was told to refuse rather than
//! paper over: a projection that reports itself ahead of the ledger, a projection
//! that goes backwards, a tuple applied under a different authorization model, an
//! absent projection treated as caught up, and two writers on a single-writer
//! store.

mod authority_support;

use opensesame_storage::authority::{ProjectionMark, WriterLease};
use opensesame_storage::Db;

fn mark(revision: i64) -> ProjectionMark<'static> {
    ProjectionMark {
        store: "openfga",
        organization_id: "org:one",
        subject_kind: "grant",
        subject_id: "grant:root",
        committed_revision: revision,
    }
}

#[tokio::test]
async fn an_absent_projection_is_unknown_state_and_denies() {
    let db = Db::connect_memory().await.unwrap();
    assert!(
        !db.projection_applied(&mark(1), None).await.unwrap(),
        "no row is not the same as caught up"
    );
}

#[tokio::test]
async fn a_projection_satisfies_a_fence_only_once_it_has_applied_the_revision() {
    let db = Db::connect_memory().await.unwrap();
    db.mark_projection_dirty(&mark(4)).await.unwrap();
    assert!(!db.projection_applied(&mark(4), None).await.unwrap());

    assert!(db
        .record_projection_applied(&mark(3), Some("model:1"))
        .await
        .unwrap());
    assert!(
        !db.projection_applied(&mark(4), None).await.unwrap(),
        "applied 3 does not satisfy a fence at 4"
    );

    assert!(db
        .record_projection_applied(&mark(4), Some("model:1"))
        .await
        .unwrap());
    assert!(db.projection_applied(&mark(4), None).await.unwrap());
}

#[tokio::test]
async fn a_projection_cannot_claim_a_revision_the_authority_never_committed() {
    let db = Db::connect_memory().await.unwrap();
    db.mark_projection_dirty(&mark(2)).await.unwrap();
    assert!(
        !db.record_projection_applied(&mark(9), Some("model:1"))
            .await
            .unwrap(),
        "a projection ahead of the ledger would authorize a state nobody approved"
    );
    assert!(!db.projection_applied(&mark(2), None).await.unwrap());
}

#[tokio::test]
async fn a_projection_never_goes_backwards() {
    let db = Db::connect_memory().await.unwrap();
    db.mark_projection_dirty(&mark(5)).await.unwrap();
    assert!(db
        .record_projection_applied(&mark(5), Some("model:1"))
        .await
        .unwrap());
    assert!(
        !db.record_projection_applied(&mark(2), Some("model:1"))
            .await
            .unwrap(),
        "a replayed older application must not lower the applied revision"
    );
    assert!(db.projection_applied(&mark(5), None).await.unwrap());
}

#[tokio::test]
async fn a_tuple_applied_under_another_model_does_not_satisfy_the_fence() {
    let db = Db::connect_memory().await.unwrap();
    db.mark_projection_dirty(&mark(1)).await.unwrap();
    db.record_projection_applied(&mark(1), Some("model:old"))
        .await
        .unwrap();
    assert!(db
        .projection_applied(&mark(1), Some("model:old"))
        .await
        .unwrap());
    assert!(
        !db.projection_applied(&mark(1), Some("model:pinned"))
            .await
            .unwrap(),
        "the same tuple under a different authorization model is a different fact"
    );
}

#[tokio::test]
async fn a_failed_projection_stays_dirty() {
    let db = Db::connect_memory().await.unwrap();
    db.mark_projection_dirty(&mark(2)).await.unwrap();
    assert!(db
        .record_projection_error(&mark(2), "openfga unavailable")
        .await
        .unwrap());
    assert!(!db.projection_applied(&mark(2), None).await.unwrap());
}

#[tokio::test]
async fn only_one_writer_holds_the_store_and_the_other_is_refused() {
    let db = Db::connect_memory().await.unwrap();
    let first = db
        .acquire_writer_lease("writer:one", 60)
        .await
        .unwrap()
        .expect("first writer takes the lease");
    assert!(
        db.acquire_writer_lease("writer:two", 60)
            .await
            .unwrap()
            .is_none(),
        "a live lease is not shareable — this is a single-writer store"
    );
    db.assert_writer_lease(&first).await.unwrap();

    // A renewal by the holder keeps its fence token, so its in-flight writes stay
    // valid.
    let renewed = db
        .acquire_writer_lease("writer:one", 60)
        .await
        .unwrap()
        .expect("the holder may renew");
    assert_eq!(renewed.fence_token, first.fence_token);
}

#[tokio::test]
async fn a_writer_that_lost_the_lease_is_refused_by_its_own_fence_token() {
    let db = Db::connect_memory().await.unwrap();
    let first = db
        .acquire_writer_lease("writer:one", 1)
        .await
        .unwrap()
        .unwrap();
    // The lease expired and the other writer took over, which advanced the token.
    tokio::time::sleep(std::time::Duration::from_millis(1100)).await;
    let second = db
        .acquire_writer_lease("writer:two", 60)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(second.fence_token, first.fence_token + 1);

    let refused = db.assert_writer_lease(&first).await;
    assert!(
        refused.is_err(),
        "the previous writer must be refused, not left to interleave"
    );
    db.assert_writer_lease(&second).await.unwrap();
    assert_eq!(
        second,
        WriterLease {
            writer_id: "writer:two".to_owned(),
            fence_token: 2,
        }
    );
}
