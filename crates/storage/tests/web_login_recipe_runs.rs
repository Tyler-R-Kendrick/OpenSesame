//! What a run proves about the document it replayed (ADR 0076 §4): a pass
//! makes a verified recipe canary-verified, a failure demotes it, a recipe
//! replaced since is not credited, and a renewal of the same steps keeps the
//! proof while different steps lose it.

mod recipes_support;

use opensesame_storage::web_login_runs::recipes::{RecipeUse, RunResult};
use opensesame_storage::Db;
use recipes_support::*;

#[tokio::test]
async fn a_run_records_what_it_proved_about_the_document_it_replayed() {
    let db = Db::connect_memory().await.unwrap();
    pinned(&db, KEY).await;
    put(&db, &write(Some(verification(None)), "{\"steps\":1}", 0)).await;
    let record = |db: &Db, digest: &'static str, result| {
        let db = db.clone();
        async move {
            db.record_web_login_recipe_run(ORG, ORIGIN, digest, result, "run_1", LATER)
                .await
                .unwrap()
        }
    };

    assert!(
        !record(&db, "sha256:other", RunResult::Passed).await,
        "another document is not touched"
    );
    assert!(!runnable(&db, UNATTENDED).await);

    assert!(record(&db, "sha256:aa", RunResult::Passed).await);
    let row = db.web_login_recipe(ORG, ORIGIN).await.unwrap().unwrap();
    assert_eq!(
        (
            row.trust.as_str(),
            row.canary_source.as_deref(),
            row.canary_run_id.as_deref(),
            row.version
        ),
        ("canary_verified", Some("run"), Some("run_1"), 1),
        "recording a canary is not an operator edit"
    );
    assert!(runnable(&db, UNATTENDED).await);

    assert!(record(&db, "sha256:aa", RunResult::Failed).await);
    let row = db.web_login_recipe(ORG, ORIGIN).await.unwrap().unwrap();
    assert_eq!(
        (row.trust.as_str(), row.canary_result.as_deref()),
        ("candidate", Some("failed"))
    );
    assert!(
        !runnable(&db, UNATTENDED).await,
        "a failed run demotes the recipe"
    );
    assert!(
        runnable(&db, RecipeUse::Attended).await,
        "and a person may prove it again"
    );
}

#[tokio::test]
async fn an_unverified_recipe_cannot_pass_a_canary_into_trust() {
    let db = Db::connect_memory().await.unwrap();
    put(&db, &write(None, "{}", 0)).await;
    assert!(!db
        .record_web_login_recipe_run(ORG, ORIGIN, "sha256:aa", RunResult::Passed, "run_1", LATER)
        .await
        .unwrap());
    assert_eq!(
        db.web_login_recipe(ORG, ORIGIN)
            .await
            .unwrap()
            .unwrap()
            .trust,
        "candidate"
    );
}

#[tokio::test]
async fn a_renewal_of_the_same_steps_keeps_the_runs_own_proof() {
    let db = Db::connect_memory().await.unwrap();
    pinned(&db, KEY).await;
    put(&db, &write(Some(verification(None)), "{\"steps\":1}", 0)).await;
    db.record_web_login_recipe_run(ORG, ORIGIN, "sha256:aa", RunResult::Passed, "run_1", LATER)
        .await
        .unwrap();

    let renewed = put(&db, &write(Some(verification(None)), "{\"steps\":1}", 1)).await;
    assert_eq!(
        (renewed.trust.as_str(), renewed.canary_run_id.as_deref()),
        ("canary_verified", Some("run_1")),
        "the same steps were proven by a real change"
    );
    let changed = put(&db, &write(Some(verification(None)), "{\"steps\":2}", 2)).await;
    assert_eq!(
        (changed.trust.as_str(), changed.canary_result),
        ("candidate", None),
        "different steps are unproven"
    );
    let unsigned = put(&db, &write(None, "{\"steps\":2}", 3)).await;
    assert_eq!(unsigned.trust, "candidate");
}
