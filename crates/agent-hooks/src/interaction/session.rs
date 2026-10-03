//! One `ask`, run to its end in a task its caller cannot cancel.
//!
//! [`Session::run`] is spawned by `InteractionApprover::ask`. Everything that
//! raises something on the Identity API happens inside it, so a caller that
//! drops the `ask` future — the host cancelled the emission, or wrapped it in
//! its own timeout — cannot leave it half done: the future being dropped
//! resolves the task's `cancel` receiver, the task stops waiting at its next
//! checkpoint (or straight away, if it is waiting), withdraws whatever it had
//! raised so far, and ends. A create that is in flight is never abandoned
//! mid-request — each request is bounded by its own timeout, and abandoning
//! one after the server had acted on it is how an interaction nobody holds a
//! reference to comes to exist — so the task is bounded by the deadline for
//! the wait and by the request timeout for each call it makes around it.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use reqwest::StatusCode;
use serde_json::Value;
use tokio::sync::oneshot;
use tokio::sync::oneshot::error::TryRecvError;
use tokio::time::Instant;

use super::digest::{self, Basis};
use super::http::{Call, IdentityClient, Reply, TransportFailed};
use super::wire;
use super::OnPending;
use crate::approval::{ApprovalBinding, ApproverError, HumanDecision};

/// What an `ask` has raised on the Identity API so far: exactly what has to
/// be withdrawn if it ends without an approval.
#[derive(Default)]
struct Raised {
    subject_id: Option<String>,
    created: Option<wire::Created>,
}

/// One consume attempt, read.
enum Poll {
    /// Consumed: the body is the server's attestation of the binding.
    Spent(Option<Value>),
    /// Approved, but the server refused to spend it: the proof did not bind.
    Unbound,
    /// A person refused. Final.
    Declined,
    /// Nothing to spend yet: nobody has answered.
    Waiting,
    /// No decision will come from this interaction.
    Failed(ApproverError),
}

/// Everything one `ask` needs, owned, so it can outlive its caller.
pub struct Session {
    pub client: Arc<IdentityClient>,
    pub approver_ref: String,
    pub ttl_seconds: u64,
    pub poll_interval: Duration,
    pub deadline: Duration,
    pub request_timeout: Duration,
    pub on_pending: Option<OnPending>,
    pub details: Vec<Value>,
    pub binding_message: &'static str,
}

/// A key no other `ask` shares, so a retried create is the same create and a
/// second `ask` is never mistaken for it.
fn ask_id() -> String {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_nanos());
    format!(
        "hooks-{:x}-{nanos:x}-{:x}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )
}

fn revoke_path(created: &wire::Created) -> String {
    format!("/v1/interactions/{}/revoke", created.reference)
}

fn cancel_path(subject_id: &str) -> String {
    format!("/v1/authorization-requests/{subject_id}/cancel")
}

/// Stop if the caller is gone or the deadline has passed.
fn checkpoint(cancel: &mut oneshot::Receiver<()>, give_up: Instant) -> Result<(), ApproverError> {
    match cancel.try_recv() {
        Err(TryRecvError::Empty) => {}
        Ok(()) | Err(TryRecvError::Closed) => return Err(ApproverError::Withdrawn),
    }
    if Instant::now() >= give_up {
        return Err(ApproverError::TimedOut);
    }
    Ok(())
}

