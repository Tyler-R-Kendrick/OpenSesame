//! A run's hook records over the routes (ADR 0159): paged by `sequence`, under
//! the sealed log's entitlement, summarised on the run, and — for a run the
//! Host opened — standing in for a sealed log the Host has no key to write
//! (ADR 0081 §9).

use opensesame_storage::web_login_runs::StoredAgentHookRecord;
use opensesame_storage::NO_VIEWER_KEY_PREFIX;

use super::support::Fixture;
use super::web_login::{happy, prerequisites, rotate_driven, the_run};
use super::*;

const KEYLESS: &str = "none:hook-records-only";

fn record(run: &str, org: &str, sequence: i64, decision: &str) -> StoredAgentHookRecord {
    StoredAgentHookRecord {
        run_id: run.into(),
        organization_id: org.into(),
        sequence,
        interception_point: "pre_tool_call".into(),
        decision: decision.into(),
        escalated: decision == "deny",
        reason: Some("opensesame:tool_requires_approval".into()),
        decided_by: Some(0),
        input_identity: Some("sha256:aa".into()),
        enforced_identity: Some("sha256:aa".into()),
        policy_version: 3,
        recorded_at: "2026-08-31T00:00:00+00:00".into(),
    }
}

/// A keyless run of Alice's with five records: allow, deny, allow, transform,
/// allow.
async fn seeded(f: &Fixture) {
    let mut run = seed("run:1", ALICE, &f.org, "agent_driving");
    run.viewer_key_id = KEYLESS.into();
    f.state.db.create_observation_run(&run).await.unwrap();
    let rows: Vec<_> = ["allow", "deny", "allow", "transform", "allow"]
        .iter()
        .enumerate()
        .map(|(n, decision)| record("run:1", &f.org, i64::try_from(n).unwrap(), decision))
        .collect();
    f.state.db.append_agent_hook_records(&rows).await.unwrap();
}

#[tokio::test]
async fn the_owner_pages_through_a_runs_hook_records() {
    let f = fixture().await;
    seeded(&f).await;
    let base = "/api/v1/agent/runs/run:1/hook-records";

    let (status, page) = send(&f.app, &f.alice, "GET", &format!("{base}?limit=2")).await;
    assert_eq!(status, StatusCode::OK, "{page}");
    let sequences = |page: &Value| -> Vec<i64> {
        page["records"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["sequence"].as_i64().unwrap())
            .collect()
    };
    assert_eq!(sequences(&page), [0, 1]);
    assert_eq!(page["next_after"], json!(1));
    assert_eq!(page["has_more"], json!(true));
    assert_eq!(page["sealed"], json!(false));
    assert_eq!(page["secrets_returned"], json!(false));
    assert_eq!(page["observation"], json!("hook_records_only"));
    assert_eq!(
        page["summary"],
        json!({
            "count": 5, "allow": 3, "deny": 1, "transform": 1,
            "escalated": 1, "last_sequence": 4,
        })
    );

    let (status, rest) = send(&f.app, &f.alice, "GET", &format!("{base}?after=1")).await;
    assert_eq!(status, StatusCode::OK, "{rest}");
    assert_eq!(sequences(&rest), [2, 3, 4]);
    assert_eq!(rest["has_more"], json!(false));
    assert_eq!(rest["next_after"], json!(4));

    // Past the end is an empty page that keeps the caller's cursor.
    let (_, end) = send(&f.app, &f.alice, "GET", &format!("{base}?after=4")).await;
    assert_eq!(sequences(&end), Vec::<i64>::new());
    assert_eq!(end["next_after"], json!(4));
    assert_eq!(end["has_more"], json!(false));
}

#[tokio::test]
async fn a_record_has_exactly_the_payload_free_members() {
    let f = fixture().await;
    seeded(&f).await;
    let (_, page) = send(
        &f.app,
        &f.alice,
        "GET",
        "/api/v1/agent/runs/run:1/hook-records?limit=1",
    )
    .await;
    let mut keys: Vec<&str> = page["records"][0]
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        [
            "decided_by",
            "decision",
            "enforced_identity",
            "escalated",
            "input_identity",
            "interception_point",
            "policy_version",
            "reason",
            "recorded_at",
            "sequence",
        ],
        "no message, no target, no transform value"
    );
}

