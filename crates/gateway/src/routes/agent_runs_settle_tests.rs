//! What a settled outcome may hold once it is stored (ADR 0159): scrubbed at
//! the route, whether or not anyone is still waiting for it.

use std::sync::atomic::{AtomicBool, Ordering};

use opensesame_domain::OrganizationId;
use opensesame_rotation_web::hooks::{HostInput, InputRole, ShutdownReason, BROWSER_VERBS};
use opensesame_rotation_web::{BrowserTransport, StepError};

use super::support::Fixture;
use super::web_login::{drive, prerequisites, queue, SITE};
use super::*;
use crate::web_login::prepare::prepare;
use crate::web_login::{Harness, RunTiming, WebLoginLauncher};

fn token() -> String {
    format!("ghp_{}", "x".repeat(36))
}

/// The claim a step's settle route checks, taken from Alice's browser.
async fn claim(f: &Fixture, run_id: &str) -> Option<i64> {
    let path = format!("/api/v1/agent/runs/{run_id}/steps/claim");
    let (status, claimed) = f.browser.send(&f.app, "POST", &path, None).await;
    (status == StatusCode::OK).then(|| claimed["seq"].as_i64().unwrap())
}

async fn claim_when_queued(f: &Fixture, run_id: &str) -> i64 {
    for _ in 0..400 {
        if let Some(seq) = claim(f, run_id).await {
            return seq;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    panic!("the run never queued a step");
}

async fn stored(f: &Fixture, run_id: &str, seq: i64) -> Option<String> {
    f.state
        .db
        .get_runner_step(&f.org, run_id, seq)
        .await
        .unwrap()
        .unwrap()
        .outcome_json
}

/// The executor's step timed out and it is gone; the run is still open, so the
/// claimant's late answer is accepted — and it must land as markers.
#[tokio::test]
async fn a_late_settle_carrying_a_token_stores_only_markers() {
    let f = fixture().await;
    prerequisites(&f, Some(r#"{"version":1,"unlisted_tools":"allow"}"#)).await;
    let org = OrganizationId::parse(&f.org).unwrap();
    let plan = prepare(&f.state.db, &org, SITE, Some(ALICE)).await.unwrap();
    let quiet = WebLoginLauncher::new(f.state.clone(), None).with_timing(RunTiming {
        step_deadline: std::time::Duration::from_millis(150),
        poll: std::time::Duration::from_millis(5),
        run_deadline: std::time::Duration::from_secs(10),
    });
    let harness = Harness::open(&quiet, &plan, "run_late", "rot_late")
        .await
        .unwrap();
    let request = json!({"step": "read_dom_redacted", "strip": []});
    let (dispatched, seq) = tokio::join!(
        harness.channel.dispatch_value(&request),
        claim_when_queued(&f, "run_late"),
    );
    assert!(dispatched.is_err(), "the executor stopped waiting");
    assert!(stored(&f, "run_late", seq).await.is_none());

    let secret = token();
    let path = format!("/api/v1/agent/runs/run_late/steps/{seq}/outcome");
    let body = json!({"outcome": {
        "outcome": "dom",
        "text": format!("<p>your token is {secret}</p>"),
        "epoch": 1,
    }});
    let (status, settled) = f.browser.send(&f.app, "POST", &path, Some(body)).await;
    assert_eq!(status, StatusCode::OK, "{settled}");
    assert_eq!(settled["redacted"], json!(true));
    assert!(!settled.to_string().contains(&secret));

    let row = stored(&f, "run_late", seq).await.expect("settled");
    assert!(!row.contains(&secret), "{row}");
    let outcome: Value = serde_json::from_str(&row).unwrap();
    assert_eq!(outcome["outcome"], json!("dom"), "the shape is kept");
    assert_eq!(outcome["epoch"], json!(1));
    assert!(outcome["text"]
        .as_str()
        .unwrap()
        .contains("[redacted:github_token]"));
}

/// A driver that answers a page read with a credential in it.
fn leaky(request: &Value) -> Value {
    if request["step"] == "read_dom_redacted" {
        return json!({
            "outcome": "dom",
            "text": format!("<p>your token is {}</p>", token()),
            "epoch": 1,
        });
    }
    super::web_login::happy(request)
}

/// One hosted page read against `hook_policy`, answered by [`leaky`] through
/// the outcome route: what the executor read, and what the queue kept.
async fn leaky_read(
    f: &Fixture,
    hook_policy: &str,
    run_id: &str,
) -> (Result<String, StepError>, Vec<(Value, Option<String>)>) {
    prerequisites(f, Some(hook_policy)).await;
    let org = OrganizationId::parse(&f.org).unwrap();
    let plan = prepare(&f.state.db, &org, SITE, Some(ALICE)).await.unwrap();
    let launcher = super::web_login::launcher(f);
    let harness = Harness::open(&launcher, &plan, run_id, "rot_leak")
        .await
        .unwrap();
    let session = harness.hooked.session();
    session.startup(&BROWSER_VERBS).await.unwrap();
    session
        .input(&HostInput {
            content: json!({"run": "change_password", "recipe": plan.recipe_id, "origin": SITE}),
            role: InputRole::System,
        })
        .await
        .unwrap();
    let done = AtomicBool::new(false);
    let (dom, _) = tokio::join!(
        async {
            let dom = harness.hooked.read_dom_redacted().await;
            done.store(true, Ordering::SeqCst);
            dom
        },
        drive(f, &done, leaky),
    );
    session.shutdown(ShutdownReason::Completed).await;
    harness.channel.flush_records().await.unwrap();
    (dom.map(|dom| dom.text().to_owned()), queue(f, run_id).await)
}

#[tokio::test]
async fn under_the_default_policy_the_executor_reads_markers_and_the_queue_holds_only_them() {
    let f = fixture().await;
    let (dom, rows) = leaky_read(&f, r#"{"version":1,"unlisted_tools":"allow"}"#, "run_mark").await;
    let text = dom.expect("a redacted read is still a read");
    assert!(!text.contains(&token()), "{text}");
    assert!(text.contains("[redacted:github_token]"), "{text}");
    let stored = rows[0].1.clone().unwrap();
    assert!(!stored.contains(&token()), "{stored}");
    assert!(stored.contains("[redacted:github_token]"), "{stored}");
    // The scrub came first, so the interceptor found nothing left to rewrite.
    let records = f
        .state
        .db
        .agent_hook_records(&f.org, "run_mark")
        .await
        .unwrap();
    assert!(!format!("{records:?}").contains(&token()));
}

/// A policy that would deny a credential — or refuse later calls once one has
/// flowed — never sees one now that the route has swapped it for a marker, so
/// the route stores the step as refused instead, as a `post_tool_call` deny
/// would have: the read fails closed and nothing credential-shaped is kept.
#[tokio::test]
async fn a_policy_that_denies_credentials_has_the_step_refused_not_redacted() {
    for policy in [
        r#"{"version":1,"unlisted_tools":"allow","secret_guard":"deny"}"#,
        r#"{"version":1,"unlisted_tools":"allow","refuse_labels":["opensesame:credential_material"]}"#,
    ] {
        let f = fixture().await;
        let (dom, rows) = leaky_read(&f, policy, "run_deny").await;
        assert_eq!(dom.unwrap_err(), StepError::Refused, "{policy}");
        let stored = rows[0].1.clone().unwrap();
        assert!(!stored.contains(&token()), "{stored}");
        assert_eq!(stored, r#"{"outcome":"failed","error":"refused"}"#);
    }
}
