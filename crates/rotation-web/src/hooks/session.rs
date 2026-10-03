//! One run's agent-hooks session: the context builder, the lifecycle phase,
//! the labels and the records, and the public surface a run drives.
//!
//! # Concurrency (§12.2)
//!
//! A relay serving a remote agent may have several tool calls in flight, and
//! one of them may be parked on the approval seam — a person, possibly for
//! minutes. The session therefore never holds a lock while it awaits an
//! interceptor or the resolver. An emission is three steps (see `emission`):
//!
//! 1. **Reserve**, under a short lock: check the phase, build the context —
//!    which assigns its `sequence` atomically (§12.2.3) — and take a fresh
//!    emitter from the session's shared parts (see `recipe`).
//! 2. **Dispatch**, with no lock: the SDK runs the interceptors and, if a
//!    verdict is liftable, the resolver. Emissions of different tool calls
//!    overlap here, as §12.2.2 allows; within one emission the composition
//!    profile governs, and a sequential fold stays sequential.
//! 3. **Settle**, under a short lock: the phase, the labels and the record
//!    are applied, and the record leaves in `sequence` order (see `log`).
//!
//! The one thing that does not overlap is a run's boundary: `agent_startup`,
//! `input`, `output` and `agent_shutdown` each wait for every emission in
//! flight and are then emitted alone (`phase::overlaps`), so §3.1's ordering
//! is true by construction and nothing is sequenced between a boundary and
//! the emissions it closes over.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard, PoisonError};

use agent_hooks::{
    AgentContext, AgentContextBuilder, ApprovalResolver, CompositionConfig, EnforcementMode,
    HostError, IdentityProvider, InterceptionPoint, InterceptionRecord, Interceptor,
};
use tokio::sync::RwLock;

use super::labels::LabelLedger;
use super::log::RecordLog;
pub use super::log::RecordSink;
use super::phase::Phase;
use super::recipe::Recipe;
use super::refusal::{Refusal, ShutdownReason};

/// `agent.framework` on every context this crate emits.
pub const FRAMEWORK: &str = "opensesame-rotation-web";

/// How a run's hook session is configured. Host configuration (§7.1), never
/// something a driving agent can reach.
pub struct SessionConfig {
    /// `agent.id` — which `OpenSesame` runner this is.
    pub agent_id: String,
    /// `session.id` — the run's identifier, so records join the run's log.
    pub session_id: String,
    /// `enforce`, or `evaluate_only` for a shadow rollout (§8).
    pub mode: EnforcementMode,
    /// The composition profile and knobs (§7.2).
    pub composition: CompositionConfig,
    /// The identity provider (§10.1). `jcs-sha256` unless a caller says
    /// otherwise, because approvals bind to it (ADR 0156 §6).
    pub identity: IdentityProvider,
}

impl SessionConfig {
    /// Enforcing, `sequential/first_deny`, `jcs-sha256` — the SDK's defaults.
    #[must_use]
    pub fn new(session_id: impl Into<String>) -> Self {
        Self {
            agent_id: FRAMEWORK.to_owned(),
            session_id: session_id.into(),
            mode: EnforcementMode::Enforce,
            composition: CompositionConfig::default(),
            identity: IdentityProvider::JcsSha256,
        }
    }
}

/// What the short critical sections read and write.
pub(super) struct State {
    pub(super) builder: AgentContextBuilder,
    pub(super) phase: Phase,
    /// `pre_model_call`s that proceeded and have no `post_model_call` yet
    /// (§3.1.4). A host may have several in flight; none survives its turn.
    /// Claimed and released only under the state lock (see `emission`).
    pub(super) open_model_calls: u32,
    pub(super) labels: LabelLedger,
    pub(super) log: RecordLog,
    pub(super) last_refusal: Option<Refusal>,
}