#[tokio::test]
async fn hook_records_follow_the_sealed_logs_entitlement() {
    let f = fixture().await;
    seeded(&f).await;
    let path = "/api/v1/agent/runs/run:1/hook-records";

    // Same organization, different person: 404, not 403, exactly as the log.
    let (status, _) = send(&f.app, &f.bob, "GET", path).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (_, log_for_bob) = send(&f.app, &f.bob, "GET", "/api/v1/agent/runs/run:1/log").await;
    let (_, records_for_bob) = send(&f.app, &f.bob, "GET", path).await;
    assert_eq!(
        log_for_bob, records_for_bob,
        "the same answer, byte for byte"
    );
    // The other person's paired browser gets the same refusal.
    let (status, _) = f.other_browser.send(&f.app, "GET", path, None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // A run that does not exist reads the same as one that is not yours.
    let (status, _) = send(
        &f.app,
        &f.alice,
        "GET",
        "/api/v1/agent/runs/run:nope/hook-records",
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // No credential, no read.
    let (status, _) = send(&f.app, &HeaderMap::new(), "GET", path).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn the_run_view_carries_the_summary_and_nothing_more() {
    let f = fixture().await;
    seeded(&f).await;
    let (status, view) = send(&f.app, &f.alice, "GET", "/api/v1/agent/runs/run:1").await;
    assert_eq!(status, StatusCode::OK, "{view}");
    assert_eq!(view["hook_records"]["count"], json!(5));
    assert_eq!(view["hook_records"]["deny"], json!(1));
    assert_eq!(view["hook_records"]["escalated"], json!(1));
    assert_eq!(view["observation"], json!("hook_records_only"));
    let rendered = view["hook_records"].to_string();
    assert!(
        !rendered.contains("opensesame:"),
        "the summary counts verdicts; it does not quote their reasons: {rendered}"
    );
    // A run with no records has a zero summary, not a missing one.
    f.state
        .db
        .create_observation_run(&seed("run:2", ALICE, &f.org, "agent_driving"))
        .await
        .unwrap();
    let (_, empty) = send(&f.app, &f.alice, "GET", "/api/v1/agent/runs/run:2").await;
    assert_eq!(empty["hook_records"]["count"], json!(0));
    assert_eq!(empty["hook_records"]["last_sequence"], Value::Null);
    assert_eq!(empty["observation"], json!("sealed_log"));
}

#[tokio::test]
async fn a_run_with_a_viewer_key_reports_a_sealed_log() {
    let f = fixture().await;
    f.state
        .db
        .create_observation_run(&seed("run:1", ALICE, &f.org, "agent_driving"))
        .await
        .unwrap();
    let (_, log) = send(&f.app, &f.alice, "GET", "/api/v1/agent/runs/run:1/log").await;
    assert_eq!(log["observation"], json!("sealed_log"));
    let (_, records) = send(
        &f.app,
        &f.alice,
        "GET",
        "/api/v1/agent/runs/run:1/hook-records",
    )
    .await;
    assert_eq!(records["observation"], json!("sealed_log"));
    assert_eq!(records["records"], json!([]));
}

/// ADR 0081 §9: the log is sealed to the owner's viewer key, which lives in the
/// owner's client. The Host holds no such key, so a run it hosts writes no
/// sealed frame — not with a key it made up, not with none — and what a person
/// watching sees of it is the hook record.
#[tokio::test]
async fn a_hosted_run_seals_nothing_because_the_host_holds_no_viewer_key() {
    let f = fixture().await;
    let policy = prerequisites(&f, Some(r#"{"version":1,"unlisted_tools":"allow"}"#)).await;
    let (outcome, _) = rotate_driven(&f, policy, happy).await;
    assert!(outcome.succeeded, "{outcome:?}");
    let (run_id, records) = the_run(&f).await;

    let run = f
        .state
        .db
        .get_observation_run(&f.org, &run_id)
        .await
        .unwrap()
        .unwrap();
    assert!(
        run.viewer_key_id.starts_with(NO_VIEWER_KEY_PREFIX),
        "the Host names no key it does not have: {}",
        run.viewer_key_id
    );
    assert_eq!(run.next_seq, 0, "not one frame was sealed");
    assert!(f
        .state
        .db
        .read_observation_events(&f.org, &run_id, -1, 256)
        .await
        .unwrap()
        .is_empty());
    // And the store would refuse one if something tried.
    let refused = f
        .state
        .db
        .append_observation_event(&opensesame_storage::ObservationAppend {
            organization_id: &f.org,
            run_id: &run_id,
            lane: "action",
            of_step: None,
            layout_epoch: None,
            payload: b"not-a-ciphertext",
            recorded_at: "2026-08-31T00:00:00+00:00",
        })
        .await;
    assert!(refused.is_err());

    // What a watcher gets instead: an empty sealed page that says so, and the
    // hook records as the run's observation.
    let (_, log) = send(
        &f.app,
        &f.alice,
        "GET",
        &format!("/api/v1/agent/runs/{run_id}/log"),
    )
    .await;
    assert_eq!(log["entries"], json!([]));
    assert_eq!(log["observation"], json!("hook_records_only"));
    let (status, page) = send(
        &f.app,
        &f.alice,
        "GET",
        &format!("/api/v1/agent/runs/{run_id}/hook-records"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert_eq!(
        page["records"].as_array().unwrap().len(),
        records.len(),
        "every recorded verdict is readable"
    );
    assert_eq!(page["summary"]["count"], json!(records.len()));
    assert_eq!(page["observation"], json!("hook_records_only"));
    let rendered = page.to_string();
    assert!(!rendered.contains("password"), "{rendered}");
}
