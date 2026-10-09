//! Autonomous renewal of host-managed transport certificates (LIFE-RENEWAL).
//!
//! The trigger is the ADR 0074 lifecycle feed and nothing else: the scanner
//! publishes `lifecycle.renewal.due` for a certificate subject, the
//! dispatcher claims the rung, and the certificate responder calls
//! [`respond`] here. There is no private due-check. What this module adds on
//! top of `managed_certs::renew_managed` is the part a background actor
//! needs that a route does not:
//!
//! - a per-certificate **lease**, so two scanner passes (or two processes
//!   sharing the feed) never double-issue;
//! - **bounded retry with jitter** after a failure — base 30 s, cap 15 min,
//!   eight attempts — driven by [`tick`], since a claimed rung never
//!   re-fires; the ninth failure **parks** the certificate and publishes a
//!   `SecurityNotice`, because a renewal that silently stopped is the ADR
//!   0052 §11 failure;
//! - a bounded queue, so rapid updates or a flood of failing subjects can
//!   never grow the task count without limit (AT-ROTATE-WINDOW);
//! - the **skip** for Workload-API-sourced identities: a SPIFFE source
//!   owns its snapshots and this host must not run a competing issuer;
//! - activation after a successful issue, reported separately from the
//!   issue itself (renewal success ≠ installation success).
//!
//! The renewal *lead* is not touched: `converging_renew_before` clamps it to
//! half the lifetime so a successor is never immediately due again.

use std::collections::{BTreeMap, BTreeSet};
use std::time::Duration;

use chrono::{DateTime, Utc};
use opensesame_domain::OrganizationId;
use opensesame_lifecycle::LifecycleEvent;
use opensesame_security_events::{NoticeState, SecurityNotice, Severity};
use opensesame_storage::StoredManagedCertificate;

use crate::app_state::AppState;
use crate::lifecycle::responders::Outcome;
use crate::managed_certs::{self, CustodyError};
use crate::managed_certs_tls::{is_spiffe_sourced, recorded_purpose, TransportPurpose};
use crate::transport_lifecycle::{activation, pem_reload, trust};

/// First retry delay after a failure; doubles per attempt.
pub const RETRY_BASE_SECONDS: i64 = 30;
/// Longest retry delay.
pub const RETRY_CAP_SECONDS: i64 = 15 * 60;
/// Failures before a certificate parks for operator attention.
pub const MAX_ATTEMPTS: u32 = 8;
/// Most certificates the retry queue tracks at once.
pub const MAX_QUEUE: usize = 64;
/// How often [`run`] wakes to retry and reconcile.
pub const TICK_SECONDS: u64 = 30;
/// The notice published when a certificate parks.
pub const EVENT_PARKED: &str = "transport.renewal.parked";

/// One certificate awaiting a retry.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Retry {
    pub organization_id: String,
    pub certificate_id: String,
    pub attempts: u32,
    pub next_attempt_at: DateTime<Utc>,
    pub parked: bool,
    /// The last failure's stable code.
    pub last_code: String,
}

/// Why a claim did not go through.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Claim {
    Claimed,
    InFlight,
    BackingOff,
    Parked,
}

fn key(organization_id: &str, certificate_id: &str) -> String {
    format!("{organization_id}\u{0}{certificate_id}")
}

/// The in-process lease and retry queue.
#[derive(Debug, Default)]
pub struct Scheduler {
    retries: BTreeMap<String, Retry>,
    in_flight: BTreeSet<String>,
    /// Failures refused because the queue was full.
    pub overflowed: u64,
}

/// The delay before attempt `attempt` (1-based) is retried, jittered by
/// `jitter` in `[0, 1)` to between half and all of the exponential step.
#[must_use]
pub fn backoff_seconds(attempt: u32, jitter: f64) -> i64 {
    let shift = attempt.saturating_sub(1).min(20);
    let step = RETRY_BASE_SECONDS
        .saturating_mul(1i64 << shift)
        .min(RETRY_CAP_SECONDS);
    let jitter = jitter.clamp(0.0, 1.0);
    // Truncation is the point: a whole number of seconds inside [step/2, step].
    #[allow(clippy::cast_possible_truncation, clippy::cast_precision_loss)]
    let shaved = ((step as f64) * 0.5 * jitter) as i64;
    (step - shaved).max(RETRY_BASE_SECONDS / 2)
}

impl Scheduler {
    /// Take the lease for one certificate, or say why not.
    pub fn claim(
        &mut self,
        organization_id: &str,
        certificate_id: &str,
        now: DateTime<Utc>,
    ) -> Claim {
        let key = key(organization_id, certificate_id);
        if self.in_flight.contains(&key) {
            return Claim::InFlight;
        }
        if let Some(retry) = self.retries.get(&key) {
            if retry.parked {
                return Claim::Parked;
            }
            if now < retry.next_attempt_at {
                return Claim::BackingOff;
            }
        }
        self.in_flight.insert(key);
        Claim::Claimed
    }

