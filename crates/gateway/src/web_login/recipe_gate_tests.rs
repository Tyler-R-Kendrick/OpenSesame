//! The rule a run's recipe must meet (ADR 0076 §4, ADR 0159): signed by a key
//! the organization still pins, the very document that signature covers,
//! unexpired — and, with nobody watching, proven by a real change. The
//! store's trust column is never taken on its word.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use chrono::Utc;
use serde_json::{json, Value};

use super::prepare::{
    prepare, prepare_for, DEFER_NO_CANARY, DEFER_NO_RECIPE, DEFER_RECIPES_UNREADABLE,
};
use super::recipe_fixture;
use super::recipe_trust::Attendance;
use super::start::start_attended;
use super::test_support::*;
use crate::lifecycle::dispatch;

async fn reseed(world: &World, attested: bool) {
    sqlx::query("DELETE FROM web_login_recipes")
        .execute(world.state.db.pool())
        .await
        .unwrap();
    recipe_fixture::seed(&world.state.db, &world.org_text(), SITE, attested).await;
}

async fn refusal(world: &World, attendance: Attendance) -> Option<&'static str> {
    prepare_for(&world.state.db, &world.org, SITE, Some(OWNER), attendance)
        .await
        .err()
}

async fn sql(world: &World, statement: &str) {
    sqlx::query(statement)
        .execute(world.state.db.pool())
        .await
        .unwrap();
}

/// Answer each step as `answer` says, as the owner's browser would.
async fn drive_answering(
    state: &crate::app_state::AppState,
    org: &str,
    done: &AtomicBool,
    answer: impl Fn(&Value) -> Value,
) {
    while !done.load(Ordering::SeqCst) {
        let mut acted = false;
        for run in state.db.list_observation_runs(org, 50).await.unwrap() {
            if run.closed_at.is_some() {
                continue;
            }
            let now = Utc::now();
            let expires = now + chrono::Duration::seconds(30);
            let claimed = state
                .db
                .claim_runner_step(
                    org,
                    &run.id,
                    OWNER,
                    &now.to_rfc3339(),
                    &expires.to_rfc3339(),
                )
                .await
                .unwrap();
            let Some(step) = claimed else { continue };
            let request: Value = serde_json::from_str(&step.request_json).unwrap();
            let outcome = answer(&request).to_string();
            state
                .db
                .settle_runner_step(org, &run.id, step.seq, OWNER, &outcome, &now.to_rfc3339())
                .await
                .unwrap();
            acted = true;
        }
        if !acted {
            tokio::time::sleep(Duration::from_millis(3)).await;
        }
    }
}

async fn run_to_the_end(world: &World, answer: impl Fn(&Value) -> Value) {
    let org = world.org_text();
    let done = AtomicBool::new(false);
    tokio::join!(drive_answering(&world.state, &org, &done, answer), async {
        world.state.web_login_runs.idle().await;
        done.store(true, Ordering::SeqCst);
    });
}

async fn recipe_row(
    world: &World,
) -> opensesame_storage::web_login_runs::recipes::StoredRecipeRecord {
    world
        .state
        .db
        .web_login_recipe(&world.org_text(), SITE)
        .await
        .unwrap()
        .unwrap()
}

#[tokio::test]
async fn only_a_verified_recipe_ever_reaches_a_plan() {
    let world = world(&[SITE], ALLOW_ALL).await;
    let db = &world.state.db;
    for attendance in [Attendance::Attended, Attendance::Unattended] {
        assert_eq!(refusal(&world, attendance).await, None, "signed and proven");
    }

    // Stored unsigned: a hypothesis, replayed by nobody.
    let unsigned = {
        let mut document = recipe_fixture::document(SITE, false);
        document.signature = None;
        document
    };
    sql(&world, "DELETE FROM web_login_recipes").await;
    db.put_web_login_recipe_document(
        &opensesame_storage::web_login_runs::recipes::RecipeWrite {
            organization_id: &world.org_text(),
            origin: SITE,
            recipe_id: &unsigned.recipe_id,
            document_json: &serde_json::to_string(&unsigned).unwrap(),
            recipe_json: &serde_json::to_string(unsigned.steps()).unwrap(),
            digest: &unsigned.digest().unwrap(),
            expires_at: &unsigned.expires_at,
            verification: None,
            expected_version: 0,
            updated_by: "operator",
            now: &Utc::now().to_rfc3339(),
        },
        &opensesame_storage::web_login_runs::recipes::RecipeAudit {
            event_type: "web_login.test",
            payload_json: "{}",
        },
    )
    .await
    .unwrap();
    for attendance in [Attendance::Attended, Attendance::Unattended] {
        assert_eq!(refusal(&world, attendance).await, Some(DEFER_NO_RECIPE));
    }
    // Writing the trust column by hand does not make it verified: the row has
    // no signer, and a signer is what the runner joins on.
    sql(
        &world,
        "UPDATE web_login_recipes SET trust = 'canary_verified', canary_result = 'passed', \
         canary_at = datetime('now'), canary_source = 'run'",
    )
    .await;
    for attendance in [Attendance::Attended, Attendance::Unattended] {
        assert_eq!(refusal(&world, attendance).await, Some(DEFER_NO_RECIPE));
    }
}

