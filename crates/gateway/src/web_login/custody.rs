//! Candidate custody in the driver's vault (ADR 0076 §1 and §3.2).
//!
//! In the local-runner model the party that fills a field is the party that
//! holds the vault: a fill step carries a reference, and the owner's browser
//! resolves it (`ExtensionTransport`). So the candidate is generated, sealed
//! and promoted there too — the Host holds no key that opens the owner's
//! vault, and a candidate it generated would need a route to hand the value
//! across, which is the one thing this design must never grow.
//!
//! [`DriverCandidateVault`] is `CandidateVault` over the same step queue, with
//! three custody steps beside the browser's:
//!
//! | request | settled outcome |
//! |---|---|
//! | `{"step":"generate_candidate","handle":H}` | `{"outcome":"done"}` |
//! | `{"step":"seal_candidate","handle":H}` | `{"outcome":"sealed","backed_up":true}` |
//! | `{"step":"promote_candidate","handle":H}` | `{"outcome":"done"}` |
//!
//! The Host mints the handle, so it is an identifier the Host already knows
//! and never something a driver chose; every outcome is an acknowledgement.
//! None of them has a field able to carry the candidate.
//!
//! The backup wait fails closed: anything but an explicit `sealed` with
//! `backed_up: true` — a failure, a timeout, a malformed answer — is "not
//! acknowledged", and the executor blocks before anything is typed into the
//! site.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use async_trait::async_trait;
use opensesame_rotation_web::{BlockedReason, CandidateHandle, CandidateVault, StepError};
use serde::{Deserialize, Serialize};

use super::channel::RunChannel;

/// The reference a fill of the live password names. The recipe schema's
/// `credential_ref` vocabulary; the driver resolves it for the run's origin.
pub(crate) const CURRENT_PASSWORD_REF: &str = "current_password";

#[derive(Serialize)]
#[serde(rename_all = "snake_case", tag = "step")]
enum CustodyStep<'a> {
    #[serde(rename = "generate_candidate")]
    Generate { handle: &'a str },
    #[serde(rename = "seal_candidate")]
    Seal { handle: &'a str },
    #[serde(rename = "promote_candidate")]
    Promote { handle: &'a str },
}

/// The `step` tags of the three custody requests, which the settle route
/// matches a custody outcome against (it holds the request as JSON).
pub(crate) const GENERATE_STEP: &str = "generate_candidate";
pub(crate) const SEAL_STEP: &str = "seal_candidate";
pub(crate) const PROMOTE_STEP: &str = "promote_candidate";

/// What a custody step settles with. `Serialize` too, so the settle route can
/// store the canonical form of what it decoded rather than what a driver sent.
#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "outcome")]
pub(crate) enum CustodyOutcome {
    Done,
    Sealed { backed_up: bool },
    Failed { error: StepError },
}

/// `CandidateVault` in the owner's vault, driven over the step queue.
pub(crate) struct DriverCandidateVault {
    channel: Arc<RunChannel>,
    promoted: AtomicBool,
}

impl DriverCandidateVault {
    pub(crate) const fn new(channel: Arc<RunChannel>) -> Self {
        Self {
            channel,
            promoted: AtomicBool::new(false),
        }
    }

    /// Whether the vault acknowledged promoting the candidate. The executor's
    /// `promote` cannot fail, so a run that completed without this is one
    /// whose vault may still name the old password live — a reconciliation.
    pub(crate) fn promoted(&self) -> bool {
        self.promoted.load(Ordering::SeqCst)
    }

    async fn custody(&self, step: &CustodyStep<'_>) -> Result<CustodyOutcome, StepError> {
        let request = serde_json::to_value(step).map_err(|_| StepError::Transport)?;
        let outcome = self.channel.dispatch_value(&request).await?;
        serde_json::from_value(outcome).map_err(|_| StepError::Transport)
    }
}

#[async_trait]
impl CandidateVault for DriverCandidateVault {
    async fn generate_candidate(&self) -> Result<CandidateHandle, BlockedReason> {
        let handle = format!("candidate:{}", uuid::Uuid::now_v7());
        match self
            .custody(&CustodyStep::Generate { handle: &handle })
            .await
        {
            Ok(CustodyOutcome::Done) => Ok(CandidateHandle::new(handle)),
            Ok(CustodyOutcome::Failed {
                error: StepError::Challenge,
            })
            | Err(StepError::Challenge) => Err(BlockedReason::Challenge),
            Ok(_) | Err(_) => Err(BlockedReason::Transport),
        }
    }

    async fn seal_and_await_backup(&self, candidate: &CandidateHandle) -> bool {
        matches!(
            self.custody(&CustodyStep::Seal {
                handle: candidate.as_str(),
            })
            .await,
            Ok(CustodyOutcome::Sealed { backed_up: true })
        )
    }

    async fn promote(&self, candidate: &CandidateHandle) {
        let acknowledged = matches!(
            self.custody(&CustodyStep::Promote {
                handle: candidate.as_str(),
            })
            .await,
            Ok(CustodyOutcome::Done)
        );
        self.promoted.store(acknowledged, Ordering::SeqCst);
    }
}