    /// Release after success: the retry entry (if any) is dropped.
    pub fn release_success(&mut self, organization_id: &str, certificate_id: &str) {
        let key = key(organization_id, certificate_id);
        self.in_flight.remove(&key);
        self.retries.remove(&key);
    }

    /// Release after failure: schedule the next attempt with `jitter`, or
    /// park after [`MAX_ATTEMPTS`]. Returns the updated entry, or `None`
    /// when the queue is full and the certificate is not already tracked.
    pub fn release_failure(
        &mut self,
        organization_id: &str,
        certificate_id: &str,
        code: &str,
        now: DateTime<Utc>,
        jitter: f64,
    ) -> Option<Retry> {
        let key = key(organization_id, certificate_id);
        self.in_flight.remove(&key);
        if !self.retries.contains_key(&key) && self.retries.len() >= MAX_QUEUE {
            self.overflowed = self.overflowed.saturating_add(1);
            return None;
        }
        let entry = self.retries.entry(key).or_insert_with(|| Retry {
            organization_id: organization_id.to_owned(),
            certificate_id: certificate_id.to_owned(),
            attempts: 0,
            next_attempt_at: now,
            parked: false,
            last_code: String::new(),
        });
        entry.attempts = entry.attempts.saturating_add(1);
        code.clone_into(&mut entry.last_code);
        if entry.attempts >= MAX_ATTEMPTS {
            entry.parked = true;
        } else {
            entry.next_attempt_at =
                now + chrono::Duration::seconds(backoff_seconds(entry.attempts, jitter));
        }
        Some(entry.clone())
    }

    /// Entries whose retry is due at `now` (not parked, not in flight).
    #[must_use]
    pub fn due(&self, now: DateTime<Utc>) -> Vec<Retry> {
        self.retries
            .iter()
            .filter(|(key, retry)| {
                !retry.parked && now >= retry.next_attempt_at && !self.in_flight.contains(*key)
            })
            .map(|(_, retry)| retry.clone())
            .collect()
    }

    /// Every tracked retry, backing off or parked.
    pub fn entries(&self) -> impl Iterator<Item = &Retry> {
        self.retries.values()
    }

    /// Forget a certificate (revoked, deleted).
    pub fn forget(&mut self, organization_id: &str, certificate_id: &str) {
        let key = key(organization_id, certificate_id);
        self.retries.remove(&key);
        self.in_flight.remove(&key);
    }
}

fn jitter() -> f64 {
    rand::random::<f64>()
}

/// The certificate responder: renew one managed certificate under the
/// lease, activate what was issued, and schedule a retry on failure.
pub async fn respond(state: &AppState, event: &LifecycleEvent) -> Outcome {
    let Ok(organization) = OrganizationId::parse(&event.subject.organization_id) else {
        return Outcome::failed("subject carries a non-canonical organization id");
    };
    renew_one(state, &organization, &event.subject.subject_id).await
}

/// Renew `certificate_id` for `organization` under the scheduler's lease.
pub async fn renew_one(
    state: &AppState,
    organization: &OrganizationId,
    certificate_id: &str,
) -> Outcome {
    let tenant = organization.to_string();
    let now = Utc::now();
    let row = match state.db.get_certificate(&tenant, certificate_id).await {
        Ok(Some(row)) => row,
        Ok(None) => return Outcome::failed(format!("not_found: certificate {certificate_id}")),
        Err(error) => return Outcome::failed(format!("internal: {error}")),
    };
    if is_spiffe_sourced(&row) {
        // A SPIFFE identity rotates through its Workload API stream; issuing
        // a competing leaf here would be a second authority.
        return Outcome::ok(format!(
            "skipped {certificate_id}: identity is delivered by a workload api source",
        ));
    }
    let claim = state
        .transport_lifecycle
        .with_scheduler(|s| s.claim(&tenant, certificate_id, now));
    match claim {
        Claim::Claimed => {}
        Claim::InFlight => return Outcome::ok(format!("skipped {certificate_id}: renewal in flight")),
        Claim::BackingOff => {
            return Outcome::ok(format!("skipped {certificate_id}: backing off after a failure"))
        }
        Claim::Parked => {
            return Outcome::failed(format!(
                "parked {certificate_id}: {MAX_ATTEMPTS} consecutive failures; operator attention required",
            ))
        }
    }
    match managed_certs::renew_managed(state, organization, certificate_id).await {
        Ok(renewed) => {
            state
                .transport_lifecycle
                .with_scheduler(|s| s.release_success(&tenant, certificate_id));
            state.transport_lifecycle.invalidate(certificate_id);
            let installed = install(state, &row, &renewed).await;
            Outcome::ok(format!(
                "reissued as {} valid until {}{installed}",
                renewed.id, renewed.expires_at
            ))
        }
        Err(error) => on_failure(state, &tenant, certificate_id, &error).await,
    }
}

