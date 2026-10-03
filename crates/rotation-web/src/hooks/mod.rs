//! `OpenSesame` as an agent-hooks/0.1 **host** for its own agent-driven runs
//! (ADR 0150, ADR 0076, ADR 0082).
//!
//! ADR 0150 put `OpenSesame` on the interceptor's side of Agent Hooks. The runs
//! this crate orders — a web-login rotation, a registration ceremony's
//! captures — are agent loops of their own, and this module is the other side:
//! it emits the spec's interception points around them through the canonical
//! core's [`agent_hooks::InterceptionEmitter`], so any interceptor (the
//! gateway's own `OpenSesame` interceptor among them) governs them the way it
//! governs any other framework.
//!
//! # The seam: the transport, not the executors
//!
//! Hooks wrap the tool boundary — [`HookedTransport`] decorates a
//! [`BrowserTransport`](crate::BrowserTransport) /
//! [`CeremonyTransport`](crate::CeremonyTransport) — rather than living inside
//! `run_change_password` and `run_capture_steps`, for three reasons read off
//! the code:
//!
//! 1. **The trait is already the surface an agent sees.** ADR 0076 §1 defines
//!    the sandbox's tool surface as exactly these verbs. A T4 agentic run's
//!    remote model calls the same verbs a T3 recipe replay does; hooking the
//!    trait covers both, where hooking the executors would cover only the
//!    replay.
//! 2. **The executors stay readable as the orderings they are.** The two
//!    edges between a rotation and a lockout (the backup wait, the fail-closed
//!    presence assertion) are one function each, by design. A refused verb
//!    answers [`StepError::Refused`](crate::StepError::Refused) like any
//!    failed step, and the executors' existing fail-closed handling does the
//!    rest — nothing is submitted after a refused assertion.
//! 3. **Nothing can call around it.** A caller holding a `HookedTransport`
//!    has no un-hooked verb to reach for; [`host_run`] adds only the
//!    lifecycle points the trait cannot see (startup, input, output,
//!    shutdown).
//!
//! # What this host declares (§3.2, §13.1)
//!
//! It performs **no model calls**: ADR 0076 §8 keeps the model in the remote
//! runner, on the far side of the tool boundary, and no model client is a
//! dependency of this crate. So it is a tool router in §3.2's sense — it emits
//! `agent_startup`, `input`, `pre_tool_call`/`post_tool_call`, `output` and
//! `agent_shutdown`, never the model points — and it says so to the CTK.
//! `docs/validation/agent-hooks-conformance.md` has the claim.
//!
//! # Labels (§5.4)
//!
//! A permit's `result_labels` are persisted with the run and resurfaced as
//! `extensions.<namespace>.source_labels` on every later emission, so a
//! label-flow policy (`OpenSesame`'s own included) sees provenance across
//! verbs. The `labels` module has the rule and why it is session-sticky.
//!
//! # Value-blind throughout
//!
//! Records are the SDK's payload-free §10.3 projection; a [`Refusal`] carries
//! a verdict's reason, never its message; the run request and report are
//! identifiers and outcomes. The verbs' arguments are URLs, selectors and
//! references — the tool boundary has no value to put there.

mod labels;
mod refusal;
mod run;
mod session;
mod transport;
mod verbs;

pub use refusal::{InputRole, Refusal, ShutdownReason, OUT_OF_ORDER};
pub use run::{
    host_run, run_capture_steps_hooked, run_change_password_hooked, HostInput, HostedRunError,
    Reported, RunKind, RunRequest,
};
pub use session::{HookSession, RecordSink, SessionConfig, FRAMEWORK};
pub use transport::{HookedTransport, BROWSER_VERBS, CEREMONY_VERBS};
