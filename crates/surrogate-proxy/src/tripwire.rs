//! The run lease owns the run's credentials, and a misdirected surrogate
//! revokes them (ADR 0150 §6.2).
//!
//! Every run the registry opens gets a [`ControlLease`] in the agent's hands
//! and a `watched` flag from its [`RunSpec`](crate::RunSpec). Every refusal
//! the proxy reports — invoke-through's and a login form's alike — is read by
//! `opensesame-session-observe`'s [`tripwire_verdict`]: a
//! `surrogate.misdirected` naming a watched run that the agent still drives
//! parks it (or suspends it, inside a critical section), and
//! [`apply_tripwire`] revokes what the run was issued through
//! [`RunRevoker`], the one [`RunCredentials`] this crate has. The listener
//! keeps serving, so every later use of the run's surrogates is refused as
//! `surrogate.revoked` — a tripwire too — rather than vanishing into a closed
//! port. The embedder's [`RunObserver`] hears what happened; it never
//! decides.

use std::sync::Arc;

use opensesame_session_observe::{
    apply_tripwire, tripwire_verdict, ControlLease, RunCredentials, RunNotice, TripwireVerdict,
};

use crate::config::Shared;
use crate::listener::unpoison;

/// Revokes everything a run was issued — its surrogates in the ledger and
/// its armed login declarations — and leaves its listener up, so a late use
/// reads as `surrogate.revoked`.
#[derive(Clone)]
pub struct RunRevoker {
    shared: Arc<Shared>,
}

impl std::fmt::Debug for RunRevoker {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RunRevoker").finish_non_exhaustive()
    }
}

impl RunRevoker {
    pub(crate) fn new(shared: Arc<Shared>) -> Self {
        Self { shared }
    }
}

impl RunCredentials for RunRevoker {
    fn revoke(&self, run_id: &str) -> usize {
        let issued = unpoison(self.shared.ledger.write()).revoke_run(run_id);
        let logins = self
            .shared
            .logins_of(run_id)
            .map_or(0, |logins| logins.revoke());
        issued + logins
    }
}

/// What the tripwire did to one run. Names the run and the fence, never a
/// surrogate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tripped {
    pub run_id: String,
    pub event_type: String,
    pub verdict: TripwireVerdict,
    /// How many live credentials the verdict revoked.
    pub revoked: usize,
}

/// How one declared login went at the proxy.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoginEvent {
    pub run_id: String,
    /// The variable the child received the login surrogate in.
    pub env_var: String,
    pub outcome: LoginOutcome,
}

/// A login's outcome at egress. There is no "retry": a declaration
/// substitutes once (ADR 0150 §6.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoginOutcome {
    /// The declared submission left with the credential in its field.
    Substituted,
    /// Refused under this `surrogate.*` code; the login falls back.
    Refused(&'static str),
}

/// The embedder's ear. Called on the request path with no lock held; an
/// implementation that does I/O should queue.
pub trait RunObserver: Send + Sync {
    fn tripped(&self, tripped: &Tripped);

    fn login(&self, event: &LoginEvent) {
        let _ = event;
    }
}

/// One run's lease, as the tripwire reads and moves it.
#[derive(Debug, Clone, Copy)]
pub(crate) struct RunWatch {
    pub(crate) lease: ControlLease,
    pub(crate) watched: bool,
}

impl RunWatch {
    pub(crate) fn new(watched: bool) -> Self {
        Self {
            lease: ControlLease::new(),
            watched,
        }
    }
}

/// Read one refusal against its run's lease, and carry out the verdict.
pub(crate) fn observe(shared: &Arc<Shared>, event_type: &str, run_id: Option<&str>) {
    let Some(run_id) = run_id else {
        return;
    };
    let mut watches = unpoison(shared.watches.lock());
    let Some(watch) = watches.get_mut(run_id) else {
        return;
    };
    let notice = RunNotice {
        event_type,
        run_id: Some(run_id),
    };
    let verdict = tripwire_verdict(&[notice], run_id, watch.watched, watch.lease);
    let credentials = RunRevoker::new(Arc::clone(shared));
    let Ok(Some(revoked)) = apply_tripwire(verdict, &mut watch.lease, run_id, &credentials) else {
        return;
    };
    drop(watches);
    if let Some(observer) = &shared.config.observer {
        observer.tripped(&Tripped {
            run_id: run_id.to_owned(),
            event_type: event_type.to_owned(),
            verdict,
            revoked,
        });
    }
}

/// Tell the embedder how a login went.
pub(crate) fn login_event(shared: &Shared, event: &LoginEvent) {
    if let Some(observer) = &shared.config.observer {
        observer.login(event);
    }
}
