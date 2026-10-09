//! The worked example in `docs/operators/web-login-recipes.md`, end to end
//! through the real routes and the real runner: the document's example recipe
//! is signed, pinned, stored, proven by an attended run, and then rotated by
//! the lifecycle scanner with nobody watching.

use chrono::{Duration, Utc};
use opensesame_connection_broker::{RotationTarget, UpsertRotationPolicy};
use opensesame_lifecycle::{ExpiryStage, ExpirySubject, LifecycleEvent, SubjectKind};
use opensesame_rotation_web::recipe_doc::RecipeDocument;
use serde_json::json;

use super::canary_tests::{allow_every_tool, owner_subject, until_the_run_ends};
use super::tests::*;
use super::*;
use crate::app_state::test_demo_state;
use crate::web_login::recipe_fixture;

const EXAMPLE: &str =
    include_str!("../../../../docs/operators/examples/web-login-recipe.example.json");
const DOC: &str = include_str!("../../../../docs/operators/web-login-recipes.md");

#[tokio::test]
async fn the_documented_recipe_is_signed_proven_and_then_rotated_unattended() {
    // The document embeds the very file this test runs.
    assert!(
        DOC.contains(EXAMPLE.trim()),
        "the document shows the example verbatim"
    );

    let st = test_demo_state().await;
    allow_every_tool(&st).await;
    let app = crate::routes::router(st.clone());
    let admin = owner(&st);

    // `recipe sign --expires-in-days 60`, as the CLI does it.
    let mut document = RecipeDocument::parse(EXAMPLE.as_bytes()).expect("the example is a recipe");
    assert_eq!(
        document.origin, SITE,
        "the example is for the runner's test site"
    );
    document.expires_at = (Utc::now() + Duration::days(60)).to_rfc3339();
    document.sign(&recipe_fixture::signer()).unwrap();

    // `signer add`: a step-up, then the Host names the key.
    assert_eq!(pin_signer(&app, &st).await.status, StatusCode::CREATED);
    // `recipe put … --if-version 0`.
    let put = send(
        &app,
        &put_headers(&admin, "\"0\""),
        "PUT",
        &recipe_uri(),
        document_bytes(&document),
    )
    .await;
    assert_eq!(put.status, StatusCode::CREATED, "{}", put.body);
    assert_eq!(put.body["recipe"]["trust"], "candidate");
    assert_eq!(
        put.body["recipe"]["runnable"],
        json!({"attended": true, "unattended": false})
    );

    // `recipe canary`: one attended run, from the owner's browser.
    let started = send(
        &app,
        &admin,
        "POST",
        &format!("{}/canary", recipe_uri()),
        Vec::new(),
    )
    .await;
    assert_eq!(started.status, StatusCode::ACCEPTED, "{}", started.body);
    until_the_run_ends(&st, &owner_subject()).await;

    // `recipe get`: proven, by the Host's own record of a real run.
    let got = send(&app, &admin, "GET", &recipe_uri(), Vec::new()).await;
    assert_eq!(
        got.body["recipe"]["trust"], "canary_verified",
        "{}",
        got.body
    );
    assert_eq!(got.body["recipe"]["canary"]["source"], "run");
    assert_eq!(
        got.body["recipe"]["runnable"],
        json!({"attended": true, "unattended": true})
    );
    assert_eq!(got.body["document"]["origin"], SITE);

    // Now the scanner may rotate this login on its own.
    let org = st.connection_organization.to_string();
    st.connection_broker
        .upsert_rotation_policy(
            &org,
            UpsertRotationPolicy {
                id: None,
                target: RotationTarget::WebLogin {
                    origin: SITE.into(),
                },
                owner_subject: Some(owner_subject()),
                interval_seconds: 86_400,
                enabled: true,
            },
        )
        .await
        .unwrap();
    let now = Utc::now();
    let rung = LifecycleEvent::for_stage(
        ExpirySubject {
            kind: SubjectKind::WebLogin,
            subject_id: SITE.into(),
            organization_id: org.clone(),
            expires_at: now,
            renew_before_seconds: Some(1),
            auto_respond: true,
            alerting: false,
            label: None,
        },
        ExpiryStage::Renewal,
        now,
    );
    crate::lifecycle::dispatch::publish(&st, &rung, now).await;
    until_the_run_ends(&st, &owner_subject()).await;
    let jobs = st
        .connection_broker
        .list_rotation_jobs(&org, 10)
        .await
        .unwrap();
    assert_eq!(
        jobs.iter()
            .map(|job| job.state.as_str())
            .collect::<Vec<_>>(),
        ["completed", "completed"],
        "the attended canary, then the unattended rotation"
    );
}