/// Activate the successor everywhere its predecessor was serving, and say
/// so in the outcome — separately from the reissue, which already happened.
async fn install(
    state: &AppState,
    previous: &StoredManagedCertificate,
    renewed: &StoredManagedCertificate,
) -> String {
    let targets = state.transport_lifecycle.targets_for(&previous.id);
    if targets.is_empty() {
        return String::new();
    }
    let purpose = recorded_purpose(previous).unwrap_or(TransportPurpose::Listener);
    let mut notes = Vec::new();
    for target in targets {
        match activation::activate_managed(state, &target, &renewed.id, purpose, None).await {
            Ok(generation) => notes.push(format!("{target}: loaded as generation {generation}")),
            Err(error) => notes.push(format!(
                "{target}: NOT loaded ({}); previous generation keeps serving",
                error.code()
            )),
        }
    }
    format!("; activation: {}", notes.join(", "))
}

async fn on_failure(
    state: &AppState,
    tenant: &str,
    certificate_id: &str,
    error: &CustodyError,
) -> Outcome {
    let now = Utc::now();
    let scheduled = state
        .transport_lifecycle
        .with_scheduler(|s| s.release_failure(tenant, certificate_id, error.code(), now, jitter()));
    match scheduled {
        Some(retry) if retry.parked => {
            publish_parked(state, tenant, certificate_id, &retry, now).await;
            Outcome::failed(format!(
                "{}: {error}; parked after {} attempts",
                error.code(),
                retry.attempts
            ))
        }
        Some(retry) => Outcome::failed(format!(
            "{}: {error}; retry {} at {}",
            error.code(),
            retry.attempts,
            retry.next_attempt_at.to_rfc3339()
        )),
        None => Outcome::failed(format!(
            "{}: {error}; retry queue full ({MAX_QUEUE}), not scheduled",
            error.code()
        )),
    }
}

async fn publish_parked(
    state: &AppState,
    tenant: &str,
    certificate_id: &str,
    retry: &Retry,
    now: DateTime<Utc>,
) {
    let notice = SecurityNotice {
        event_type: EVENT_PARKED.into(),
        severity: Severity::Critical,
        state: NoticeState::Firing,
        organization_id: tenant.to_owned(),
        subject_kind: "certificate".into(),
        subject_id: certificate_id.to_owned(),
        label: None,
        occurred_at: now,
        summary: format!(
            "transport certificate {certificate_id} could not be renewed after {} attempts; renewal is parked",
            retry.attempts
        ),
        detail: Some(retry.last_code.clone()),
        payload: serde_json::json!({
            "attempts": retry.attempts,
            "last_code": retry.last_code,
            "secrets_returned": false,
        }),
    };
    crate::security::dispatch::publish(state, &notice, now).await;
}

/// One retry pass: every due entry is attempted once. Returns how many ran.
pub async fn tick(state: &AppState, now: DateTime<Utc>) -> usize {
    let due = state.transport_lifecycle.with_scheduler(|s| s.due(now));
    let mut ran = 0usize;
    for retry in due {
        let Ok(organization) = OrganizationId::parse(&retry.organization_id) else {
            continue;
        };
        let outcome = renew_one(state, &organization, &retry.certificate_id).await;
        ran += 1;
        if outcome.succeeded {
            tracing::info!(certificate_id = %retry.certificate_id, detail = %outcome.detail, "transport renewal retry succeeded");
        } else {
            tracing::warn!(certificate_id = %retry.certificate_id, detail = %outcome.detail, "transport renewal retry failed");
        }
    }
    ran
}

/// Process-lifetime loop: retries due renewals, picks up an externally
/// renewed `pem` listener pair, and reconciles trust overlap windows every
/// [`TICK_SECONDS`]. Spawned from `main` beside the scanner.
pub async fn run(state: AppState) {
    let mut interval = tokio::time::interval(Duration::from_secs(TICK_SECONDS));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut pem_watch = pem_reload::Watch::new();
    loop {
        interval.tick().await;
        let now = Utc::now();
        let ran = tick(&state, now).await;
        if ran > 0 {
            tracing::info!(ran, "transport renewal retries ran");
        }
        pem_reload::pass_and_log(&state, &mut pem_watch).await;
        if let Err(error) = trust::reconcile(&state, now).await {
            tracing::warn!(code = error.code(), "trust overlap reconcile failed");
        }
    }
}
