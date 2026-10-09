//! An Identity-plane `Interaction` as the approval seam's transport to a
//! person (ADR 0086, ADR 0084).
//!
//! [`InteractionApprover`] implements [`HumanApprover`] over the Identity
//! API's `/v1/interactions`:
//!
//! 1. `POST /v1/authorization-requests` raises the subject — an agent action
//!    waiting on the person whose inbox handle (`approverRef`, from their own
//!    `GET /v1/authorization-requests/inbox-ref`) the operator configured;
//! 2. `POST /v1/interactions` fronts it with an `authorization_request`
//!    interaction. The server derives the binding message and computes the
//!    `requestDigest` over the authorization details, so the spec's
//!    `context_identity` rides *inside* the one detail this approver sends,
//!    and the digest covers it (`wire::authorization_detail`). The Identity
//!    API refuses to let a requester ask its own principal, or ask anybody
//!    but the request's addressee, so the person asked is never the caller;
//! 3. the person approves in their interaction inbox with a `WebAuthn`
//!    activation the server binds to that digest (phishing-resistant, as the
//!    kind requires);
//! 4. the approver polls `POST /v1/interactions/{ref}/consume` — the
//!    requester's exactly-once, compare-and-set spend. It answers
//!    `approval_required` until somebody answers, `approval_denied` (403,
//!    final) once a person has refused, and otherwise spends the approval
//!    only after re-checking that the proof is bound to the digest. The spend
//!    happens *before* the approver reports an approval, so one approval can
//!    never lift two emissions.
//!
//! The approver reports what it observed as an [`ApprovalBinding`]; the
//! resolver decides whether it holds. A refusal is reported at once, as a
//! declined [`HumanDecision`] (the resolver's `approval_declined` reject),
//! not as the deadline passing. Before it reports an approval the approver
//! recomputes the interaction's `requestDigest` itself from the fields the
//! server reports it stores ([`digest`]), so a digest over anything but this
//! request is never believed. Every other outcome is an [`ApproverError`],
//! which the resolver answers `unresolved` — a deny.
//!
//! The whole `ask` runs in a task the caller's drop cannot cancel
//! ([`session`]): the host cancelling the emission, or wrapping it in its own
//! timeout, stops the wait but never the cleanup. On every exit without an
//! approval the approver withdraws what it raised — the interaction is
//! revoked and the authorization request it fronted is cancelled, so nothing
//! it raised stays answerable, or stale in the approver's inbox. The deadline
//! is a wall: an attempt in flight when it passes is abandoned, and nothing is
//! reported from it.

pub mod digest;
mod http;
mod session;
pub mod wire;

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use secrecy::SecretString;
use tokio::sync::oneshot;

use crate::approval::{ApprovalPrompt, ApproverError, HumanApprover, HumanDecision};
use http::IdentityClient;
pub use http::{DEFAULT_REQUEST_TIMEOUT, MAX_RESPONSE_BYTES};
use session::Session;

/// The Identity API's floor and ceiling on an interaction's window.
pub const MIN_TTL: Duration = Duration::from_secs(30);
/// See [`MIN_TTL`].
pub const MAX_TTL: Duration = Duration::from_secs(3600);
/// How often the approver asks whether there is an approval to spend.
pub const DEFAULT_POLL_INTERVAL: Duration = Duration::from_secs(2);

/// Why an [`InteractionApprover`] could not be built. Names the field, never
/// its value.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum InteractionConfigError {
    /// The Identity API URL does not parse, or carries credentials, a query
    /// or a fragment.
    #[error("identity_api_url is not a usable URL")]
    InvalidUrl,
    /// The Identity API URL is plain http to a non-loopback host.
    #[error("identity_api_url must be https (loopback http is allowed for tests)")]
    InsecureUrl,
    /// The approver handle is not an `inbox_` handle of a plausible length.
    #[error("approver_ref is not an inbox handle")]
    InvalidApproverRef,
    /// The bearer is empty.
    #[error("bearer is empty")]
    EmptyBearer,
    /// The window is outside the Identity API's 30..=3600 seconds.
    #[error("ttl must be between 30 and 3600 seconds")]
    TtlOutOfRange,
    /// The poll interval or the deadline is zero, or the interval exceeds it.
    #[error("poll_interval and deadline must be non-zero, and the interval within the deadline")]
    InvalidTiming,
    /// The HTTP client could not be built.
    #[error("the Identity API transport could not be built")]
    Transport,
}

/// Everything an [`InteractionApprover`] needs.
#[derive(Debug)]
pub struct InteractionApproverConfig {
    /// The Identity API origin (`https://…`; loopback http for tests).
    pub identity_api_url: String,
    /// The requester's Identity API bearer.
    pub bearer: SecretString,
    /// The approver's inbox handle, shared by its owner.
    pub approver_ref: String,
    /// The interaction's window (30..=3600 seconds, whole seconds).
    pub ttl: Duration,
    /// How often to ask whether there is an approval to spend.
    pub poll_interval: Duration,
    /// How long one `ask` waits in all before answering `TimedOut`.
    pub deadline: Duration,
}