/// One run's agent-hooks session.
///
/// Built once per run with the interceptors and the optional approval
/// resolver the caller injects — the gateway registers `OpenSesame`'s own
/// interceptor here — and shared by the hosted transport and the run driver.
/// It is `Sync`: verbs may be emitted from several tasks at once (see the
/// module documentation for what overlaps and what does not).
pub struct HookSession {
    pub(super) recipe: Recipe,
    /// Shared by every emission that may overlap, held alone by a run's
    /// boundary. Never held by anything that is not emitting.
    pub(super) gate: RwLock<()>,
    /// Only ever locked for a few field updates, never across an `await`.
    state: Mutex<State>,
    calls: AtomicU64,
    /// Whether the run stood down for a person rather than finishing or
    /// failing; asked once, when the run's report decides `agent_shutdown`'s
    /// reason.
    stand_down: Option<StandDown>,
}

type StandDown = Box<dyn Fn() -> bool + Send + Sync>;

impl HookSession {
    /// A session over `interceptors`, in registration order, with `resolver`
    /// as the §9 approval seam.
    ///
    /// # Errors
    ///
    /// [`HostError::ContextInvalid`] when a custom identity provider's name
    /// breaks the §10.1 naming rules.
    pub fn new(
        config: SessionConfig,
        interceptors: Vec<Box<dyn Interceptor>>,
        resolver: Option<Box<dyn ApprovalResolver>>,
    ) -> Result<Self, HostError> {
        let mut recipe = Recipe {
            mode: config.mode,
            composition: config.composition,
            identity: config.identity.into(),
            interceptors: Vec::new(),
            resolver: resolver.map(Into::into),
            redactor: None,
        };
        for interceptor in interceptors {
            recipe.register(interceptor);
        }
        // Reject a bad identity name now, not at the first emission.
        recipe.emitter()?;
        Ok(Self {
            recipe,
            gate: RwLock::new(()),
            state: Mutex::new(State {
                builder: AgentContextBuilder::new(&config.agent_id, FRAMEWORK, &config.session_id),
                phase: Phase::Fresh,
                open_model_calls: 0,
                labels: LabelLedger::default(),
                log: RecordLog::new(),
                last_refusal: None,
            }),
            calls: AtomicU64::new(0),
            stand_down: None,
        })
    }

    /// Deliver every record to `sink` as it is made, in `sequence` order.
    ///
    /// With a sink installed the session **stops keeping records** — the sink
    /// is where they live, and a long relay session would otherwise hold
    /// every one for its whole life. [`Self::records`] is then empty unless
    /// [`Self::with_retained_records`] asks for both.
    #[must_use]
    pub fn with_record_sink(mut self, sink: RecordSink) -> Self {
        self.state_mut().log.set_sink(sink);
        self
    }

    /// Say whether the run stood down for a person — a handoff, or a page a
    /// person already holds — which `agent_shutdown` records as `cancelled`
    /// rather than `error` (§4.2). The host's channel knows; the executor's
    /// outcome alone cannot tell a parked run from a failed transport.
    #[must_use]
    pub fn with_stand_down(
        mut self,
        stood_down: impl Fn() -> bool + Send + Sync + 'static,
    ) -> Self {
        self.stand_down = Some(Box::new(stood_down));
        self
    }

    /// Whether the run stood down for a person (see [`Self::with_stand_down`]).
    #[must_use]
    pub fn stood_down(&self) -> bool {
        self.stand_down.as_ref().is_some_and(|probe| probe())
    }

    /// Keep records for [`Self::records`] even with a sink installed.
    #[must_use]
    pub fn with_retained_records(mut self) -> Self {
        self.state_mut().log.keep();
        self
    }

    /// Bound the records [`Self::records`] holds: past `limit`, the oldest is
    /// dropped and counted ([`Self::records_dropped`]). A sink still sees
    /// every record.
    #[must_use]
    pub fn with_max_records(mut self, limit: usize) -> Self {
        self.state_mut().log.set_limit(limit);
        self
    }

