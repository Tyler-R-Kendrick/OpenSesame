//! The CTK's tool-seam interceptor scripts, replayed against the hosted verbs.
//!
//! Not a conformance run, and not reported as one. The pinned corpus only
//! reaches `pre_tool_call` through a mock *model*, so every vector that
//! exercises the tool seam requires `model_calls` and is correctly skipped for
//! this tool router (`tests/agent_hooks_ctk.rs`). The seam is still this
//! host's, though, so this file takes those vectors' own `interceptor_script`
//! rules — read from the vendored files, evaluated by the SDK's
//! `ctk_engine::scripted_intercept` — and drives a real verb through them,
//! asserting the tool-level half of each vector's `expect`.
//!
//! Only scripts that do not match on a mock tool's name are replayable; the
//! rest name tools (`delete_files`, `http_get`) this surface does not have.

mod hooks_support;

use agent_hooks::ctk_engine::scripted_intercept;
use agent_hooks::{
    verdict_from_wire, AgentContext, Decision, EnforcementMode, InterceptionPoint, Interceptor,
    Verdict,
};
use async_trait::async_trait;
use hooks_support::{run_input, FakeBrowser};
use opensesame_rotation_web::hooks::{HookSession, HookedTransport, SessionConfig, BROWSER_VERBS};
use opensesame_rotation_web::{BrowserTransport, StepError};
use serde_json::Value;

/// A vector's `interceptor_script`, as an interceptor. A scripted `raise`
/// really panics — the emitter's panic isolation is what is under test — and
/// a malformed verdict is handed over malformed.
struct VectorScript(Vec<Value>);

#[async_trait]
impl Interceptor for VectorScript {
    async fn intercept(&self, context: &AgentContext) -> Verdict {
        let wire = scripted_intercept(&self.0, &Value::Object(context.clone()));
        assert!(
            wire.get("__ctk_fault__").and_then(Value::as_str) != Some("raise"),
            "scripted raise"
        );
        verdict_from_wire(&wire).unwrap_or(Verdict {
            decision: Decision::Transform,
            ..Verdict::allow()
        })
    }
}

fn vector(id: &str) -> Value {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../spec/agent-hooks/conformance/vectors");
    let entry = std::fs::read_dir(dir)
        .expect("vendored corpus")
        .filter_map(Result::ok)
        .find(|e| e.file_name().to_string_lossy().starts_with(id))
        .expect("vector present");
    serde_json::from_str(&std::fs::read_to_string(entry.path()).expect("read")).expect("JSON")
}

/// A hooked browser, mid-turn, under `id`'s script and mode.
async fn under(id: &str) -> HookedTransport<FakeBrowser> {
    let v = vector(id);
    let rules = v["interceptor_script"]
        .as_array()
        .cloned()
        .expect("single script");
    let mode = if v["mode"] == "evaluate_only" {
        EnforcementMode::EvaluateOnly
    } else {
        EnforcementMode::Enforce
    };
    let config = SessionConfig {
        mode,
        ..SessionConfig::new(format!("seam-{id}"))
    };
    let session = HookSession::new(config, vec![Box::new(VectorScript(rules))], None).unwrap();
    let hooked = HookedTransport::new(FakeBrowser::default(), session);
    hooked.session().startup(&BROWSER_VERBS).await.unwrap();
    hooked.session().input(&run_input()).await.unwrap();
    hooked
}

async fn pre_tool_record(hooked: &HookedTransport<FakeBrowser>) -> Value {
    let records = hooked.session().records().await;
    let record = records
        .iter()
        .find(|r| r.interception_point == InterceptionPoint::PreToolCall)
        .expect("a pre_tool_call record");
    serde_json::to_value(record).unwrap()
}

#[tokio::test]
async fn ctk_021_the_deprecated_policy_target_alias_rewrites_the_argument() {
    // The script rewrites the URL to `https://safe.example`. The rewrite is
    // applied when it stays on the origin the executor proposed...
    let hooked = under("AH-CTK-021").await;
    hooked.navigate("https://safe.example/risky").await.unwrap();
    assert_eq!(hooked.inner().calls(), ["navigate(https://safe.example)"]);
}

#[tokio::test]
async fn ctk_021_the_same_rewrite_to_another_origin_is_transform_invalid() {
    // ...and is `transform_invalid` when it would move the navigation to
    // another origin: which site a run reaches is not an interceptor's call
    // (`hooks::authority`, ADR 0150).
    let hooked = under("AH-CTK-021").await;
    assert_eq!(
        hooked.navigate("https://example.com/risky").await,
        Err(StepError::Refused)
    );
    assert!(hooked.inner().calls().is_empty());
    let records = hooked.session().records().await;
    let last = records.last().unwrap();
    assert_eq!(
        last.verdict.reason.as_deref(),
        Some("host_error:transform_invalid")
    );
}

#[tokio::test]
async fn ctk_032_an_escalation_with_no_resolver_stands_as_a_deny() {
    let hooked = under("AH-CTK-032").await;
    assert_eq!(
        hooked.navigate("https://example.com").await,
        Err(StepError::Refused)
    );
    assert!(hooked.inner().calls().is_empty());
    assert_eq!(
        pre_tool_record(&hooked).await["verdict"]["reason"],
        "ctk:requires_approval"
    );
}

#[tokio::test]
async fn ctk_040_evaluate_only_records_the_deny_and_proceeds() {
    let hooked = under("AH-CTK-040").await;
    hooked.navigate("https://example.com").await.unwrap();
    assert_eq!(hooked.inner().verbs(), ["navigate"]);
    let record = pre_tool_record(&hooked).await;
    assert_eq!(record["verdict"]["decision"], "deny");
    assert_eq!(record["mode"], "evaluate_only");
}

#[tokio::test]
async fn ctk_050_a_warning_proceeds_and_lands_on_the_record() {
    let hooked = under("AH-CTK-050").await;
    hooked.navigate("https://example.com").await.unwrap();
    assert_eq!(hooked.inner().verbs(), ["navigate"]);
    let record = pre_tool_record(&hooked).await;
    assert_eq!(record["verdict"]["decision"], "allow");
    assert_eq!(record["verdict"]["warnings"][0]["reason"], "ctk:suspicious");
}

#[tokio::test]
async fn ctk_070_071_092_a_failing_or_malformed_interceptor_fails_closed() {
    for (id, reason) in [
        ("AH-CTK-070", "host_error:interceptor_failed"),
        ("AH-CTK-071", "host_error:verdict_invalid"),
        ("AH-CTK-092", "host_error:verdict_invalid"),
    ] {
        let hooked = under(id).await;
        assert_eq!(
            hooked.navigate("https://example.com").await,
            Err(StepError::Refused),
            "{id}"
        );
        assert!(hooked.inner().calls().is_empty(), "{id}: tool not invoked");
        assert_eq!(
            pre_tool_record(&hooked).await["verdict"]["reason"],
            reason,
            "{id}"
        );
    }
}

#[tokio::test]
async fn ctk_093_the_record_keeps_the_path_and_drops_the_value() {
    let hooked = under("AH-CTK-093").await;
    hooked.navigate("https://safe/page").await.unwrap();
    assert_eq!(hooked.inner().calls(), ["navigate(https://safe)"]);
    let record = pre_tool_record(&hooked).await;
    assert_eq!(record["verdict"]["transform"]["path"], "$target.url");
    assert!(record["verdict"]["transform"].get("value").is_none());
    let message = record["verdict"]["message"].as_str().unwrap();
    assert!(message.len() <= 256 + '…'.len_utf8() && message.ends_with('…'));
}
