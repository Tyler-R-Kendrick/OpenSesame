//! Shared fakes for the hosted-transport tests: a browser that records what
//! reached it, scripted interceptors, and sessions with fixed timestamps.
//!
//! The browser records every call *with its arguments*, because the property
//! under test is often "the inner transport never saw this call" or "it saw
//! the transformed argument, not the proposed one".
#![allow(dead_code)]

use std::sync::{Arc, Mutex};

use agent_hooks::{
    AgentContext, ApprovalOutcome, ApprovalRequest, ApprovalResolution, ApprovalResolver, Decision,
    InterceptionRecord, Interceptor, Transform, Verdict,
};
use async_trait::async_trait;
use opensesame_ceremony::{CaptureDigest, Slot};
use opensesame_rotation_web::hooks::{
    HookSession, HookedTransport, HostInput, InputRole, SessionConfig, BROWSER_VERBS,
    CEREMONY_VERBS,
};
use opensesame_rotation_web::{
    AdmittedFrame, BlockedReason, BrowserTransport, CandidateHandle, CandidateVault, CaptureError,
    CeremonyTransport, ChangePasswordRecipe, CredentialRef, Filled, Presence, RedactedDom,
    StepError, Verified,
};
use opensesame_session_observe::{LayoutEpoch, MaskManifest};
use serde_json::{json, Value};

/// A browser that answers the happy path and logs `verb(args)`.
#[derive(Default)]
pub struct FakeBrowser {
    pub calls: Mutex<Vec<String>>,
    pub dom: Option<String>,
    pub frame: Option<Vec<u8>>,
    pub presence: Option<Presence>,
    pub wait_error: Option<StepError>,
    pub outstanding: Vec<Slot>,
}

impl FakeBrowser {
    pub fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }

    pub fn verbs(&self) -> Vec<String> {
        self.calls()
            .into_iter()
            .map(|call| call.split('(').next().unwrap_or_default().to_owned())
            .collect()
    }

    fn log(&self, call: String) {
        self.calls.lock().unwrap().push(call);
    }
}

#[async_trait]
impl BrowserTransport for FakeBrowser {
    async fn navigate(&self, url: &str) -> Result<(), StepError> {
        self.log(format!("navigate({url})"));
        Ok(())
    }
    async fn wait_for(&self, selector: &str) -> Result<(), StepError> {
        self.log(format!("wait_for({selector})"));
        self.wait_error.map_or(Ok(()), Err)
    }
    async fn fill_credential(&self, r: &CredentialRef, s: &str) -> Result<Filled, StepError> {
        self.log(format!("fill_credential({},{s})", r.as_str()));
        Ok(Filled::Ok)
    }
    async fn assert_present(&self, r: &CredentialRef, s: &str) -> Result<Presence, StepError> {
        self.log(format!("assert_present({},{s})", r.as_str()));
        Ok(self.presence.unwrap_or(Presence::Present))
    }
    async fn submit(&self, selector: &str) -> Result<(), StepError> {
        self.log(format!("submit({selector})"));
        Ok(())
    }
    async fn read_dom_redacted(&self) -> Result<RedactedDom, StepError> {
        self.log("read_dom_redacted()".into());
        let text = self.dom.clone().ok_or(StepError::Transport)?;
        Ok(RedactedDom::from_stripped(text, LayoutEpoch(7)))
    }
    async fn screenshot_redacted(
        &self,
        mask: MaskManifest,
    ) -> Result<Option<AdmittedFrame>, StepError> {
        self.log("screenshot_redacted()".into());
        Ok(self
            .frame
            .clone()
            .map(|bytes| AdmittedFrame::new(bytes, mask.epoch())))
    }
    async fn verify_login(&self, r: &CredentialRef) -> Result<Verified, StepError> {
        self.log(format!("verify_login({})", r.as_str()));
        Ok(Verified::Works)
    }
}

#[async_trait]
impl CeremonyTransport for FakeBrowser {
    async fn outstanding(&self) -> Vec<Slot> {
        self.log("outstanding()".into());
        self.outstanding.clone()
    }
    async fn capture_credential(
        &self,
        slot: Slot,
        selector: &str,
    ) -> Result<CaptureDigest, CaptureError> {
        self.log(format!("capture_credential({},{selector})", slot.as_str()));
        Ok(CaptureDigest::of_sealed(
            slot,
            format!("blob:{}", slot.as_str()),
        ))
    }
    async fn capture_download(
        &self,
        slot: Slot,
        content_type: &str,
    ) -> Result<CaptureDigest, CaptureError> {
        self.log(format!(
            "capture_download({},{content_type})",
            slot.as_str()
        ));
        Ok(CaptureDigest::of_sealed(
            slot,
            format!("blob:{}", slot.as_str()),
        ))
    }
}