    /// Register the §9/§14 approval redactor: what an approver is shown, and
    /// what `context_identity` is computed over.
    #[must_use]
    pub fn with_approval_redactor(
        mut self,
        redactor: impl Fn(&AgentContext) -> AgentContext + Send + Sync + 'static,
    ) -> Self {
        self.recipe.set_redactor(redactor);
        self
    }

    /// Replace the context timestamp source (deterministic tests).
    #[must_use]
    pub fn with_timestamps(mut self, now: impl Fn() -> String + Send + Sync + 'static) -> Self {
        let state = self.state_mut();
        let builder = std::mem::replace(&mut state.builder, AgentContextBuilder::new("", "", ""));
        state.builder = builder.with_timestamp_provider(now);
        self
    }

    /// The records the session is keeping, in `sequence` order.
    ///
    /// **Not every record ever emitted.** With no sink installed the session
    /// keeps them all (that is the only way to read them); with a sink it
    /// keeps none unless [`Self::with_retained_records`] was asked for; and
    /// [`Self::with_max_records`] keeps only the newest. A record appears
    /// here once every record sequenced before it has — so while an earlier
    /// emission is still parked on an approval, a later one that already
    /// finished is not listed yet, and no record is ever listed out of order.
    #[allow(clippy::unused_async)] // The public signature predates the split lock.
    pub async fn records(&self) -> Vec<InterceptionRecord> {
        self.lock().log.retained()
    }

    /// Retained records the [`Self::with_max_records`] limit has dropped.
    #[must_use]
    pub fn records_dropped(&self) -> u64 {
        self.lock().log.dropped()
    }

    /// The most recent refusal, so a caller holding only a `StepError` can
    /// learn the verdict's reason. Never content: a reason or a fixed marker.
    /// With several verbs in flight, "most recent" is the last to settle.
    #[allow(clippy::unused_async)] // The public signature predates the split lock.
    pub async fn last_refusal(&self) -> Option<Refusal> {
        self.lock().last_refusal.clone()
    }

    /// Emit `agent_startup` with the verbs this session's transport exposes.
    ///
    /// # Errors
    ///
    /// The [`Refusal`] when the combined verdict blocks the session (§6.1a).
    pub async fn startup(&self, tools: &[&str]) -> Result<(), Refusal> {
        let tools = tools.iter().map(|&name| name.to_owned()).collect();
        self.emit(
            InterceptionPoint::AgentStartup,
            |builder| builder.agent_startup(tools),
            |_| Some(()),
        )
        .await
    }

    /// Emit `agent_shutdown` and close the session. Its verdict is recorded
    /// and imposes nothing (§6.1a). A session that never started emits
    /// nothing, because a shutdown with no startup breaks §3.1. It waits for
    /// every emission already in flight, so it follows all of them.
    pub async fn shutdown(&self, reason: ShutdownReason) -> Option<InterceptionRecord> {
        self.emit_with(
            InterceptionPoint::AgentShutdown,
            |builder| builder.agent_shutdown(reason.as_str()),
            |record, _, _| super::emission::Concluded {
                result: record.clone(),
                // Nothing follows a shutdown, so there is nothing to
                // resurface labels to.
                applied: false,
                phase: Phase::Closed,
                refusal: None,
            },
        )
        .await
        .ok()
    }

    /// A fresh `tool_call.id`. Payload-free: a counter, never an argument.
    pub(crate) fn next_call_id(&self) -> String {
        format!("call-{}", self.calls.fetch_add(1, Ordering::Relaxed))
    }

    /// The state, for a few field updates. A panic elsewhere (a sink is
    /// caught, but a decode closure is not) poisons the lock; the fields are
    /// each valid on their own, so the session goes on rather than losing the
    /// audit trail with it.
    pub(super) fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn state_mut(&mut self) -> &mut State {
        self.state.get_mut().unwrap_or_else(PoisonError::into_inner)
    }
}
