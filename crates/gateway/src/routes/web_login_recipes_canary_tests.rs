//! `POST …/recipes/{origin}/canary` (ADR 0076 §4): one attended run, started
//! by a person, whose completion is the recipe's canary — and the scanner's
//! unattended runs follow.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use opensesame_domain::OrganizationRole;
use opensesame_storage::agent_hook_policy::{AgentHookPolicyAudit, AgentHookPolicyWrite};
use serde_json::json;

use super::tests::*;
use super::*;
use crate::app_state::{test_demo_state, test_session_headers};
use crate::test_principals::{P26, P27};
use crate::web_login::recipe_fixture;

fn canary_uri() -> String {
    format!("{}/canary", recipe_uri())
}

pub(super) async fn allow_every_tool(st: &AppState) {
    st.db
        .put_agent_hook_policy(
            &AgentHookPolicyWrite {
                organization_id: &st.connection_organization.to_string(),
                policy_json: r#"{"version":1,"unlisted_tools":"allow"}"#,
                expected_version: 0,
                updated_by: "operator",
            },
            &AgentHookPolicyAudit {
                event_type: "agent_hooks.policy.updated",
                payload_json: "{}",
            },
        )
        .await
        .unwrap();
}

/// What the owner's browser answers for each step of a change-password run.
fn happy(request: &Value) -> Value {
    match request["step"].as_str().unwrap_or_default() {
        "fill_credential" => json!({"outcome": "filled", "filled": "Ok"}),
        "assert_present" => json!({"outcome": "presence", "presence": "Present"}),
        "verify_login" => json!({"outcome": "verified", "verified": "Works"}),
        "seal_candidate" => json!({"outcome": "sealed", "backed_up": true}),
        _ => json!({"outcome": "done"}),
    }
}

/// The owner's browser, until the run it was started for is over.
pub(super) async fn drive_owner(st: &AppState, owner: &str, done: &AtomicBool) {
    let org = st.connection_organization.to_string();
    while !done.load(Ordering::SeqCst) {
        let mut acted = false;
        for run in st.db.list_observation_runs(&org, 50).await.unwrap() {
            if run.closed_at.is_some() {
                continue;
            }
            let now = chrono::Utc::now();
            let expires = now + chrono::Duration::seconds(30);
            let claimed = st
                .db
                .claim_runner_step(
                    &org,
                    &run.id,
                    owner,
                    &now.to_rfc3339(),
                    &expires.to_rfc3339(),
                )
                .await
                .unwrap();
            let Some(step) = claimed else { continue };
            let request: Value = serde_json::from_str(&step.request_json).unwrap();
            let outcome = happy(&request).to_string();
            st.db
                .settle_runner_step(&org, &run.id, step.seq, owner, &outcome, &now.to_rfc3339())
                .await
                .unwrap();
            acted = true;
        }
        if !acted {
            tokio::time::sleep(Duration::from_millis(3)).await;
        }
    }
}

pub(super) async fn until_the_run_ends(st: &AppState, owner: &str) {
    let done = AtomicBool::new(false);
    tokio::join!(drive_owner(st, owner, &done), async {
        st.web_login_runs.idle().await;
        done.store(true, Ordering::SeqCst);
    });
}

pub(super) fn owner_subject() -> String {
    crate::session_claims::parse_principal(P26)
        .unwrap()
        .to_string()
}