/// Called with an interaction's canonical link once it exists, so a host can
/// show it (the reference authorizes nothing; ADR 0086 §2).
pub type OnPending = Arc<dyn Fn(&str) + Send + Sync>;

/// A [`HumanApprover`] that asks through an Identity-plane `Interaction`.
pub struct InteractionApprover {
    client: Arc<IdentityClient>,
    approver_ref: String,
    ttl_seconds: u64,
    poll_interval: Duration,
    deadline: Duration,
    request_timeout: Duration,
    on_pending: Option<OnPending>,
}

impl std::fmt::Debug for InteractionApprover {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("InteractionApprover")
            .field("client", &self.client)
            .field("ttl_seconds", &self.ttl_seconds)
            .field("poll_interval", &self.poll_interval)
            .field("deadline", &self.deadline)
            .field("request_timeout", &self.request_timeout)
            .finish_non_exhaustive()
    }
}

impl InteractionApprover {
    /// Validate `config` and build the approver.
    ///
    /// # Errors
    ///
    /// [`InteractionConfigError`] naming the first field that is unusable.
    pub fn new(config: InteractionApproverConfig) -> Result<Self, InteractionConfigError> {
        use secrecy::ExposeSecret;
        let base = http::parse_base(&config.identity_api_url)?;
        let handle = &config.approver_ref;
        if !handle.starts_with("inbox_") || handle.len() < 8 || handle.len() > 256 {
            return Err(InteractionConfigError::InvalidApproverRef);
        }
        if config.bearer.expose_secret().is_empty() {
            return Err(InteractionConfigError::EmptyBearer);
        }
        if config.ttl < MIN_TTL || config.ttl > MAX_TTL || config.ttl.subsec_nanos() != 0 {
            return Err(InteractionConfigError::TtlOutOfRange);
        }
        if config.poll_interval.is_zero()
            || config.deadline.is_zero()
            || config.poll_interval > config.deadline
        {
            return Err(InteractionConfigError::InvalidTiming);
        }
        Ok(Self {
            client: Arc::new(IdentityClient::new(base, config.bearer)?),
            approver_ref: config.approver_ref,
            ttl_seconds: config.ttl.as_secs(),
            poll_interval: config.poll_interval,
            deadline: config.deadline,
            request_timeout: DEFAULT_REQUEST_TIMEOUT,
            on_pending: None,
        })
    }

    /// How long one request to the Identity API may take, whole. The default
    /// is [`DEFAULT_REQUEST_TIMEOUT`]; a request that gets no reply in this
    /// time is treated as no reply (a create is retried once, under the same
    /// idempotency key).
    ///
    /// # Errors
    ///
    /// [`InteractionConfigError::InvalidTiming`] for a zero timeout.
    pub fn with_request_timeout(
        mut self,
        timeout: Duration,
    ) -> Result<Self, InteractionConfigError> {
        if timeout.is_zero() {
            return Err(InteractionConfigError::InvalidTiming);
        }
        self.request_timeout = timeout;
        Ok(self)
    }

    /// Call `on_pending` with each interaction's canonical link.
    #[must_use]
    pub fn with_on_pending(mut self, on_pending: OnPending) -> Self {
        self.on_pending = Some(on_pending);
        self
    }
}

#[async_trait]
impl HumanApprover for InteractionApprover {
    async fn ask(&self, prompt: ApprovalPrompt<'_>) -> Result<HumanDecision, ApproverError> {
        let runtime =
            tokio::runtime::Handle::try_current().map_err(|_| ApproverError::Unavailable)?;
        let session = Session {
            client: Arc::clone(&self.client),
            approver_ref: self.approver_ref.clone(),
            ttl_seconds: self.ttl_seconds,
            poll_interval: self.poll_interval,
            deadline: self.deadline,
            request_timeout: self.request_timeout,
            on_pending: self.on_pending.clone(),
            details: vec![wire::authorization_detail(&prompt)],
            binding_message: wire::binding_message(&prompt),
        };
        let (cancel, signal) = oneshot::channel();
        // The ask runs in its own task, so a caller that drops this future
        // (the host cancelled the emission, or wrapped it in its own timeout)
        // cannot cancel it half way through raising something. Dropping this
        // future drops `_cancel_on_drop`, which tells the task to stop
        // waiting; the task then withdraws whatever it had raised and ends.
        let task = runtime.spawn(session.run(signal));
        let _cancel_on_drop = cancel;
        task.await.unwrap_or(Err(ApproverError::Unavailable))
    }
}