#[tokio::test]
async fn a_signature_without_a_canary_is_for_a_person_to_drive_only() {
    let world = world(&[SITE], ALLOW_ALL).await;
    reseed(&world, false).await;
    assert_eq!(refusal(&world, Attendance::Attended).await, None);
    assert_eq!(
        refusal(&world, Attendance::Unattended).await,
        Some(DEFER_NO_CANARY)
    );
    // The same answer from the front door: the scanner parks the job with it.
    let org = world.org_text();
    dispatch::publish(&world.state, &event(&world, SITE), Utc::now()).await;
    world.state.web_login_runs.idle().await;
    let jobs = world
        .state
        .connection_broker
        .list_rotation_jobs(&org, 20)
        .await
        .unwrap();
    assert_eq!(jobs.len(), 1);
    assert_eq!(jobs[0].state, "reconciliation_required");
    assert!(
        jobs[0]
            .detail
            .as_deref()
            .unwrap_or_default()
            .contains("canary"),
        "{:?}",
        jobs[0].detail
    );
    assert!(world
        .state
        .db
        .list_observation_runs(&org, 10)
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn revoking_the_signer_stops_the_next_run() {
    let world = world(&[SITE], ALLOW_ALL).await;
    assert_eq!(refusal(&world, Attendance::Unattended).await, None);
    let key_id =
        opensesame_rotation_web::recipe_doc::key_id_of(&recipe_fixture::signer().verifying_key());
    sql(
        &world,
        &format!(
            "UPDATE web_login_recipe_signers SET revoked_at = datetime('now'), \
             revoked_by = 'operator' WHERE key_id = '{key_id}'"
        ),
    )
    .await;
    for attendance in [Attendance::Attended, Attendance::Unattended] {
        assert_eq!(refusal(&world, attendance).await, Some(DEFER_NO_RECIPE));
    }
}

#[tokio::test]
async fn a_document_changed_behind_the_hosts_back_is_not_replayed() {
    let world = world(&[SITE], ALLOW_ALL).await;
    let tampered = |edit: fn(&mut Value)| {
        let mut document = serde_json::to_value(recipe_fixture::document(SITE, true)).unwrap();
        edit(&mut document);
        document.to_string()
    };
    for (name, document) in [
        (
            "other selectors under the old signature",
            tampered(|d| d["change_password"]["submit_selector"] = json!("#steal")),
        ),
        (
            "another origin",
            tampered(|d| d["origin"] = json!("https://evil.example")),
        ),
        (
            "no signature at all",
            tampered(|d| {
                d.as_object_mut().unwrap().remove("signature");
            }),
        ),
        ("garbage", "{\"not\":\"a recipe\"}".to_owned()),
    ] {
        reseed(&world, true).await;
        sqlx::query("UPDATE web_login_recipes SET document_json = ?")
            .bind(&document)
            .execute(world.state.db.pool())
            .await
            .unwrap();
        for attendance in [Attendance::Attended, Attendance::Unattended] {
            let why = refusal(&world, attendance).await;
            assert!(why.is_some(), "{name} must not be replayed");
        }
    }
    // A digest edited to match nothing the document hashes to.
    reseed(&world, true).await;
    sql(&world, "UPDATE web_login_recipes SET digest = 'sha256:00'").await;
    assert_eq!(
        refusal(&world, Attendance::Attended).await,
        Some(DEFER_NO_RECIPE)
    );
    // The signed expiry counts, not the column beside it: a document that
    // expired, under a column someone moved out, is still expired.
    let mut lapsed = recipe_fixture::document(SITE, true);
    lapsed.signature = None;
    lapsed.expires_at = "2020-01-01T00:00:00+00:00".into();
    lapsed.sign(&recipe_fixture::signer()).unwrap();
    reseed(&world, true).await;
    sqlx::query("UPDATE web_login_recipes SET document_json = ?, digest = ?")
        .bind(serde_json::to_string(&lapsed).unwrap())
        .bind(lapsed.digest().unwrap())
        .execute(world.state.db.pool())
        .await
        .unwrap();
    assert_eq!(
        refusal(&world, Attendance::Attended).await,
        Some(DEFER_NO_RECIPE)
    );
    // An expired recipe is none.
    reseed(&world, true).await;
    sql(
        &world,
        "UPDATE web_login_recipes SET expires_at = '2020-01-01T00:00:00+00:00'",
    )
    .await;
    assert_eq!(
        refusal(&world, Attendance::Attended).await,
        Some(DEFER_NO_RECIPE)
    );
}

#[tokio::test]
async fn a_completed_attended_run_is_the_canary_that_lets_the_scanner_run_alone() {
    let world = world(&[SITE], ALLOW_ALL).await;
    reseed(&world, false).await;
    let org = world.org_text();
    assert_eq!(recipe_row(&world).await.canary_result, None);

    start_attended(&world.state, &world.org, SITE, OWNER).expect("an attended run starts");
    assert!(
        start_attended(&world.state, &world.org, SITE, OWNER).is_err(),
        "one run per target, attended or not"
    );
    run_to_the_end(&world, happy).await;

    let jobs = world
        .state
        .connection_broker
        .list_rotation_jobs(&org, 20)
        .await
        .unwrap();
    assert_eq!(jobs.len(), 1);
    assert_eq!(jobs[0].state, "completed");
    let proven = recipe_row(&world).await;
    assert_eq!(
        (
            proven.trust.as_str(),
            proven.canary_result.as_deref(),
            proven.canary_source.as_deref()
        ),
        ("canary_verified", Some("passed"), Some("run"))
    );
    assert!(proven
        .canary_run_id
        .as_deref()
        .is_some_and(|id| id.starts_with("run_")));
    assert_eq!(proven.version, 1, "a canary is not an operator edit");
    assert!(
        prepare(&world.state.db, &world.org, SITE, Some(OWNER))
            .await
            .is_ok(),
        "the scanner may now run it alone"
    );
    assert_eq!(world.published("agent.run.completed").await.len(), 1);
}

#[tokio::test]
async fn a_run_that_finds_the_page_changed_takes_the_recipe_off_the_scanner() {
    let world = world(&[SITE], ALLOW_ALL).await;
    assert_eq!(recipe_row(&world).await.trust, "canary_verified");
    dispatch::publish(&world.state, &event(&world, SITE), Utc::now()).await;
    // The new-password field never appears: the recipe no longer matches.
    run_to_the_end(&world, |request| match request["step"].as_str() {
        Some("wait_for") => json!({"outcome": "failed", "error": "timeout"}),
        _ => happy(request),
    })
    .await;

    let demoted = recipe_row(&world).await;
    assert_eq!(
        (demoted.trust.as_str(), demoted.canary_result.as_deref()),
        ("candidate", Some("failed"))
    );
    assert_eq!(
        prepare(&world.state.db, &world.org, SITE, Some(OWNER))
            .await
            .unwrap_err(),
        DEFER_NO_CANARY
    );
    assert!(
        prepare_for(
            &world.state.db,
            &world.org,
            SITE,
            Some(OWNER),
            Attendance::Attended
        )
        .await
        .is_ok(),
        "a person may drive it again"
    );
}

#[tokio::test]
async fn a_stop_that_is_not_the_recipes_fault_leaves_its_proof_alone() {
    let world = world(&[SITE], ALLOW_ALL).await;
    dispatch::publish(&world.state, &event(&world, SITE), Utc::now()).await;
    // The site asks for a challenge: nothing about the recipe is disproved.
    run_to_the_end(&world, |request| match request["step"].as_str() {
        Some("navigate") => json!({"outcome": "failed", "error": "challenge"}),
        _ => happy(request),
    })
    .await;
    let row = recipe_row(&world).await;
    assert_eq!(
        (row.trust.as_str(), row.canary_source.as_deref()),
        ("canary_verified", Some("signed"))
    );
}

#[tokio::test]
async fn an_unreadable_store_names_itself() {
    let world = world(&[SITE], ALLOW_ALL).await;
    sql(
        &world,
        "ALTER TABLE web_login_recipes RENAME TO web_login_recipes_gone",
    )
    .await;
    assert_eq!(
        refusal(&world, Attendance::Attended).await,
        Some(DEFER_RECIPES_UNREADABLE)
    );
}
