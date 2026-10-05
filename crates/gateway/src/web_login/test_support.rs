//! A world for the runner's tests: an organization with a verified recipe, a
//! hook policy and an owned rotation policy for each site, a bus the test can
//! read back, and a stand-in for the owner's browser that claims and settles
//! steps straight through the store — the same rows the step routes move.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use chrono::Utc;
use opensesame_agent_hooks::sdk::{AgentContext, Interceptor, Verdict};
use opensesame_connection_broker::{RotationPolicy, RotationTarget, UpsertRotationPolicy};
use opensesame_domain::OrganizationId;
use opensesame_lifecycle::{ExpiryStage, ExpirySubject, LifecycleEvent, SubjectKind};
use opensesame_session_observe::HandoffOutcome;
use opensesame_storage::agent_hook_policy::{AgentHookPolicyAudit, AgentHookPolicyWrite};
use opensesame_storage::{Db, ObservationControlUpdate};
use opensesame_task_bus::{BusEvent, InMemoryTaskBus, TaskBus};
use serde_json::{json, Value};
use tokio::sync::RwLock;

use super::control::lease_of;
use super::{RunTiming, WebLoginLauncher};
use crate::app_state::{test_demo_state, AppState};

pub(super) const OWNER: &str = "principal:00000000-0000-4000-8000-000000000011";
pub(super) const SITE: &str = "https://login.example";
pub(super) const ALLOW_ALL: &str = r#"{"version":1,"unlisted_tools":"allow"}"#;

pub(super) struct World {
    pub state: AppState,
    pub org: OrganizationId,
    pub bus: Arc<InMemoryTaskBus>,
    pub policies: Vec<RotationPolicy>,
    log: std::sync::Mutex<Vec<BusEvent>>,
}

impl World {
    pub fn org_text(&self) -> String {
        self.org.to_string()
    }

    /// The same store seen by another gateway process: its own registry, the
    /// database shared.
    pub fn another_process(&self) -> AppState {
        AppState {
            web_login_runs: Arc::new(super::registry::RunRegistry::default_for_tests()),
            ..self.state.clone()
        }
    }