fn classify(reply: Result<Reply, TransportFailed>) -> Poll {
    let Ok(reply) = reply else {
        return Poll::Failed(ApproverError::Unavailable);
    };
    match (reply.status.as_u16(), reply.error_code()) {
        (200, _) => Poll::Spent(reply.body),
        (401, Some("approval_required")) => Poll::Waiting,
        (403, Some("approval_denied")) => Poll::Declined,
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

impl Session {
    fn call<'a>(&self, key: Option<&'a str>) -> Call<'a> {
        Call {
            key,
            timeout: self.request_timeout,
        }
    }

    /// Run the ask to its end. Whatever the outcome, if it is not an approval
    /// that was spent, what was raised is withdrawn before this returns.
    pub async fn run(
        self,
        mut cancel: oneshot::Receiver<()>,
    ) -> Result<HumanDecision, ApproverError> {
        let give_up = Instant::now() + self.deadline;
        let mut raised = Raised::default();
        let outcome = self.drive(&mut cancel, give_up, &mut raised).await;
        let spent = outcome
            .as_ref()
            .is_ok_and(|decision| decision.approved && decision.binding.bound_digest.is_some());
        if !spent {
            self.withdraw(&raised).await;
        }
        outcome
    }

    async fn drive(
        &self,
        cancel: &mut oneshot::Receiver<()>,
        give_up: Instant,
        raised: &mut Raised,
    ) -> Result<HumanDecision, ApproverError> {
        let id = ask_id();
        let subject_id = self.raise_subject(&format!("{id}-subject")).await?;
        let subject_id = raised.subject_id.insert(subject_id).clone();
        checkpoint(cancel, give_up)?;
        let created = self
            .raise_interaction(&format!("{id}-interaction"), &subject_id)
            .await?;
        let created = raised.created.insert(created).clone();
        checkpoint(cancel, give_up)?;
        self.announce(&created);
        self.wait_for_spend(cancel, give_up, &created, &subject_id)
            .await
    }

    async fn raise_subject(&self, key: &str) -> Result<String, ApproverError> {
        let body = wire::CreateAuthorizationRequest {
            approver_ref: &self.approver_ref,
            authorization_details: &self.details,
            binding_message: self.binding_message,
            ttl_seconds: self.ttl_seconds,
        };
        let reply = self
            .client
            .post(
                "/v1/authorization-requests",
                Some(&body),
                self.call(Some(key)),
            )
            .await
            .map_err(|_| ApproverError::Unavailable)?;
        if !matches!(reply.status, StatusCode::OK | StatusCode::CREATED) {
            return Err(ApproverError::Unavailable);
        }
        wire::auth_req_id(reply.body.as_ref())
            .map(str::to_owned)
            .ok_or(ApproverError::Unavailable)
    }

    async fn raise_interaction(
        &self,
        key: &str,
        subject_id: &str,
    ) -> Result<wire::Created, ApproverError> {
        let body = wire::CreateInteraction {
            kind: wire::INTERACTION_KIND,
            subject: wire::InteractionSubject {
                kind: wire::INTERACTION_KIND,
                subject_id,
            },
            approver_ref: &self.approver_ref,
            authorization_details: &self.details,
            ttl_seconds: self.ttl_seconds,
        };
        let reply = self
            .client
            .post("/v1/interactions", Some(&body), self.call(Some(key)))
            .await
            .map_err(|_| ApproverError::Unavailable)?;
        if reply.status != StatusCode::CREATED {
            return Err(ApproverError::Unavailable);
        }
        wire::created(reply.body.as_ref()).ok_or(ApproverError::Unavailable)
    }

    /// Hand the link to the host, when it is one worth handing over.
    fn announce(&self, created: &wire::Created) {
        if let Some(on_pending) = &self.on_pending {
            if super::http::parse_base(&created.url).is_ok() {
                on_pending(&created.url);
            }
        }
    }

    /// Withdraw what was raised, best effort: a failure changes nothing about
    /// the answer already decided (never an approval). The interaction goes
    /// first; cancelling the authorization request it fronted then clears the
    /// approver's inbox — and, when the interaction's reference never reached
    /// us, closes the interaction by way of its subject.
    async fn withdraw(&self, raised: &Raised) {
        if let Some(created) = &raised.created {
            let _ = self
                .client
                .post::<Value>(&revoke_path(created), None, self.call(None))
                .await;
        }
        if let Some(subject_id) = &raised.subject_id {
            let _ = self
                .client
                .post::<Value>(&cancel_path(subject_id), None, self.call(None))
                .await;
        }
    }

    async fn wait_for_spend(
        &self,
        cancel: &mut oneshot::Receiver<()>,
        give_up: Instant,
        created: &wire::Created,
        subject_id: &str,
    ) -> Result<HumanDecision, ApproverError> {
        let path = format!("/v1/interactions/{}/consume", created.reference);
        loop {
            // The deadline is a wall, not a hint: an attempt still in flight
            // when it passes is abandoned. If the server spent the approval in
            // that attempt, nobody reports it — a deny, never an approval.
            let remaining = give_up.saturating_duration_since(Instant::now());
            let attempt = self.client.post::<Value>(&path, None, self.call(None));
            let reply = tokio::select! {
                biased;
                _ = &mut *cancel => return Err(ApproverError::Withdrawn),
                timed = tokio::time::timeout(remaining, attempt) => match timed {
                    Ok(reply) => reply,
                    Err(_) => return Err(ApproverError::TimedOut),
                },
            };
            if let Some(decided) = self.decide(classify(reply), created, subject_id) {
                return decided;
            }
            let now = Instant::now();
            if now >= give_up {
                return Err(ApproverError::TimedOut);
            }
            let nap = tokio::time::sleep(self.poll_interval.min(give_up - now));
            tokio::select! {
                biased;
                _ = &mut *cancel => return Err(ApproverError::Withdrawn),
                () = nap => {}
            }
        }
    }

    /// What one poll decides, if it decides anything.
    fn decide(
        &self,
        poll: Poll,
        created: &wire::Created,
        subject_id: &str,
    ) -> Option<Result<HumanDecision, ApproverError>> {
        let decision = match poll {
            Poll::Spent(body) => HumanDecision {
                approved: true,
                binding: self.spent_binding(body.as_ref(), created, subject_id),
            },
            Poll::Unbound => HumanDecision {
                approved: true,
                binding: wire::refused_binding(created),
            },
            Poll::Declined => HumanDecision {
                approved: false,
                binding: wire::declined_binding(created, &self.details),
            },
            Poll::Failed(error) => return Some(Err(error)),
            Poll::Waiting => return None,
        };
        Some(Ok(decision))
    }

    /// The binding a consumed interaction attests to — provided that, by this
    /// approver's own recomputation, the digest the proof is bound to is the
    /// digest of the request it sent. A server that reports a digest over
    /// anything else is not believed: nothing is bound.
    fn spent_binding(
        &self,
        body: Option<&Value>,
        created: &wire::Created,
        subject_id: &str,
    ) -> ApprovalBinding {
        let binding = wire::consumed_binding(body, created, &self.details);
        let basis = Basis {
            approver_ref: &self.approver_ref,
            subject_id,
        };
        let verified = body
            .is_some_and(|body| digest::consumed_hashes_to(body, &basis, &created.request_digest));
        if binding.bound_digest.is_some() && !verified {
            return wire::refused_binding(created);
        }
        binding
    }
}
