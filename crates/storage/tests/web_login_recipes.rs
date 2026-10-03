//! The recipe writer and the replay rule (ADR 0076 §4, ADR 0159): trust is
//! derived from a verification, never supplied; a pinned-then-revoked signer
//! stops a recipe at the next run; an unattended run needs a fresh canary and
//! an attended one does not; every change commits its audit with the row.

mod recipes_support;

use opensesame_storage::web_login_runs::recipes::{
    RecipeDeleteOutcome, RecipeUse, RecipeVerification, RecipeWriteOutcome,
};
use opensesame_storage::Db;
use recipes_support::*;

#[tokio::test]
async fn trust_is_derived_from_the_verification_and_never_supplied() {
    let db = Db::connect_memory().await.unwrap();
    pinned(&db, KEY).await;

    let candidate = put(&db, &write(None, "{\"steps\":1}", 0)).await;
    assert_eq!(
        (
            candidate.trust.as_str(),
            candidate.version,
            candidate.verified_at.as_deref()
        ),
        ("candidate", 1, None)
    );
    assert!(
        !runnable(&db, RecipeUse::Attended).await,
        "an unverified recipe is never replayed"
    );
    assert!(!runnable(&db, UNATTENDED).await);

    let signed = put(&db, &write(Some(verification(None)), "{\"steps\":1}", 1)).await;
    assert_eq!(
        (
            signed.trust.as_str(),
            signed.version,
            signed.signer_key_id.as_deref()
        ),
        ("candidate", 2, Some(KEY)),
        "a signature without a canary is not canary-verified"
    );
    assert_eq!(signed.verified_at.as_deref(), Some(NOW));
    assert!(
        runnable(&db, RecipeUse::Attended).await,
        "a person may drive a verified recipe"
    );
    assert!(
        !runnable(&db, UNATTENDED).await,
        "nobody may leave it to run alone"
    );

    let attested = put(
        &db,
        &write(Some(verification(Some(NOW))), "{\"steps\":1}", 2),
    )
    .await;
    assert_eq!(
        (
            attested.trust.as_str(),
            attested.canary_source.as_deref(),
            attested.canary_result.as_deref()
        ),
        ("canary_verified", Some("signed"), Some("passed"))
    );
    assert!(runnable(&db, UNATTENDED).await);
    assert_eq!(audit_rows(&db).await, 4, "the signer pin and three writes");
}

#[tokio::test]
async fn writes_are_compare_and_set() {
    let db = Db::connect_memory().await.unwrap();
    put(&db, &write(None, "{}", 0)).await;
    for stale in [0, 2] {
        assert_eq!(
            db.put_web_login_recipe_document(&write(None, "{\"b\":1}", stale), &AUDIT)
                .await
                .unwrap(),
            RecipeWriteOutcome::Conflict { current_version: 1 }
        );
    }
    assert_eq!(audit_rows(&db).await, 1, "a lost race appends nothing");
    assert_eq!(
        db.web_login_recipe(ORG, ORIGIN)
            .await
            .unwrap()
            .unwrap()
            .recipe_json,
        "{}"
    );
    assert_eq!(
        db.put_web_login_recipe_document(&write(None, "{}", 3), &AUDIT)
            .await
            .unwrap(),
        RecipeWriteOutcome::Conflict { current_version: 1 }
    );
    let mut elsewhere = write(None, "{}", 4);
    elsewhere.origin = "https://other.example";
    assert_eq!(
        db.put_web_login_recipe_document(&elsewhere, &AUDIT)
            .await
            .unwrap(),
        RecipeWriteOutcome::Conflict { current_version: 0 }
    );
    assert!(db
        .put_web_login_recipe_document(&write(None, "{}", -1), &AUDIT)
        .await
        .is_err());
}

#[tokio::test]
async fn a_revoked_signer_stops_a_recipe_now_and_blocks_a_later_write() {
    let db = Db::connect_memory().await.unwrap();
    pinned(&db, KEY).await;
    put(&db, &write(Some(verification(Some(NOW))), "{}", 0)).await;
    assert!(runnable(&db, UNATTENDED).await);

    db.revoke_web_login_recipe_signer(ORG, KEY, "operator", LATER, &AUDIT)
        .await
        .unwrap();
    assert!(
        !runnable(&db, RecipeUse::Attended).await,
        "revocation takes effect on the next run"
    );
    assert!(!runnable(&db, UNATTENDED).await);

    // The race: verified against the key, then it was revoked before the write.
    assert_eq!(
        db.put_web_login_recipe_document(&write(Some(verification(None)), "{}", 1), &AUDIT)
            .await
            .unwrap(),
        RecipeWriteOutcome::SignerNotPinned
    );
    let unknown = RecipeVerification {
        signer_key_id: "rsk_ffffffffffffffffffffffffffffffff",
        verified_at: NOW,
        canary_attested_at: None,
    };
    assert_eq!(
        db.put_web_login_recipe_document(&write(Some(unknown), "{}", 1), &AUDIT)
            .await
            .unwrap(),
        RecipeWriteOutcome::SignerNotPinned
    );
    assert_eq!(
        db.web_login_recipe(ORG, ORIGIN)
            .await
            .unwrap()
            .unwrap()
            .version,
        1
    );
}

