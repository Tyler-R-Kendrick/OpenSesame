//! The executor's half of the step channel, over the step queue
//! (`runner_steps`, ADR 0079 §4 / ADR 0081).
//!
//! One dispatch is: flush the hook records that precede it, enqueue the
//! request at the run's next position, and wait — bounded — for the owner's
//! browser to claim and settle it through `POST /api/v1/agent/runs/{id}/steps/
//! claim` and `…/steps/{seq}/outcome`. The settle route stores the driver's
//! `outcome` object verbatim; that object is exactly the tagged
//! [`StepOutcome`] `ExtensionTransport` decodes, so the two halves agree by
//! sharing one type rather than by convention.
//!
//! Every failure is [`StepError::Transport`]: a queue that refuses, a step
//! nobody settles in time, a run past its deadline, an outcome that is not
//! JSON, a record that cannot be written. The executor parks on it — before
//! the submit that is a clean block, after it a reconciliation — and never
//! assumes a step landed.
//!
//! What a driver settled is read once and then **narrowed in place**: the
//! queue row is rewritten with every credential-shaped string redacted, so a
//! driver that sent one does not leave it in the database for the life of the
//! run. The value itself continues to the hosted transport, whose
//! `post_tool_call` emission is where the organization's secret guard decides
//! what the executor may read.

use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::Arc;
use std::time::Instant;

use async_trait::async_trait;
use chrono::Utc;
use opensesame_agent_hooks::secrets;
use opensesame_rotation_web::{StepChannel, StepError, StepOutcome, StepRequest};
use opensesame_storage::Db;
use serde_json::Value;

use super::control::{ControlGate, Stop};
use super::records::RecordBuffer;
use super::RunTiming;

/// One run's step queue, as the executor sees it.
pub(crate) struct RunChannel {
    db: Db,
    organization_id: String,
    run_id: String,
    next_seq: AtomicI64,
    timing: RunTiming,
    run_deadline: Instant,
    records: Arc<RecordBuffer>,
    /// The persisted control state, consulted around every dispatch.
    gate: ControlGate,
    /// Whether a submit was ever handed to the driver. What a run that stops
    /// for any reason can truthfully say about the site.
    submit_sent: AtomicBool,
}

impl RunChannel {
    pub(crate) fn new(
        db: Db,
        organization_id: String,
        run_id: String,
        timing: RunTiming,
        records: Arc<RecordBuffer>,
    ) -> Self {
        Self {
            gate: ControlGate::new(db.clone(), organization_id.clone(), run_id.clone()),
            db,
            organization_id,
            run_id,
            next_seq: AtomicI64::new(0),
            submit_sent: AtomicBool::new(false),
            timing,
            run_deadline: Instant::now() + timing.run_deadline,
            records,
        }
    }

    /// Flush the hook records a caller is about to act after.
    ///
    /// # Errors
    ///
    /// A record could not be written, now or earlier.
    pub(crate) async fn flush_records(&self) -> anyhow::Result<()> {
        self.records.flush(&self.db).await
    }

    /// Why the run stopped for a reason that is a person's, not its own — it
    /// parked at a handoff, or found the page already held.
    pub(crate) fn stopped(&self) -> Option<Stop> {
        self.gate.stopped()
    }

    /// Whether a submit was ever handed to the driver.
    pub(crate) fn submit_sent(&self) -> bool {
        self.submit_sent.load(Ordering::SeqCst)
    }

    /// Hand one request to the driver and wait for what it settled.
    ///
    /// The persisted control state is consulted first: a run whose page a
    /// person asked for parks here, at a safe point, and a run whose page a
    /// person holds sends nothing — in both cases the step is never enqueued.
    pub(crate) async fn dispatch_value(&self, request: &Value) -> Result<Value, StepError> {
        if let Err(error) = self.flush_records().await {
            tracing::error!(%error, run_id = %self.run_id, "hook records could not be written; the run stops");
            return Err(StepError::Transport);
        }
        if Instant::now() >= self.run_deadline {
            return Err(StepError::Transport);
        }
        self.gate.before(request).await?;
        if request["step"] == super::control::SUBMIT_STEP {
            self.submit_sent.store(true, Ordering::SeqCst);
        }
        let settled = self.exchange(request).await;
        self.gate.after(request, &settled).await;
        settled
    }

