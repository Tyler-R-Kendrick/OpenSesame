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
//!    and the digest covers it (`wire::authorization_detail`);
//! 3. the person approves in their interaction inbox with a `WebAuthn`
//!    activation the server binds to that digest (phishing-resistant, as the
//!    kind requires);
//! 4. the approver polls `POST /v1/interactions/{ref}/consume` — the
//!    requester's exactly-once, compare-and-set spend. It answers
//!    `approval_required` until there is an approval to spend, and spends it
//!    only after re-checking that the proof is bound to the digest. The spend
//!    happens *before* the approver reports an approval, so one approval can
//!    never lift two emissions.
//!
//! The approver reports what it observed as an [`ApprovalBinding`]; the
//! resolver decides whether it holds. Every other outcome is an
//! [`ApproverError`], which the resolver answers `unresolved` — a deny. In
//! particular, the Identity API answers a *declined* interaction to its
//! requester exactly as an unanswered one (`approval_required`), so a decline
//! surfaces here as the deadline passing: a deny, never an approval.
//!
//! On every exit without an approval — including the host dropping `ask`
//! mid-wait — the approver withdraws its interaction (best effort), so
//! nothing it raised stays answerable. The deadline is a wall: an attempt in
//! flight when it passes is abandoned, and nothing is reported from it.

mod http;
pub mod wire;

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use reqwest::StatusCode;
use secrecy::SecretString;
use serde_json::Value;
use tokio::time::Instant;

use crate::approval::{ApprovalPrompt, ApproverError, HumanApprover, HumanDecision};
pub use http::MAX_RESPONSE_BYTES;
use http::{IdentityClient, Reply};

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
    on_pending: Option<OnPending>,
}

impl std::fmt::Debug for InteractionApprover {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("InteractionApprover")
            .field("client", &self.client)
            .field("ttl_seconds", &self.ttl_seconds)
            .field("poll_interval", &self.poll_interval)
            .field("deadline", &self.deadline)
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
            on_pending: None,
        })
    }

    /// Call `on_pending` with each interaction's canonical link.
    #[must_use]
    pub fn with_on_pending(mut self, on_pending: OnPending) -> Self {
        self.on_pending = Some(on_pending);
        self
    }

    async fn raise(
        &self,
        details: &[Value],
        prompt: &ApprovalPrompt<'_>,
    ) -> Result<wire::Created, ApproverError> {
        let subject = self
            .client
            .post(
                "/v1/authorization-requests",
                Some(&wire::CreateAuthorizationRequest {
                    approver_ref: &self.approver_ref,
                    authorization_details: details,
                    binding_message: wire::binding_message(prompt),
                    ttl_seconds: self.ttl_seconds,
                }),
            )
            .await
            .map_err(|_| ApproverError::Unavailable)?;
        if !matches!(subject.status, StatusCode::OK | StatusCode::CREATED) {
            return Err(ApproverError::Unavailable);
        }
        let subject_id =
            wire::auth_req_id(subject.body.as_ref()).ok_or(ApproverError::Unavailable)?;
        let created = self
            .client
            .post(
                "/v1/interactions",
                Some(&wire::CreateInteraction {
                    kind: wire::INTERACTION_KIND,
                    subject: wire::InteractionSubject {
                        kind: wire::INTERACTION_KIND,
                        subject_id,
                    },
                    approver_ref: &self.approver_ref,
                    authorization_details: details,
                    ttl_seconds: self.ttl_seconds,
                }),
            )
            .await
            .map_err(|_| ApproverError::Unavailable)?;
        if created.status != StatusCode::CREATED {
            return Err(ApproverError::Unavailable);
        }
        wire::created(created.body.as_ref()).ok_or(ApproverError::Unavailable)
    }

    /// Withdraw an interaction, best effort: a failure changes nothing about
    /// the answer already decided (never an approval).
    async fn withdraw(&self, created: &wire::Created) {
        let _ = self.client.post::<Value>(&revoke_path(created), None).await;
    }

    async fn wait_for_spend(
        &self,
        created: &wire::Created,
        details: &[Value],
    ) -> Result<HumanDecision, ApproverError> {
        let path = format!("/v1/interactions/{}/consume", created.reference);
        let give_up = Instant::now() + self.deadline;
        loop {
            // The deadline is a wall, not a hint: an attempt still in flight
            // when it passes is abandoned. If the server spent the approval in
            // that attempt, nobody reports it — a deny, never an approval.
            let remaining = give_up.saturating_duration_since(Instant::now());
            let attempt = self.client.post::<Value>(&path, None);
            let Ok(reply) = tokio::time::timeout(remaining, attempt).await else {
                return Err(ApproverError::TimedOut);
            };
            match classify(reply) {
                Poll::Spent(body) => {
                    return Ok(HumanDecision {
                        approved: true,
                        binding: wire::consumed_binding(body.as_ref(), created, details),
                    })
                }
                Poll::Unbound => {
                    return Ok(HumanDecision {
                        approved: true,
                        binding: wire::refused_binding(created),
                    })
                }
                Poll::Failed(error) => return Err(error),
                Poll::Waiting => {}
            }
            let now = Instant::now();
            if now >= give_up {
                return Err(ApproverError::TimedOut);
            }
            tokio::time::sleep(self.poll_interval.min(give_up - now)).await;
        }
    }
}