    /// Every bus event of `event_type` published since the world was made.
    pub async fn published(&self, event_type: &str) -> Vec<BusEvent> {
        let fresh = self.bus.drain(10_000).await.unwrap();
        let mut log = self.log.lock().unwrap();
        log.extend(fresh);
        log.iter()
            .filter(|event| event.r#type == event_type)
            .cloned()
            .collect()
    }
}

/// An organization with one owned, verified web-login policy per site.
pub(super) async fn world(sites: &[&str], hook_policy: &str) -> World {
    let mut state = test_demo_state().await;
    let bus = Arc::new(InMemoryTaskBus::default());
    let dynamic: Arc<dyn TaskBus> = bus.clone();
    state.task_bus = Arc::new(RwLock::new(dynamic));
    let org = state.connection_organization;
    let org_text = org.to_string();
    state
        .db
        .put_agent_hook_policy(
            &AgentHookPolicyWrite {
                organization_id: &org_text,
                policy_json: hook_policy,
                expected_version: 0,
                updated_by: "operator",
            },
            &AgentHookPolicyAudit {
                event_type: crate::agent_hooks::EVENT_POLICY_UPDATED,
                payload_json: "{}",
            },
        )
        .await
        .unwrap();
    let mut policies = Vec::new();
    for site in sites {
        super::recipe_fixture::seed(&state.db, &org_text, site, true).await;
        policies.push(
            state
                .connection_broker
                .upsert_rotation_policy(
                    &org_text,
                    UpsertRotationPolicy {
                        id: None,
                        target: RotationTarget::WebLogin {
                            origin: (*site).into(),
                        },
                        owner_subject: Some(OWNER.into()),
                        interval_seconds: 86_400,
                        enabled: true,
                    },
                )
                .await
                .unwrap(),
        );
    }
    // Setup wrote outbox and bus events of its own; the test reads its own.
    let _ = bus.drain(10_000).await;
    World {
        state,
        org,
        bus,
        policies,
        log: std::sync::Mutex::default(),
    }
}

/// The lifecycle rung that calls for a rotation of `site`.
pub(super) fn event(world: &World, site: &str) -> LifecycleEvent {
    let now = Utc::now();
    LifecycleEvent::for_stage(
        ExpirySubject {
            kind: SubjectKind::WebLogin,
            subject_id: site.into(),
            organization_id: world.org_text(),
            expires_at: now,
            renew_before_seconds: Some(1),
            auto_respond: true,
            alerting: false,
            label: None,
        },
        ExpiryStage::Renewal,
        now,
    )
}

pub(super) fn launcher(state: &AppState) -> WebLoginLauncher {
    WebLoginLauncher::new(state.clone(), None).with_timing(RunTiming {
        step_deadline: Duration::from_secs(20),
        poll: Duration::from_millis(5),
        run_deadline: Duration::from_secs(60),
    })
}

/// What a well-behaved extension settles for each step.
pub(super) fn happy(request: &Value) -> Value {
    match request["step"].as_str().unwrap_or_default() {
        "fill_credential" => json!({"outcome": "filled", "filled": "Ok"}),
        "assert_present" => json!({"outcome": "presence", "presence": "Present"}),
        "verify_login" => json!({"outcome": "verified", "verified": "Works"}),
        "seal_candidate" => json!({"outcome": "sealed", "backed_up": true}),
        _ => json!({"outcome": "done"}),
    }
}

/// Every step a completed run hands its driver, in order.
pub(super) const COMPLETE_RUN: [&str; 11] = [
    "navigate",
    "wait_for",
    "generate_candidate",
    "seal_candidate",
    "fill_credential",
    "fill_credential",
    "fill_credential",
    "assert_present",
    "submit",
    "verify_login",
    "promote_candidate",
];

/// The owner's browser: claim each run's outstanding step, let the test act on
/// it, and settle it with `happy`'s answer. Runs until `done`.
///
/// `on_claim` is called with each claimed request before it is settled — where
/// a test makes a person ask for the page.
pub(super) async fn drive<F, Fut>(state: &AppState, org: &str, done: &AtomicBool, mut on_claim: F)
where
    F: FnMut(Value) -> Fut,
    Fut: std::future::Future<Output = ()>,
{
    while !done.load(Ordering::SeqCst) {
        let mut acted = false;
        for run in state.db.list_observation_runs(org, 50).await.unwrap() {
            if run.closed_at.is_some() {
                continue;
            }
            let now = Utc::now();
            let expires = now + chrono::Duration::seconds(30);
            let Some(step) = state
                .db
                .claim_runner_step(
                    org,
                    &run.id,
                    OWNER,
                    &now.to_rfc3339(),
                    &expires.to_rfc3339(),
                )
                .await
                .unwrap()
            else {
                continue;
            };
            let request: Value = serde_json::from_str(&step.request_json).unwrap();
            on_claim(request.clone()).await;
            let outcome = happy(&request).to_string();
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

/// The steps a run has queued so far, by name, in order.
pub(super) async fn queued(db: &Db, run_id: &str) -> Vec<String> {
    let rows: Vec<(String, i64, String)> = sqlx::query_as(
        "SELECT organization_id, seq, request_json FROM runner_steps WHERE run_id = ? ORDER BY seq",
    )
    .bind(run_id)
    .fetch_all(db.pool())
    .await
    .unwrap();
    rows.iter()
        .map(|(organization, seq, row)| {
            // The column rests sealed once any test in the process has
            // installed the sealer (ADR 0157); read it the way the store does.
            let row = opensesame_event_seal::open_in(
                organization,
                "runner_steps.request_json",
                &format!("{run_id}:{seq}"),
                row,
            )
            .unwrap();
            serde_json::from_str::<Value>(&row).unwrap()["step"]
                .as_str()
                .unwrap()
                .to_owned()
        })
        .collect()
}

/// What `POST …/handoff` does: rebuild the lease from the run's row, ask it,
/// and write the answer under the version read. `None` when the machine
/// refused, or the row kept moving.
pub(super) async fn request_handoff(db: &Db, org: &str, run_id: &str) -> Option<HandoffOutcome> {
    for _ in 0..10 {
        let run = db.get_observation_run(org, run_id).await.unwrap()?;
        let mut lease = lease_of(&run)?;
        let outcome = lease.request_handoff().ok()?;
        let update = ObservationControlUpdate {
            run_id: run.id.clone(),
            organization_id: org.into(),
            expected_version: run.version,
            control_state: super::control::wire(lease.state()),
            quiescence: super::control::wire(lease.quiescence()),
            handoff_queued: lease.handoff_queued(),
            lease_holder: None,
            lease_expires_at: None,
            blocked_reason: run.blocked_reason.clone(),
        };
        let now = Utc::now().to_rfc3339();
        if db
            .update_observation_control(&update, &now)
            .await
            .unwrap()
            .is_some()
        {
            return Some(outcome);
        }
    }
    None
}

/// The one open run of `org`, once it exists.
pub(super) async fn the_open_run(db: &Db, org: &str) -> opensesame_storage::StoredObservationRun {
    for _ in 0..1000 {
        let runs = db.list_observation_runs(org, 10).await.unwrap();
        if let Some(run) = runs.into_iter().find(|run| run.closed_at.is_none()) {
            return run;
        }
        tokio::time::sleep(Duration::from_millis(3)).await;
    }
    panic!("no run was ever opened");
}

/// Records every context a hook session emits, and allows it.
#[derive(Clone, Default)]
pub(super) struct Tap(Arc<std::sync::Mutex<Vec<AgentContext>>>);

impl Tap {
    pub fn seen(&self) -> Vec<AgentContext> {
        self.0.lock().unwrap().clone()
    }

    /// The `summary.reason` of every `agent_shutdown` emitted, in order.
    pub fn shutdown_reasons(&self) -> Vec<String> {
        self.seen()
            .iter()
            .filter(|context| context["interception_point"] == "agent_shutdown")
            .map(|context| context["summary"]["reason"].as_str().unwrap().to_owned())
            .collect()
    }
}

#[async_trait]
impl Interceptor for Tap {
    async fn intercept(&self, context: &AgentContext) -> Verdict {
        self.0.lock().unwrap().push(context.clone());
        Verdict::allow()
    }
}
