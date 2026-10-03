//! The second CTK harness (agent-hooks/0.1 §13.2): the emission engine, driven
//! by a scripted mock-agent loop.
//!
//! This is the CTK's own contract — a mocked model and mocked tools — run
//! against the engine `opensesame-rotation-web` emits through in production:
//! [`HookSession`] (one lock over the context builder, the emitter, the
//! lifecycle phase and the label ledger) and [`host_run`] (the lifecycle the
//! change-password and capture runs use). The loop below is the only thing
//! that is not production code, and it holds no emission logic of its own: it
//! decides *what happens next* from the vector's scripts and hands every
//! point to the session, taking back only what the session says may proceed.
//!
//! What it declares, and why, is narrower than a rotation host's claim:
//!
//! - **`model_calls`.** True of this loop and false of a rotation run. The
//!   loop dispatches the vector's mock model through
//!   [`HookSession::pre_model_call`] / [`HookSession::post_model_call`]. No
//!   run this crate orders does (ADR 0076 §8), which is why the adapter
//!   name says *emission engine, mock loop* and the first claim does not
//!   carry this capability.
//! - **`tool_calls`.** Every mock tool goes through
//!   [`HookSession::tool_call`], the bracket the eleven real verbs use.
//! - **`int64_json`.** Contexts are `serde_json` values holding `i64`.
//!   `bigint_json` is not claimed: `serde_json` coerces beyond-u64 literals
//!   at load, so this language layer cannot present such a context.
//! - **`tool_seam_host_error: continue`.** A refused tool call is surfaced to
//!   the mock model as an error message and the loop goes on, as the CTK's own
//!   reference loop does. That is the loop's posture; the rotation host's
//!   `terminate` is about its executors, not this loop.

use std::sync::{Arc, Mutex};

use agent_hooks::ctk::{async_trait, Harness, IdentityPair, RunRecord, VectorSetup};
use opensesame_rotation_web::hooks::{
    host_run, HookSession, HostInput, HostedRunError, ModelResponse, Refusal, SessionConfig,
};
use serde_json::{json, Value};

use crate::ctk_common::{redacted, role, AgentReport};

/// The name this claim is filed under.
pub const ADAPTER: &str = "opensesame-rotation-web (emission engine, mock loop)";

/// The capability subset this adapter declares (§3.2, §13.1).
pub const CAPABILITIES: [&str; 3] = ["model_calls", "tool_calls", "int64_json"];

/// The mock model's id in `model.id`.
const MODEL: &str = "mock";

/// A mock model call the session refused: the loop's turn ends there (§6).
#[derive(Debug)]
struct ModelRefused;

/// The vector's mock tools: `name → args → return`, every invocation logged.
struct MockTools {
    tools: Vec<Value>,
    log: Arc<Mutex<Vec<Value>>>,
}

impl MockTools {
    /// The first behavior whose `when_args` deep-equals `args`, or that has
    /// none, wins (HARNESS.md "Mock tools"). The invocation is recorded here,
    /// with the arguments the tool was actually called with, which is how the
    /// CTK proves a transform was honoured.
    fn invoke(&self, name: &str, args: &Value) -> Result<Value, Value> {
        self.log
            .lock()
            .unwrap()
            .push(json!({ "name": name, "args": args }));
        let spec = self
            .tools
            .iter()
            .find(|tool| tool["name"].as_str() == Some(name))
            .unwrap_or_else(|| panic!("tool {name} is not in the scenario"));
        let behavior = spec["behavior"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|clause| clause.get("when_args").is_none_or(|when| when == args))
            .unwrap_or_else(|| panic!("tool {name} invoked with {args}: no matching behavior"));
        let value = behavior["return"].clone();
        if behavior["is_error"].as_bool().unwrap_or(false) {
            Err(value)
        } else {
            Ok(value)
        }
    }
}

/// One proposed tool call, through the session, as a message for the model.
async fn tool_message(session: &HookSession, tools: &MockTools, call: &Value) -> Value {
    let id = call["id"].as_str().unwrap_or("");
    let name = call["name"].as_str().unwrap_or("");
    let outcome = session
        .tool_call(id, name, call["args"].clone(), |args| async move {
            tools.invoke(name, &args)
        })
        .await;
    match outcome {
        // The effective result: a `post_tool_call` transform is what the
        // model reads, and an error stays an error.
        Ok(Ok(value) | Err(value)) => json!({ "role": "tool", "content": value }),
        Err(refusal) => blocked_message(&refusal),
    }
}