    /// Enqueue `request` at the run's next position and wait for its outcome.
    async fn exchange(&self, request: &Value) -> Result<Value, StepError> {
        let seq = self.next_seq.fetch_add(1, Ordering::SeqCst);
        let enqueued = self
            .db
            .enqueue_runner_step(
                &self.organization_id,
                &self.run_id,
                seq,
                &request.to_string(),
                &Utc::now().to_rfc3339(),
            )
            .await;
        if let Err(error) = enqueued {
            tracing::warn!(%error, run_id = %self.run_id, seq, "runner step could not be enqueued");
            return Err(StepError::Transport);
        }
        let settled = self.await_settlement(seq).await?;
        self.accept(seq, &settled).await
    }

    async fn await_settlement(&self, seq: i64) -> Result<String, StepError> {
        let deadline = (Instant::now() + self.timing.step_deadline).min(self.run_deadline);
        loop {
            let step = self
                .db
                .get_runner_step(&self.organization_id, &self.run_id, seq)
                .await
                .map_err(|_| StepError::Transport)?
                .ok_or(StepError::Transport)?;
            if step.state == "settled" {
                return step.outcome_json.ok_or(StepError::Transport);
            }
            let now = Instant::now();
            if now >= deadline {
                tracing::warn!(run_id = %self.run_id, seq, "runner step was not settled in time");
                return Err(StepError::Transport);
            }
            tokio::time::sleep(self.timing.poll.min(deadline - now)).await;
        }
    }

    /// Read a settled outcome, and narrow its queue row.
    async fn accept(&self, seq: i64, settled: &str) -> Result<Value, StepError> {
        let outcome: Value = serde_json::from_str(settled).map_err(|_| StepError::Transport)?;
        // A row that cannot be narrowed keeps what it should not; the run
        // stops rather than build on it.
        if !self.narrow(seq, &outcome).await {
            return Err(StepError::Transport);
        }
        Ok(outcome)
    }

    /// Rewrite step `seq`'s stored outcome with credential-shaped text
    /// redacted. `true` when the row is clean now (it may have been already).
    async fn narrow(&self, seq: i64, outcome: &Value) -> bool {
        let (narrowed, findings) = secrets::redact(outcome);
        if findings.is_empty() {
            return true;
        }
        tracing::warn!(
            run_id = %self.run_id,
            seq,
            found = %findings.summary(),
            "a driver settled credential-shaped text; the queue row is redacted",
        );
        matches!(
            self.db
                .replace_settled_runner_step_outcome(
                    &self.organization_id,
                    &self.run_id,
                    seq,
                    &narrowed.to_string(),
                )
                .await,
            Ok(true)
        )
    }

    /// Narrow every settled row of a run that has closed: a step the executor
    /// stopped waiting for may have been settled before the close landed, and
    /// that outcome was never read — so never narrowed — on the way in. Once
    /// the run is closed no further settle is stored.
    pub(crate) async fn narrow_settled(&self) {
        for seq in 0..self.next_seq.load(Ordering::SeqCst) {
            let Ok(Some(step)) = self
                .db
                .get_runner_step(&self.organization_id, &self.run_id, seq)
                .await
            else {
                continue;
            };
            let Some(outcome) = step
                .outcome_json
                .as_deref()
                .and_then(|text| serde_json::from_str::<Value>(text).ok())
            else {
                continue;
            };
            if !self.narrow(seq, &outcome).await {
                tracing::error!(run_id = %self.run_id, seq, "a settled step could not be narrowed");
            }
        }
    }
}

/// The browser's steps, typed, over a [`RunChannel`].
pub(crate) struct BrowserChannel(pub(crate) Arc<RunChannel>);

#[async_trait]
impl StepChannel for BrowserChannel {
    async fn dispatch(&self, request: StepRequest) -> Result<StepOutcome, StepError> {
        let request = serde_json::to_value(&request).map_err(|_| StepError::Transport)?;
        let outcome = self.0.dispatch_value(&request).await?;
        // Anything but a well-formed outcome is a protocol violation, not a
        // value to coerce into a step result.
        serde_json::from_value(outcome).map_err(|_| StepError::Transport)
    }
}