fn revoke_path(created: &wire::Created) -> String {
    format!("/v1/interactions/{}/revoke", created.reference)
}

/// Withdraws the interaction if `ask` is dropped before it decides (the host
/// cancelled the emission, or wrapped it in its own timeout), so nothing it
/// raised stays answerable for an action that will never run. The normal
/// exits withdraw inline and disarm it.
///
/// The runtime handle is captured when the guard is armed. `Drop` often runs
/// after the host's timeout has left the task, where `Handle::try_current`
/// is empty, and a revoke that never starts leaves the interaction live.
struct WithdrawOnDrop {
    client: Arc<IdentityClient>,
    path: Option<String>,
    runtime: tokio::runtime::Handle,
}

impl WithdrawOnDrop {
    fn arm(client: &Arc<IdentityClient>, created: &wire::Created) -> Self {
        Self {
            client: Arc::clone(client),
            path: Some(revoke_path(created)),
            runtime: tokio::runtime::Handle::current(),
        }
    }

    fn disarm(&mut self) {
        self.path = None;
    }
}

impl Drop for WithdrawOnDrop {
    fn drop(&mut self) {
        let Some(path) = self.path.take() else {
            return;
        };
        let client = Arc::clone(&self.client);
        self.runtime.spawn(async move {
            let _ = client.post::<Value>(&path, None).await;
        });
    }
}

/// One consume attempt, read.
enum Poll {
    /// Consumed: the body is the server's attestation of the binding.
    Spent(Option<Value>),
    /// Approved, but the server refused to spend it: the proof did not bind.
    Unbound,
    /// Nothing to spend yet (unanswered, or declined).
    Waiting,
    /// No decision will come from this interaction.
    Failed(ApproverError),
}

fn classify(reply: Result<Reply, http::TransportFailed>) -> Poll {
    let Ok(reply) = reply else {
        return Poll::Failed(ApproverError::Unavailable);
    };
    match (reply.status.as_u16(), reply.error_code()) {
        (200, _) => Poll::Spent(reply.body),
        (401, Some("approval_required")) => Poll::Waiting,
        (409, Some("digest_mismatch")) => Poll::Unbound,
        // Spent already. Only this requester can consume, so another emission
        // (or a retry of this one) holds the approval; reporting it here would
        // replay one person's answer. Unresolved, never approve — and not a
        // reject either: nobody refused *this* emission.
        (409, Some("interaction_consumed")) => Poll::Failed(ApproverError::Spent),
        (409, Some("interaction_revoked")) => Poll::Failed(ApproverError::Withdrawn),
        (410, _) => Poll::Failed(ApproverError::TimedOut),
        _ => Poll::Failed(ApproverError::Unavailable),
    }
}

#[async_trait]
impl HumanApprover for InteractionApprover {
    async fn ask(&self, prompt: ApprovalPrompt<'_>) -> Result<HumanDecision, ApproverError> {
        let details = [wire::authorization_detail(&prompt)];
        let created = self.raise(&details, &prompt).await?;
        let mut guard = WithdrawOnDrop::arm(&self.client, &created);
        if let Some(on_pending) = &self.on_pending {
            if http::parse_base(&created.url).is_ok() {
                on_pending(&created.url);
            }
        }
        let decision = self.wait_for_spend(&created, &details).await;
        let spent = decision
            .as_ref()
            .is_ok_and(|d| d.binding.bound_digest.is_some());
        if !spent {
            self.withdraw(&created).await;
        }
        guard.disarm();
        decision
    }
}
