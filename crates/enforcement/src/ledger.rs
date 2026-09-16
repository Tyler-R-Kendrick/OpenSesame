//! The per-grant ledger of desired and observed effect, one entry per
//! dimension the grant demanded.
//!
//! Opened by [`crate::preflight::Admitted::open_ledger`], so a ledger only
//! exists for a grant whose demands the platform said it could carry. Every
//! entry opens unobserved: admission is a statement about capability, and this
//! is where the deployment finds out whether the capability was exercised.

use crate::dimension::Dimension;
use crate::effect::{Desired, Divergence, Effect, Reconciliation, Report, ReportRefused};
use crate::guarantee::Guarantee;
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Asked about a dimension this grant never demanded.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Error, Serialize, Deserialize)]
#[error("this grant demanded nothing on {dimension:?}")]
pub struct DimensionNotTracked {
    /// The axis asked about.
    pub dimension: Dimension,
}

/// One grant's effect states.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EffectLedger {
    entries: Vec<Effect>,
}

impl EffectLedger {
    /// Open a ledger from the guarantees a grant was admitted against.
    #[must_use]
    pub fn opening(held: &[(Dimension, Guarantee)]) -> Self {
        Self::opening_at(held, 0)
    }

    /// Open a ledger with an explicit clock reading, in seconds on whatever
    /// monotonic scale the caller reconciles against.
    #[must_use]
    pub fn opening_at(held: &[(Dimension, Guarantee)], now_seconds: u64) -> Self {
        Self {
            entries: held
                .iter()
                .map(|(dimension, guarantee)| Effect::opening(*dimension, *guarantee, now_seconds))
                .collect(),
        }
    }

    /// Every entry, in the order the grant was admitted in.
    #[must_use]
    pub fn entries(&self) -> &[Effect] {
        &self.entries
    }

    /// One dimension's entry.
    #[must_use]
    pub fn effect(&self, dimension: Dimension) -> Option<&Effect> {
        self.entries
            .iter()
            .find(|effect| effect.dimension() == dimension)
    }

    /// State what authority now wants of one dimension.
    ///
    /// # Errors
    ///
    /// [`DimensionNotTracked`] when the grant demanded nothing on that axis —
    /// a deployment cannot revoke a constraint it never asked for.
    pub fn desire(
        &mut self,
        dimension: Dimension,
        desired: Desired,
        now_seconds: u64,
    ) -> Result<(), DimensionNotTracked> {
        let effect = self
            .entries
            .iter_mut()
            .find(|effect| effect.dimension() == dimension)
            .ok_or(DimensionNotTracked { dimension })?;
        effect.desire(desired, now_seconds);
        Ok(())
    }

    /// Record an enforcement point's report about one dimension.
    ///
    /// # Errors
    ///
    /// [`LedgerReportRefused::NotTracked`] when the grant demanded nothing on
    /// that axis, or [`LedgerReportRefused::Refused`] carrying the reason the
    /// report itself was not admissible.
    pub fn observe(
        &mut self,
        dimension: Dimension,
        report: Report,
        now_seconds: u64,
    ) -> Result<(), LedgerReportRefused> {
        let effect = self
            .entries
            .iter_mut()
            .find(|effect| effect.dimension() == dimension)
            .ok_or(LedgerReportRefused::NotTracked(DimensionNotTracked {
                dimension,
            }))?;
        effect
            .observe(report, now_seconds)
            .map_err(LedgerReportRefused::Refused)
    }

    /// Reconcile every entry.
    #[must_use]
    pub fn reconcile(&self, now_seconds: u64) -> Vec<(Dimension, Reconciliation)> {
        self.entries
            .iter()
            .map(|effect| (effect.dimension(), effect.reconcile(now_seconds)))
            .collect()
    }

    /// Only the entries that cannot be reconciled — what an operator is shown
    /// and what a security notice is raised from.
    #[must_use]
    pub fn divergences(&self, now_seconds: u64) -> Vec<(Dimension, Divergence)> {
        self.entries
            .iter()
            .filter_map(|effect| match effect.reconcile(now_seconds) {
                Reconciliation::Diverged(divergence) => Some((effect.dimension(), divergence)),
                Reconciliation::Converged | Reconciliation::Awaiting { .. } => None,
            })
            .collect()
    }

    /// Whether every tracked dimension has been observed to match what
    /// authority decided.
    ///
    /// Deliberately not the inverse of [`Self::divergences`]: an entry still
    /// awaiting a report is neither converged nor diverged, and a caller that
    /// treats "no divergences" as "settled" would report success while
    /// nothing had reported at all.
    #[must_use]
    pub fn all_converged(&self, now_seconds: u64) -> bool {
        self.entries
            .iter()
            .all(|effect| matches!(effect.reconcile(now_seconds), Reconciliation::Converged))
    }
}

/// Why a ledger did not record a report.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Error, Serialize, Deserialize)]
#[serde(tag = "ledger_report_refused", rename_all = "snake_case")]
pub enum LedgerReportRefused {
    /// The grant demanded nothing on that axis.
    #[error(transparent)]
    NotTracked(DimensionNotTracked),
    /// The report was not admissible.
    #[error(transparent)]
    Refused(ReportRefused),
}
