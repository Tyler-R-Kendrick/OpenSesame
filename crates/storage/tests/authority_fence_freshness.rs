//! Root/ancestor invalidation fencing: freshness, races, and status
//! (ADR 0121).
//!
//! The half of the durable suite that is about *not knowing*: every way the
//! fence can fail to establish an answer must deny, a revoke's commit must be
//! the point every reader is ordered around, and the status surface must
//! report what it actually checked. The fence and cascade proper are in
//! `authority_fence.rs`.

mod fence_support;

use chrono::Utc;
use opensesame_domain::OrganizationId;
use opensesame_lifecycle::{FenceVerdict, Freshness, Uncertainty};
use opensesame_storage::authority_fence;

use fence_support::{child_of, db, root_grant, seed_chain, seed_organization, status};

// —— LIFE-FRESH ———————————————————————————————————————————————————

#[tokio::test]
async fn a_grant_with_no_lineage_row_denies() {
    // The upgrade and the bug case: a grant written by a path that did not
    // record lineage. Its ancestry is unknown, so it cannot be cleared.
    let db = db().await;
    let now = Utc::now();
    let organization_id = OrganizationId::new();
    seed_organization(&db, organization_id).await;
    let orphan = root_grant(organization_id, now);
    sqlx::query(
        "INSERT INTO grants (id, organization_id, body_json, revoked_at, created_at)
         VALUES (?, ?, ?, NULL, ?)",
    )
    .bind(orphan.id.to_string())
    .bind(orphan.organization_id.to_string())
    .bind(serde_json::to_string(&orphan).expect("serialize"))
    .bind(orphan.created_at.to_rfc3339())
    .execute(db.pool())
    .await
    .expect("grant inserts behind the fence's back");

    let verdict = status(&db, &orphan).await;
    assert!(!verdict.authorizes(), "an ungrounded grant authorized");
    assert!(matches!(
        verdict,
        FenceVerdict::Indeterminate {
            cause: Uncertainty::LineageMissing { .. }
        }
    ));
}

#[tokio::test]
async fn an_ungrounded_grant_cannot_be_fenced_and_says_so() {
    // Fencing it would report success while leaving descendants live.
    let db = db().await;
    let error = db
        .fence_grant(
            "grant:00000000-0000-7000-8000-000000000000",
            authority_fence::REASON_OWNER_REVOKED,
            Utc::now(),
        )
        .await
        .expect_err("fencing an unknown grant must fail");
    assert!(error.to_string().contains("no recorded lineage"));
}

#[tokio::test]
async fn a_child_whose_parent_has_no_lineage_is_refused_at_write_time() {
    // Recording it as a root would mint a grant the fence could never reach
    // from above, so the refusal belongs here rather than at read time.
    let db = db().await;
    let now = Utc::now();
    let organization_id = OrganizationId::new();
    seed_organization(&db, organization_id).await;
    let parent = root_grant(organization_id, now);
    let child = child_of(&parent, now);
    // The realm exists, so the refusal below is about the missing lineage and
    // not about a foreign key.
    let error = db
        .insert_grant(&child)
        .await
        .expect_err("a child of an unknown parent must not be written");
    assert!(error.to_string().contains("no recorded lineage"));
}

#[tokio::test]
async fn a_reading_from_behind_an_observed_sequence_denies() {
    // Freshness is the caller's floor. Having seen the fence at a point, it
    // must not then accept an answer from before it.
    let db = db().await;
    let chain = seed_chain(&db, 1).await;
    let verdict = db
        .fence_status(&chain[1].id.to_string(), Freshness::at_least(99))
        .await;
    assert!(!verdict.authorizes());
    assert!(matches!(
        verdict,
        FenceVerdict::Indeterminate {
            cause: Uncertainty::Stale { .. }
        }
    ));
}

#[tokio::test]
async fn a_lineage_row_that_disagrees_with_its_own_path_denies() {
    // One of the two is stale, and neither can then be trusted to say which
    // ancestors to check.
    let db = db().await;
    let chain = seed_chain(&db, 1).await;
    sqlx::query("UPDATE grant_lineage SET root_grant_id = ? WHERE grant_id = ?")
        .bind("grant:00000000-0000-7000-8000-0000000000ff")
        .bind(chain[1].id.to_string())
        .execute(db.pool())
        .await
        .expect("corrupt the row");

    let verdict = status(&db, &chain[1]).await;
    assert!(!verdict.authorizes());
    assert!(matches!(
        verdict,
        FenceVerdict::Indeterminate {
            cause: Uncertainty::LineageInconsistent { .. }
        }
    ));
}

// —— LIFE-RACE ————————————————————————————————————————————————————

#[tokio::test]
async fn no_authorization_succeeds_after_the_revoke_commits() {
    // The linearization point, asserted directly: the moment `fence_grant`
    // returns, every subsequent read denies — including for a descendant
    // nothing has visited.
    let db = db().await;
    let chain = seed_chain(&db, 3).await;
    let deepest = chain.last().expect("a leaf").clone();

    assert!(status(&db, &deepest).await.authorizes());
    db.fence_grant(
        &chain[0].id.to_string(),
        authority_fence::REASON_OWNER_REVOKED,
        Utc::now(),
    )
    .await
    .expect("fences");

    for attempt in 0..25 {
        assert!(
            !status(&db, &deepest).await.authorizes(),
            "attempt {attempt} authorized after the revoke had committed"
        );
    }
}

