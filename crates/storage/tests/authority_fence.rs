//! Root/ancestor invalidation fencing: the fence and the cascade (ADR 0121).
//!
//! `opensesame-lifecycle`'s own tests cover the decision. These cover the
//! part that can only be checked against a real database: that a revoke is
//! one write, that a descendant is blocked without anything having visited
//! it, and that the cascade is a bounded range scan rather than a walk.
//! Freshness, races and status reporting are in
//! `authority_fence_freshness.rs`.

mod fence_support;

use chrono::Utc;
use opensesame_domain::OrganizationId;
use opensesame_lifecycle::FenceVerdict;
use opensesame_storage::authority_fence;

use fence_support::{child_of, db, root_grant, seed_chain, seed_organization, status};

// —— LIFE-FENCE ———————————————————————————————————————————————————

#[tokio::test]
async fn a_freshly_issued_chain_authorizes_at_every_depth() {
    let db = db().await;
    let chain = seed_chain(&db, 3).await;
    for grant in &chain {
        assert!(
            status(&db, grant).await.authorizes(),
            "depth {} was fenced before anything was revoked",
            grant.delegation_depth
        );
    }
}

#[tokio::test]
async fn revoking_the_root_blocks_every_descendant_at_the_commit() {
    // The property the fence exists for. Only the root is named; no
    // descendant is visited, and none needs to be.
    let db = db().await;
    let chain = seed_chain(&db, 4).await;
    let root = &chain[0];

    let commit = db
        .fence_grant(
            &root.id.to_string(),
            authority_fence::REASON_OWNER_REVOKED,
            Utc::now(),
        )
        .await
        .expect("root fences");
    assert!(commit.newly_fenced);

    // Exactly one invalidation row exists for the whole subtree.
    let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM grant_invalidations")
        .fetch_one(db.pool())
        .await
        .expect("count");
    assert_eq!(
        rows, 1,
        "revocation enumerated descendants instead of fencing them"
    );

    for grant in &chain {
        let verdict = status(&db, grant).await;
        assert!(
            !verdict.authorizes(),
            "depth {} survived its root's revocation",
            grant.delegation_depth
        );
        let FenceVerdict::Invalidated { blocked_by, .. } = verdict else {
            panic!(
                "expected an invalidation at depth {}",
                grant.delegation_depth
            );
        };
        assert_eq!(
            blocked_by,
            root.id.to_string(),
            "the cause named was not the root"
        );
    }
}

#[tokio::test]
async fn revoking_an_intermediate_spares_its_ancestors() {
    let db = db().await;
    let chain = seed_chain(&db, 3).await;
    db.fence_grant(
        &chain[2].id.to_string(),
        authority_fence::REASON_OWNER_REVOKED,
        Utc::now(),
    )
    .await
    .expect("fences");

    assert!(status(&db, &chain[0]).await.authorizes(), "root was taken");
    assert!(
        status(&db, &chain[1]).await.authorizes(),
        "parent was taken"
    );
    assert!(!status(&db, &chain[2]).await.authorizes());
    assert!(!status(&db, &chain[3]).await.authorizes());
}

#[tokio::test]
async fn a_sibling_subtree_is_untouched() {
    // Two children under one root; revoking one must not reach the other,
    // which is what a prefix range gets right and a sloppy `LIKE` would not.
    let db = db().await;
    let now = Utc::now();
    let organization_id = OrganizationId::new();
    seed_organization(&db, organization_id).await;
    let root = root_grant(organization_id, now);
    db.insert_grant(&root).await.expect("root");
    let left = child_of(&root, now);
    let right = child_of(&root, now);
    db.insert_grant(&left).await.expect("left");
    db.insert_grant(&right).await.expect("right");
    let left_child = child_of(&left, now);
    db.insert_grant(&left_child).await.expect("left child");

    db.fence_grant(
        &left.id.to_string(),
        authority_fence::REASON_OWNER_REVOKED,
        now,
    )
    .await
    .expect("fences");

    assert!(!status(&db, &left).await.authorizes());
    assert!(!status(&db, &left_child).await.authorizes());
    assert!(
        status(&db, &right).await.authorizes(),
        "a sibling was swept up in the cascade"
    );
    assert!(status(&db, &root).await.authorizes());
}

// —— LIFE-CASCADE —————————————————————————————————————————————————

#[tokio::test]
async fn the_cascade_closes_descendant_columns_in_the_same_commit() {
    // Bookkeeping, not enforcement — but it must not lag, because the expiry
    // scanner and every listing read these columns.
    let db = db().await;
    let chain = seed_chain(&db, 3).await;
    let commit = db
        .fence_grant(
            &chain[0].id.to_string(),
            authority_fence::REASON_OWNER_REVOKED,
            Utc::now(),
        )
        .await
        .expect("fences");

    // Four grants in the chain, all closed by one statement.
    assert_eq!(commit.cascaded_grants, 4);

    let live: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM grants WHERE revoked_at IS NULL")
        .fetch_one(db.pool())
        .await
        .expect("count");
    assert_eq!(
        live, 0,
        "a descendant column was left open after the commit"
    );
}

#[tokio::test]
async fn refencing_an_already_fenced_grant_does_not_reorder_history() {
    let db = db().await;
    let chain = seed_chain(&db, 1).await;
    let id = chain[0].id.to_string();
    let first = db
        .fence_grant(&id, authority_fence::REASON_OWNER_REVOKED, Utc::now())
        .await
        .expect("first");
    let second = db
        .fence_grant(&id, authority_fence::REASON_OWNER_REVOKED, Utc::now())
        .await
        .expect("second");

    assert!(first.newly_fenced);
    assert!(!second.newly_fenced, "a retry re-fenced the grant");
    assert_eq!(
        first.sequence, second.sequence,
        "a retried revoke moved its position in the order"
    );
}
