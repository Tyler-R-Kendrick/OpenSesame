//! The CTK harness (agent-hooks/0.1 §13.2) over the hosted adapter.
//!
//! It drives the production emission path — a [`HookedTransport`] and its
//! [`HookSession`] through [`host_run`], the same function
//! `run_change_password_hooked` calls — with only the I/O mocked, which is what
//! `conformance/CLAIMS.md` asks a harness to confirm.
//!
//! The declared surface is the host's, stated honestly (§3.2, §13.1):
//!
//! - **No `model_calls`.** ADR 0076 §8 keeps the model in the remote runner, on
//!   the far side of the tool boundary; this host never dispatches a model
//!   request, so it never emits `pre_model_call`/`post_model_call`. A vector's
//!   `model_script` therefore stands for the remote agent: its final
//!   response content is the report the run hands back at `output`.
//! - **`tool_calls`.** Every verb is bracketed (`tests/hooked_verbs.rs`). The
//!   pinned corpus only proposes tool calls from a mock model, so a scenario
//!   that proposes one is outside what a tool router can be handed; the
//!   harness says so as a run `error` — loudly, never as a pass — and the
//!   capability gate means no applicable vector reaches that branch.
//! - **`int64_json`.** Contexts are `serde_json` values holding `i64`.
//!   `bigint_json` is not claimed, for the reason the reference harness gives.

use std::sync::Mutex;

use agent_hooks::ctk::{async_trait, Harness, IdentityPair, RunRecord, VectorSetup};
use agent_hooks::{apply_transform_to_ctx, AgentContext, Transform};
use opensesame_rotation_web::hooks::{
    host_run, HookSession, HookedTransport, HostInput, HostedRunError, InputRole, Reported,
    SessionConfig, BROWSER_VERBS,
};
use opensesame_rotation_web::{
    AdmittedFrame, BrowserTransport, CredentialRef, Filled, Presence, RedactedDom, StepError,
    Verified,
};
use opensesame_session_observe::MaskManifest;
use serde_json::{json, Value};

/// The capability subset this host declares (§3.2, §13.1).
pub const CAPABILITIES: [&str; 2] = ["tool_calls", "int64_json"];

/// The mocked browser I/O. Every verb is logged as `{name, args}` and answers
/// that the runner could not act; no applicable vector invokes one.
#[derive(Default)]
pub struct MockedIo {
    log: Mutex<Vec<Value>>,
}

impl MockedIo {
    fn call<T>(&self, name: &str, args: &Value) -> Result<T, StepError> {
        self.log
            .lock()
            .unwrap()
            .push(json!({ "name": name, "args": args }));
        Err(StepError::Transport)
    }
}

#[async_trait]
impl BrowserTransport for MockedIo {
    async fn navigate(&self, url: &str) -> Result<(), StepError> {
        self.call("navigate", &json!({ "url": url }))
    }
    async fn wait_for(&self, selector: &str) -> Result<(), StepError> {
        self.call("wait_for", &json!({ "selector": selector }))
    }
    async fn fill_credential(&self, r: &CredentialRef, s: &str) -> Result<Filled, StepError> {
        self.call("fill_credential", &json!({ "reference": r, "selector": s }))
    }
    async fn assert_present(&self, r: &CredentialRef, s: &str) -> Result<Presence, StepError> {
        self.call("assert_present", &json!({ "reference": r, "selector": s }))
    }
    async fn submit(&self, selector: &str) -> Result<(), StepError> {
        self.call("submit", &json!({ "selector": selector }))
    }
    async fn read_dom_redacted(&self) -> Result<RedactedDom, StepError> {
        self.call("read_dom_redacted", &json!({}))
    }
    async fn screenshot_redacted(
        &self,
        m: MaskManifest,
    ) -> Result<Option<AdmittedFrame>, StepError> {
        self.call("screenshot_redacted", &json!({ "mask": m }))
    }
    async fn verify_login(&self, r: &CredentialRef) -> Result<Verified, StepError> {
        self.call("verify_login", &json!({ "reference": r }))
    }
}

/// The remote agent's final report, as the run's `output`.
struct AgentReport(Value);