#[tokio::test]
async fn a_reader_racing_a_revoke_never_straddles_the_commit() {
    // Readers run concurrently with the revoke. Each one is ordered before or
    // after the commit, so the allowed answers are a prefix: once any reader
    // has been denied, no later reader may be allowed. A fence that cascaded
    // asynchronously would fail this by allowing a descendant after an
    // ancestor had already been refused.
    let db = db().await;
    let chain = seed_chain(&db, 3).await;
    let leaf = chain.last().expect("a leaf").clone();
    let root_id = chain[0].id.to_string();

    let reader_db = db.clone();
    let reader_leaf = leaf.clone();
    let reader = tokio::spawn(async move {
        let mut observations = Vec::new();
        for _ in 0..200 {
            observations.push(
                reader_db
                    .fence_status(&reader_leaf.id.to_string(), Freshness::any())
                    .await
                    .authorizes(),
            );
            tokio::task::yield_now().await;
        }
        observations
    });

    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    db.fence_grant(&root_id, authority_fence::REASON_OWNER_REVOKED, Utc::now())
        .await
        .expect("fences");

    let observations = reader.await.expect("reader finishes");
    let first_denial = observations.iter().position(|allowed| !allowed);
    if let Some(index) = first_denial {
        assert!(
            observations[index..].iter().all(|allowed| !allowed),
            "an authorization succeeded after an earlier one had been denied"
        );
    }
    // And the state after the race is settled is a denial, whatever the
    // interleaving was.
    assert!(!status(&db, &leaf).await.authorizes());
}

#[tokio::test]
async fn concurrent_revokes_take_distinct_positions_in_the_order() {
    // Two roots fenced at once. Whatever the interleaving, the sequence is a
    // total order with no duplicates — that is what makes it usable as a
    // freshness floor.
    let db = db().await;
    let first = seed_chain(&db, 0).await;
    let second = seed_chain(&db, 0).await;

    let first_id = first[0].id.to_string();
    let second_id = second[0].id.to_string();
    let (left, right) = tokio::join!(
        db.fence_grant(&first_id, authority_fence::REASON_OWNER_REVOKED, Utc::now()),
        db.fence_grant(
            &second_id,
            authority_fence::REASON_OWNER_REVOKED,
            Utc::now()
        ),
    );
    let left = left.expect("left fences");
    let right = right.expect("right fences");
    assert_ne!(
        left.sequence, right.sequence,
        "two revokes claimed the same position"
    );
    assert_eq!(
        db.fence_high_water().await.expect("mark"),
        left.sequence.max(right.sequence)
    );
}

// —— LIFE-STATUS ——————————————————————————————————————————————————

#[tokio::test]
async fn the_high_water_mark_advances_only_with_a_revocation() {
    let db = db().await;
    assert_eq!(db.fence_high_water().await.expect("mark"), 0);
    let chain = seed_chain(&db, 2).await;
    assert_eq!(
        db.fence_high_water().await.expect("mark"),
        0,
        "issuing grants moved the revocation order"
    );

    let commit = db
        .fence_grant(
            &chain[1].id.to_string(),
            authority_fence::REASON_OWNER_REVOKED,
            Utc::now(),
        )
        .await
        .expect("fences");
    assert_eq!(db.fence_high_water().await.expect("mark"), commit.sequence);
}

#[tokio::test]
async fn a_clear_verdict_reports_the_root_and_the_depth_it_checked() {
    let db = db().await;
    let chain = seed_chain(&db, 2).await;
    let verdict = status(&db, &chain[2]).await;
    let FenceVerdict::Clear {
        root_grant_id,
        depth,
        ..
    } = verdict
    else {
        panic!("expected a clear verdict");
    };
    assert_eq!(root_grant_id, chain[0].id.to_string());
    assert_eq!(depth, 2);
}

#[tokio::test]
async fn a_verdict_explains_itself_without_naming_a_value() {
    let db = db().await;
    let chain = seed_chain(&db, 1).await;
    db.fence_grant(
        &chain[0].id.to_string(),
        authority_fence::REASON_OWNER_REVOKED,
        Utc::now(),
    )
    .await
    .expect("fences");

    let reason = status(&db, &chain[1]).await.reason();
    assert!(reason.contains("ancestor"), "{reason}");
    assert!(
        reason.contains(authority_fence::REASON_OWNER_REVOKED),
        "{reason}"
    );
}

// —— the legacy chain check ———————————————————————————————————————

#[tokio::test]
async fn assert_grant_chain_active_now_answers_from_the_fence() {
    // The per-hop walk is gone; this is the same question asked once.
    let db = db().await;
    let chain = seed_chain(&db, 2).await;
    let now = Utc::now();
    let leaf = chain.last().expect("a leaf");

    db.assert_grant_chain_active(leaf, now)
        .await
        .expect("a live chain is active");

    db.fence_grant(
        &chain[0].id.to_string(),
        authority_fence::REASON_OWNER_REVOKED,
        now,
    )
    .await
    .expect("fences");

    let error = db
        .assert_grant_chain_active(leaf, now)
        .await
        .expect_err("a dead root must refuse its descendants");
    assert!(error.to_string().contains("refused"), "{error}");
}

#[tokio::test]
async fn revoke_grant_goes_through_the_fence_and_is_idempotent() {
    let db = db().await;
    let chain = seed_chain(&db, 1).await;
    let now = Utc::now();

    assert!(
        db.revoke_grant(&chain[0].id, now).await.expect("revokes"),
        "the first revoke should report having done something"
    );
    assert!(
        !db.revoke_grant(&chain[0].id, now).await.expect("revokes"),
        "the second revoke should be a no-op"
    );
    // And the descendant is blocked, which the old column-only revoke could
    // not have achieved on its own.
    assert!(!status(&db, &chain[1]).await.authorizes());
}