#[tokio::test]
async fn only_a_person_with_a_verified_recipe_starts_a_run() {
    let st = test_demo_state().await;
    let app = crate::routes::router(st.clone());
    let uri = canary_uri();
    let person = test_session_headers(
        &st,
        P27,
        st.connection_organization,
        OrganizationRole::Admin,
    );

    // A member may not rotate a login that is not theirs, even with a
    // verified recipe in place: the role that writes a recipe starts its run.
    let member = test_session_headers(
        &st,
        P27,
        st.connection_organization,
        OrganizationRole::Member,
    );
    let reply = send(&app, &member, "POST", &uri, Vec::new()).await;
    assert_eq!(
        (reply.status, reply.body["error"].as_str()),
        (StatusCode::FORBIDDEN, Some("forbidden"))
    );
    assert_eq!(st.web_login_runs.pending(), 0);

    // Nothing is stored.
    let reply = send(&app, &person, "POST", &uri, Vec::new()).await;
    assert_eq!(
        (reply.status, reply.body["error"].as_str()),
        (StatusCode::CONFLICT, Some("recipe_not_runnable"))
    );

    // An unsigned recipe is a hypothesis, and a person driving it changes nothing.
    let mut unsigned = recipe_fixture::document(SITE, false);
    unsigned.signature = None;
    let admin = owner(&st);
    send(
        &app,
        &put_headers(&admin, "\"0\""),
        "PUT",
        &recipe_uri(),
        document_bytes(&unsigned),
    )
    .await;
    let reply = send(&app, &person, "POST", &uri, Vec::new()).await;
    assert_eq!(reply.status, StatusCode::CONFLICT, "{}", reply.body);
    assert_eq!(st.web_login_runs.pending(), 0);

    // Not the operator (no browser to drive), and never a delegated credential.
    let reply = send(&app, &operator(&st), "POST", &uri, Vec::new()).await;
    assert_eq!(reply.status, StatusCode::FORBIDDEN);
    let delegated = {
        let token = uuid::Uuid::new_v4().to_string();
        let mut claims = crate::session_claims::fixture(
            crate::session_claims::parse_principal(P27).unwrap(),
            st.connection_organization,
            OrganizationRole::Admin,
            &st.resource,
        );
        claims.capability_ceiling = vec!["host:user".into(), "agent:invoke".into()];
        st.sessions
            .lock()
            .unwrap()
            .insert(opensesame_claims::hash_secret(&token), claims);
        with(
            HeaderMap::new(),
            "authorization",
            &format!("Bearer opaque-session:{token}"),
        )
    };
    let reply = send(&app, &delegated, "POST", &uri, Vec::new()).await;
    assert_eq!(reply.status, StatusCode::FORBIDDEN, "{}", reply.body);
    assert_eq!(
        send(&app, &HeaderMap::new(), "POST", &uri, Vec::new())
            .await
            .status,
        StatusCode::UNAUTHORIZED
    );
    let bad = send(
        &app,
        &person,
        "POST",
        &format!("{RECIPES}/not-an-origin/canary"),
        Vec::new(),
    )
    .await;
    assert_eq!(bad.status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn a_completed_attended_run_proves_the_recipe_for_the_scanner() {
    let st = test_demo_state().await;
    allow_every_tool(&st).await;
    let app = crate::routes::router(st.clone());
    let admin = owner(&st);
    assert_eq!(pin_signer(&app, &st).await.status, StatusCode::CREATED);
    let signed = recipe_fixture::document(SITE, false);
    let stored = send(
        &app,
        &put_headers(&admin, "\"0\""),
        "PUT",
        &recipe_uri(),
        document_bytes(&signed),
    )
    .await;
    assert_eq!(
        stored.body["recipe"]["runnable"],
        json!({"attended": true, "unattended": false}),
        "the scanner may not run it alone yet"
    );

    // The owner asks for the run; a second ask while it is in flight is refused.
    let started = send(&app, &admin, "POST", &canary_uri(), Vec::new()).await;
    assert_eq!(started.status, StatusCode::ACCEPTED, "{}", started.body);
    assert_eq!(started.body["status"], "started");
    let second = send(&app, &admin, "POST", &canary_uri(), Vec::new()).await;
    assert_eq!(
        (second.status, second.body["error"].as_str()),
        (StatusCode::CONFLICT, Some("run_in_flight"))
    );
    until_the_run_ends(&st, &owner_subject()).await;

    // The Host recorded the canary itself, against the document that ran.
    let read = send(&app, &admin, "GET", &recipe_uri(), Vec::new()).await;
    let recipe = &read.body["recipe"];
    assert_eq!(recipe["trust"], "canary_verified");
    assert_eq!(recipe["canary"]["result"], "passed");
    assert_eq!(recipe["canary"]["source"], "run");
    assert!(recipe["canary"]["run_id"]
        .as_str()
        .unwrap()
        .starts_with("run_"));
    assert_eq!(
        recipe["runnable"],
        json!({"attended": true, "unattended": true})
    );
    assert_eq!(recipe["version"], 1, "a canary is not an edit");
    let jobs = st
        .connection_broker
        .list_rotation_jobs(&st.connection_organization.to_string(), 10)
        .await
        .unwrap();
    assert_eq!(
        jobs.iter().map(|j| j.state.as_str()).collect::<Vec<_>>(),
        ["completed"]
    );

    // A renewal of the same steps keeps what the run proved.
    let mut renewed = recipe_fixture::document(SITE, false);
    renewed.expires_at = (chrono::Utc::now() + chrono::Duration::days(60)).to_rfc3339();
    renewed.sign(&recipe_fixture::signer()).unwrap();
    let reply = send(
        &app,
        &put_headers(&admin, "\"1\""),
        "PUT",
        &recipe_uri(),
        document_bytes(&renewed),
    )
    .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    assert_eq!(reply.body["recipe"]["trust"], "canary_verified");
    assert_eq!(reply.body["recipe"]["canary"]["source"], "run");
}