type Rule = dyn Fn(&AgentContext) -> Verdict + Send + Sync;

/// An interceptor that answers by closure and remembers what it was shown.
#[derive(Clone)]
pub struct Scripted {
    rule: Arc<Rule>,
    seen: Arc<Mutex<Vec<AgentContext>>>,
}

impl Scripted {
    pub fn new(rule: impl Fn(&AgentContext) -> Verdict + Send + Sync + 'static) -> Self {
        Self {
            rule: Arc::new(rule),
            seen: Arc::new(Mutex::new(Vec::new())),
        }
    }

    pub fn allow_all() -> Self {
        Self::new(|_| Verdict::allow())
    }

    pub fn seen(&self) -> Vec<AgentContext> {
        self.seen.lock().unwrap().clone()
    }
}

#[async_trait]
impl Interceptor for Scripted {
    async fn intercept(&self, context: &AgentContext) -> Verdict {
        self.seen.lock().unwrap().push(context.clone());
        // Yield so concurrent verbs genuinely interleave their emissions.
        tokio::task::yield_now().await;
        (self.rule)(context)
    }
}

/// A resolver that answers every consultation with one outcome.
pub struct Answering(pub ApprovalOutcome);

#[async_trait]
impl ApprovalResolver for Answering {
    async fn resolve(&self, request: ApprovalRequest<'_>) -> ApprovalResolution {
        ApprovalResolution {
            outcome: self.0,
            context_identity: request.context_identity.clone(),
            verdict: (self.0 == ApprovalOutcome::Approve).then(Verdict::allow),
        }
    }
}

pub fn point(context: &AgentContext) -> &str {
    context["interception_point"].as_str().unwrap_or_default()
}

pub fn tool_name(context: &AgentContext) -> &str {
    context["tool_call"]["name"].as_str().unwrap_or_default()
}

/// A rule matching one interception point and, for tool points, one verb.
pub fn at(context: &AgentContext, wanted: &str, verb: Option<&str>) -> bool {
    point(context) == wanted && verb.is_none_or(|name| tool_name(context) == name)
}

pub fn session(interceptor: &Scripted) -> HookSession {
    session_resolving(interceptor, None)
}

pub fn session_resolving(
    interceptor: &Scripted,
    resolver: Option<Box<dyn ApprovalResolver>>,
) -> HookSession {
    HookSession::new(
        SessionConfig::new("run:test"),
        vec![Box::new(interceptor.clone())],
        resolver,
    )
    .expect("the default identity provider is valid")
    .with_timestamps(|| "2026-09-28T00:00:00.000Z".to_owned())
}

pub fn run_input() -> HostInput {
    HostInput {
        content: json!({ "run": "change_password", "recipe": "example", "origin": "https://example.com" }),
        role: InputRole::System,
    }
}

/// Open a turn so tool verbs may be emitted.
pub async fn opened<T>(inner: T, interceptor: &Scripted) -> HookedTransport<T> {
    let hooked = HookedTransport::new(inner, session(interceptor));
    let tools: Vec<&str> = BROWSER_VERBS
        .iter()
        .chain(&CEREMONY_VERBS)
        .copied()
        .collect();
    hooked.session().startup(&tools).await.unwrap();
    hooked.session().input(&run_input()).await.unwrap();
    hooked
}

pub fn wire(records: &[InterceptionRecord]) -> Vec<Value> {
    records
        .iter()
        .map(|record| serde_json::to_value(record).unwrap())
        .collect()
}

pub fn points_of(records: &[InterceptionRecord]) -> Vec<String> {
    records
        .iter()
        .map(|record| record.interception_point.as_str().to_owned())
        .collect()
}

pub fn transform(path: &str, value: Value) -> Verdict {
    Verdict {
        decision: Decision::Transform,
        transform: Some(Transform {
            path: path.to_owned(),
            value,
        }),
        ..Verdict::allow()
    }
}

/// A token-shaped string, assembled at run time so no source line holds one.
pub fn token_shaped() -> String {
    format!("ghp_{}", "x".repeat(36))
}

pub struct FakeVault;

#[async_trait]
impl CandidateVault for FakeVault {
    async fn generate_candidate(&self) -> Result<CandidateHandle, BlockedReason> {
        Ok(CandidateHandle::new("cand:1"))
    }
    async fn seal_and_await_backup(&self, _candidate: &CandidateHandle) -> bool {
        true
    }
    async fn promote(&self, _candidate: &CandidateHandle) {}
}

pub fn recipe() -> ChangePasswordRecipe {
    ChangePasswordRecipe {
        change_url: "https://example.com/.well-known/change-password".into(),
        current_password_selector: Some("#current".into()),
        new_password_selector: "#new".into(),
        confirm_password_selector: None,
        submit_selector: "#save".into(),
    }
}