impl Reported for AgentReport {
    fn report(&self) -> Value {
        self.0.clone()
    }
    fn restate(self, report: Value) -> Option<Self> {
        Some(Self(report))
    }
}

/// A scenario this host cannot be handed: tool calls proposed by a model.
#[derive(Debug)]
struct ModelProposedToolCalls;

/// The remote agent, scripted. Without tool calls there is nothing between
/// its first response and its last, so the first response is its report.
fn remote_agent(scenario: &Value) -> Result<AgentReport, ModelProposedToolCalls> {
    let Some(respond) = scenario["model_script"].get(0).map(|step| &step["respond"]) else {
        return Ok(AgentReport(Value::Null));
    };
    let proposes = respond["tool_calls"]
        .as_array()
        .is_some_and(|calls| !calls.is_empty());
    if proposes {
        return Err(ModelProposedToolCalls);
    }
    Ok(AgentReport(respond["content"].clone()))
}

/// The CTK's §9 redaction convention: each listed path becomes "[redacted]";
/// a path that does not resolve at the escalating point is left alone.
fn redacted(context: &AgentContext, paths: &[String]) -> AgentContext {
    let mut shown = context.clone();
    for path in paths {
        let redaction = Transform {
            path: path.clone(),
            value: json!("[redacted]"),
        };
        let _ = apply_transform_to_ctx(&mut shown, &redaction);
    }
    shown
}

fn role(input: &Value) -> InputRole {
    match input["role"].as_str() {
        Some("system") => InputRole::System,
        Some("external") => InputRole::External,
        _ => InputRole::User,
    }
}

/// `opensesame-rotation-web` under the CTK.
#[derive(Default)]
pub struct RotationWebHarness {
    scenario: Value,
    hooked: Option<HookedTransport<MockedIo>>,
    sessions: u64,
}

#[async_trait]
impl Harness for RotationWebHarness {
    fn name(&self) -> &'static str {
        "opensesame-rotation-web"
    }

    fn capabilities(&self) -> Vec<String> {
        CAPABILITIES.iter().map(|&c| c.to_owned()).collect()
    }

    fn setup(&mut self, setup: VectorSetup) {
        self.sessions += 1;
        self.scenario = setup.scenario;
        let config = SessionConfig {
            mode: setup.mode,
            composition: setup.composition,
            identity: setup.identity_provider,
            ..SessionConfig::new(format!("ctk-{}", self.sessions))
        };
        let mut session = HookSession::new(config, setup.interceptors, setup.resolver)
            .expect("CTK identity providers satisfy §10.1");
        let paths = setup.redact_for_approval;
        if !paths.is_empty() {
            session = session.with_approval_redactor(move |context| redacted(context, &paths));
        }
        self.hooked = Some(HookedTransport::new(MockedIo::default(), session));
    }

    async fn run(&mut self) -> RunRecord {
        let hooked = self.hooked.as_ref().expect("setup precedes run");
        let scenario = &self.scenario;
        let input = HostInput {
            content: scenario["input"]["content"].clone(),
            role: role(&scenario["input"]),
        };
        let result = host_run(hooked.session(), &BROWSER_VERBS, &input, || async {
            remote_agent(scenario)
        })
        .await;
        let (outcome, final_output, error) = match result {
            Ok(report) => ("completed", report.0, None),
            Err(HostedRunError::Refused(_) | HostedRunError::Withheld(_)) => {
                ("blocked", Value::Null, None)
            }
            Err(HostedRunError::Run(ModelProposedToolCalls)) => (
                "error",
                Value::Null,
                Some("a tool router is not handed model-proposed tool calls".to_owned()),
            ),
        };
        let records = hooked.session().records().await;
        RunRecord {
            outcome: outcome.to_owned(),
            final_output,
            tool_invocations: hooked.inner().log.lock().unwrap().clone(),
            error,
            identities: records
                .iter()
                .map(|r| IdentityPair {
                    input_identity: r.input_identity.clone(),
                    enforced_identity: r.enforced_identity.clone(),
                })
                .collect(),
            records: records
                .iter()
                .map(|r| serde_json::to_value(r).expect("records serialize"))
                .collect(),
        }
    }

    fn teardown(&mut self) {
        self.hooked = None;
    }
}
