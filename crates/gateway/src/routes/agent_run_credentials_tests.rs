//! A person taking the page ends the agent's autonomy, and what the run was
//! issued with it (ADR 0150 §6.2).

use std::sync::{Arc, Mutex};

use opensesame_session_observe::RunCredentials;

use super::tests::{fixture, seed, ALICE};
use super::*;

#[derive(Default)]
struct Recorder(Mutex<Vec<String>>);

impl RunCredentials for Recorder {
    fn revoke(&self, run_id: &str) -> usize {
        self.0.lock().unwrap().push(run_id.to_owned());
        1
    }
}

#[tokio::test]
async fn taking_the_page_revokes_the_runs_credentials_and_a_refused_take_does_not() {
    let f = fixture().await;
    let recorder = Arc::new(Recorder::default());
    let mut state = f.state.clone();
    state.run_credentials = recorder.clone();
    let wired = crate::routes::router(state);
    let parked = seed("run:1", ALICE, &f.org, "awaiting_human");
    let driving = seed("run:2", ALICE, &f.org, "agent_driving");
    f.state.db.create_observation_run(&parked).await.unwrap();
    f.state.db.create_observation_run(&driving).await.unwrap();

    // The agent still drives run:2: there is no page to take, and its
    // credentials stay.
    let elevation = f.browser.elevation(&f.state, "run:2", "take").await;
    let (status, _) = f
        .browser
        .send(
            &wired,
            "POST",
            "/api/v1/agent/runs/run:2/control",
            Some(json!({ "elevation": elevation })),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert!(recorder.0.lock().unwrap().is_empty());

    let elevation = f.browser.elevation(&f.state, "run:1", "take").await;
    let (status, view) = f
        .browser
        .send(
            &wired,
            "POST",
            "/api/v1/agent/runs/run:1/control",
            Some(json!({ "elevation": elevation })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{view}");
    assert_eq!(*recorder.0.lock().unwrap(), ["run:1"]);
}