/// What the mock model is told about a call it may not make.
fn blocked_message(refusal: &Refusal) -> Value {
    json!({
        "role": "tool",
        "content": format!("blocked: {}", refusal.reason.as_deref().unwrap_or("")),
    })
}

/// The mock agent loop: the model's script, one response per turn, until it
/// answers without tool calls.
async fn agent_loop(
    session: &HookSession,
    scenario: &Value,
    tools: &MockTools,
) -> Result<AgentReport, ModelRefused> {
    let input = &scenario["input"];
    let mut messages = vec![
        json!({ "role": input["role"].as_str().unwrap_or("user"), "content": input["content"] }),
    ];
    for step in scenario["model_script"].as_array().into_iter().flatten() {
        let scripted = &step["respond"];
        messages = session
            .pre_model_call(MODEL, messages)
            .await
            .map_err(|_| ModelRefused)?;
        let response = ModelResponse {
            content: scripted["content"].clone(),
            tool_calls: scripted["tool_calls"]
                .as_array()
                .cloned()
                .unwrap_or_default(),
            finish_reason: scripted["finish_reason"].as_str().unwrap_or("").to_owned(),
        };
        let response = session
            .post_model_call(MODEL, response)
            .await
            .map_err(|_| ModelRefused)?;
        if response.tool_calls.is_empty() {
            return Ok(AgentReport(response.content));
        }
        for call in &response.tool_calls {
            messages.push(tool_message(session, tools, call).await);
        }
        let said = if response.content.is_null() {
            json!("")
        } else {
            response.content
        };
        messages.push(json!({ "role": "assistant", "content": said }));
    }
    Ok(AgentReport(Value::Null))
}

/// The emission engine under the CTK, through the mock loop.
#[derive(Default)]
pub struct MockLoopHarness {
    scenario: Value,
    session: Option<HookSession>,
    log: Arc<Mutex<Vec<Value>>>,
    sessions: u64,
}

#[async_trait]
impl Harness for MockLoopHarness {
    fn name(&self) -> &'static str {
        ADAPTER
    }

    fn capabilities(&self) -> Vec<String> {
        CAPABILITIES.iter().map(|&c| c.to_owned()).collect()
    }

    fn setup(&mut self, setup: VectorSetup) {
        self.sessions += 1;
        self.scenario = setup.scenario;
        self.log = Arc::default();
        let config = SessionConfig {
            mode: setup.mode,
            composition: setup.composition,
            identity: setup.identity_provider,
            ..SessionConfig::new(format!("ctk-loop-{}", self.sessions))
        };
        let mut session = HookSession::new(config, setup.interceptors, setup.resolver)
            .expect("CTK identity providers satisfy §10.1");
        let paths = setup.redact_for_approval;
        if !paths.is_empty() {
            session = session.with_approval_redactor(move |context| redacted(context, &paths));
        }
        self.session = Some(session);
    }

    async fn run(&mut self) -> RunRecord {
        let session = self.session.as_ref().expect("setup precedes run");
        let scenario = &self.scenario;
        let tools = MockTools {
            tools: scenario["tools"].as_array().cloned().unwrap_or_default(),
            log: Arc::clone(&self.log),
        };
        let mut names: Vec<&str> = tools
            .tools
            .iter()
            .filter_map(|tool| tool["name"].as_str())
            .collect();
        names.sort_unstable();
        let input = HostInput {
            content: scenario["input"]["content"].clone(),
            role: role(&scenario["input"]),
        };
        let result = host_run(session, &names, &input, || {
            agent_loop(session, scenario, &tools)
        })
        .await;
        let (outcome, final_output) = match result {
            Ok(report) => ("completed", report.0),
            Err(
                HostedRunError::Refused(_) | HostedRunError::Withheld(_) | HostedRunError::Run(_),
            ) => ("blocked", Value::Null),
        };
        let records = session.records().await;
        RunRecord {
            outcome: outcome.to_owned(),
            final_output,
            tool_invocations: self.log.lock().unwrap().clone(),
            error: None,
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
        self.session = None;
    }
}