#[tokio::test]
async fn expiry_and_canary_age_bound_a_replay() {
    let db = Db::connect_memory().await.unwrap();
    pinned(&db, KEY).await;
    put(&db, &write(Some(verification(Some(NOW))), "{}", 0)).await;
    let at = |now: &'static str, usage| {
        let db = db.clone();
        async move {
            db.runnable_web_login_recipe(ORG, ORIGIN, now, usage)
                .await
                .unwrap()
                .is_some()
        }
    };
    assert!(at("2026-11-30T00:00:00+00:00", RecipeUse::Attended).await);
    assert!(
        !at("2026-12-01T00:00:00+00:00", RecipeUse::Attended).await,
        "expired"
    );
    let stale = RecipeUse::Unattended {
        canary_not_before: "2026-10-01T00:00:01+00:00",
    };
    assert!(
        !at(LATER, stale).await,
        "a canary older than the cutoff is not proof"
    );
    assert!(
        at(
            LATER,
            RecipeUse::Unattended {
                canary_not_before: NOW
            }
        )
        .await
    );
    assert!(
        db.runnable_web_login_recipe("org:two", ORIGIN, LATER, RecipeUse::Attended)
            .await
            .unwrap()
            .is_none(),
        "recipes are per organization"
    );
}

#[tokio::test]
async fn a_row_written_before_recipes_had_a_writer_is_never_runnable() {
    let db = Db::connect_memory().await.unwrap();
    pinned(&db, KEY).await;
    // The shape of a row from before 0053: no document, no signer, no digest,
    // and a trust somebody simply wrote. Written raw, because no writer is left
    // that takes a trust as an input.
    sqlx::query(
        "INSERT INTO web_login_recipes \
         (organization_id, origin, recipe_id, trust, recipe_json, expires_at, created_at, \
          updated_at) VALUES (?, ?, 'rcp_old', 'corpus', '{}', ?, ?, ?)",
    )
    .bind(ORG)
    .bind(ORIGIN)
    .bind(EXPIRES)
    .bind(NOW)
    .bind(NOW)
    .execute(db.pool())
    .await
    .unwrap();
    assert!(!runnable(&db, RecipeUse::Attended).await);
    assert!(!runnable(&db, UNATTENDED).await);
    let old = db.web_login_recipe(ORG, ORIGIN).await.unwrap().unwrap();
    assert_eq!((old.version, old.document_json), (1, None));
    // And it can be replaced through the writer, from its version.
    let replaced = put(&db, &write(Some(verification(None)), "{}", 1)).await;
    assert_eq!(
        (replaced.version, replaced.trust.as_str()),
        (2, "candidate")
    );
}

#[tokio::test]
async fn recipes_list_by_origin_and_delete_by_version() {
    let db = Db::connect_memory().await.unwrap();
    put(&db, &write(None, "{}", 0)).await;
    let mut second = write(None, "{}", 0);
    second.origin = "https://another.example";
    put(&db, &second).await;
    let listed = db.list_web_login_recipes(ORG).await.unwrap();
    assert_eq!(
        listed.iter().map(|r| r.origin.as_str()).collect::<Vec<_>>(),
        ["https://another.example", ORIGIN]
    );
    assert!(db
        .list_web_login_recipes("org:two")
        .await
        .unwrap()
        .is_empty());

    assert_eq!(
        db.delete_web_login_recipe(ORG, ORIGIN, 9, &AUDIT)
            .await
            .unwrap(),
        RecipeDeleteOutcome::Conflict { current_version: 1 }
    );
    assert_eq!(
        db.delete_web_login_recipe(ORG, ORIGIN, 1, &AUDIT)
            .await
            .unwrap(),
        RecipeDeleteOutcome::Deleted
    );
    assert_eq!(
        db.delete_web_login_recipe(ORG, ORIGIN, 1, &AUDIT)
            .await
            .unwrap(),
        RecipeDeleteOutcome::NotFound
    );
    assert_eq!(audit_rows(&db).await, 3, "two writes and one delete");
}

#[tokio::test]
async fn the_table_itself_refuses_a_trust_it_does_not_know() {
    let db = Db::connect_memory().await.unwrap();
    let insert = |trust: &'static str| {
        sqlx::query(
            "INSERT INTO web_login_recipes \
             (organization_id, origin, recipe_id, trust, recipe_json, expires_at, created_at, \
              updated_at) VALUES (?, ?, 'rcp_1', ?, '{}', ?, ?, ?)",
        )
        .bind(ORG)
        .bind(ORIGIN)
        .bind(trust)
        .bind(EXPIRES)
        .bind(NOW)
        .bind(NOW)
        .execute(db.pool())
    };
    assert!(insert("trusted_because_i_said_so").await.is_err());
    assert!(insert("candidate").await.is_ok());
}
