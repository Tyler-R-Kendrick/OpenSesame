//! What a store reported, and the three-valued answer it produces.
//!
//! Split from `mod.rs` to stay inside the 400-line module budget (ADR 0093).
//! The invariant this file exists to hold: `Clear` is the last thing
//! `evaluate_fence` can reach, and the only variant that authorizes.

use super::Lineage;
use std::fmt;

/// One durable invalidation the store found.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Invalidation {
    /// The grant that was revoked. Descendants are not enumerated — that is
    /// the point of the fence.
    pub grant_id: String,
    /// Where this revocation sits in the store's total order. See
    /// [`FenceReading::observed_sequence`].
    pub sequence: u64,
    /// A short, value-blind note: which road revoked it.
    pub reason: String,
}

/// What a store reported about one lineage at one instant.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FenceReading {
    /// The store's monotonic fence sequence at the moment of the read. Every
    /// committed invalidation takes the next value, so this doubles as
    /// "everything I could have seen".
    pub observed_sequence: u64,
    /// Invalidation rows found for ids in the lineage. An empty vector means
    /// the store looked and found none — not that it did not look.
    pub invalidations: Vec<Invalidation>,
}

/// Why the fence could not be established. Every variant denies.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Uncertainty {
    /// The grant has no lineage row. Either it was written by a path that does
    /// not record lineage, or a migration has not finished. Both mean its
    /// ancestry is unknown, and an unknown ancestry cannot be cleared.
    LineageMissing { grant_id: String },
    /// A stored lineage did not survive parsing.
    LineageUnusable { grant_id: String, detail: String },
    /// The stored row and the chain disagree about the root or the depth, so
    /// one of them is stale.
    LineageInconsistent { grant_id: String, detail: String },
    /// The reading mentions a grant outside the lineage, so it was not taken
    /// for this chain and says nothing about it.
    ReadingMismatched { grant_id: String, foreign: String },
    /// The store could not answer.
    StoreUnavailable { detail: String },
    /// The reading is from behind a point the caller has already seen, so a
    /// revocation it has observed might be missing from it.
    Stale {
        observed_sequence: u64,
        required_sequence: u64,
    },
}

impl fmt::Display for Uncertainty {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::LineageMissing { grant_id } => {
                write!(f, "grant {grant_id} has no recorded lineage")
            }
            Self::LineageUnusable { grant_id, detail } => {
                write!(f, "grant {grant_id} has an unusable lineage: {detail}")
            }
            Self::LineageInconsistent { grant_id, detail } => {
                write!(f, "grant {grant_id} has an inconsistent lineage: {detail}")
            }
            Self::ReadingMismatched { grant_id, foreign } => write!(
                f,
                "fence reading for {grant_id} mentions unrelated grant {foreign}"
            ),
            Self::StoreUnavailable { detail } => {
                write!(f, "fence store unavailable: {detail}")
            }
            Self::Stale {
                observed_sequence,
                required_sequence,
            } => write!(
                f,
                "fence reading at sequence {observed_sequence} is behind {required_sequence}"
            ),
        }
    }
}

/// The fence's answer for one grant.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FenceVerdict {
    /// Nothing in the chain is invalidated, as of `observed_sequence`.
    Clear {
        root_grant_id: String,
        depth: u32,
        observed_sequence: u64,
    },
    /// The grant itself or an ancestor is durably revoked.
    Invalidated {
        /// The invalidated grant closest to the root — the cause, not the
        /// nearest symptom.
        blocked_by: String,
        /// Whether the revoked grant *is* this one, as opposed to an ancestor.
        is_self: bool,
        sequence: u64,
        reason: String,
    },
    /// The fence could not be established. Deny.
    Indeterminate { cause: Uncertainty },
}

impl FenceVerdict {
    /// The single question a caller should ask. One variant answers `true`.
    #[must_use]
    pub fn authorizes(&self) -> bool {
        matches!(self, Self::Clear { .. })
    }

    /// A short, value-blind explanation for a receipt or a log line.
    #[must_use]
    pub fn reason(&self) -> String {
        match self {
            Self::Clear { .. } => "fence clear".to_string(),
            Self::Invalidated {
                blocked_by,
                is_self,
                reason,
                ..
            } => {
                let which = if *is_self { "grant" } else { "ancestor" };
                format!("{which} {blocked_by} invalidated: {reason}")
            }
            Self::Indeterminate { cause } => format!("fence indeterminate: {cause}"),
        }
    }
}

/// How fresh a reading has to be to count.
///
/// A caller that has already observed the fence at some sequence — because it
/// read it a moment ago, or because a receipt names it — must not then accept
/// an answer from behind that point.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Freshness {
    /// The lowest sequence this caller will accept. `0` accepts any reading.
    pub required_sequence: u64,
}

impl Freshness {
    /// Accept any committed reading. Correct for a single-writer store read
    /// directly, where there is no replica to lag.
    #[must_use]
    pub const fn any() -> Self {
        Self {
            required_sequence: 0,
        }
    }

    /// Accept only readings at or past `sequence`.
    #[must_use]
    pub const fn at_least(sequence: u64) -> Self {
        Self {
            required_sequence: sequence,
        }
    }
}

/// Decide whether a grant's chain is fenced.
///
/// The order matters and is the contract: freshness first (a stale reading is
/// not evidence of anything), then correspondence (a reading about other
/// grants is not evidence about this one), then invalidation, and only then
/// `Clear`. `Clear` is the last thing this function can reach, never the
/// first.
#[must_use]
pub fn evaluate_fence(
    lineage: &Lineage,
    reading: &FenceReading,
    freshness: Freshness,
) -> FenceVerdict {
    if reading.observed_sequence < freshness.required_sequence {
        return FenceVerdict::Indeterminate {
            cause: Uncertainty::Stale {
                observed_sequence: reading.observed_sequence,
                required_sequence: freshness.required_sequence,
            },
        };
    }

    if let Some(foreign) = reading
        .invalidations
        .iter()
        .find(|found| !lineage.covers(&found.grant_id))
    {
        return FenceVerdict::Indeterminate {
            cause: Uncertainty::ReadingMismatched {
                grant_id: lineage.grant_id().to_string(),
                foreign: foreign.grant_id.clone(),
            },
        };
    }

    // The closest to the root wins, so the answer names the cause rather than
    // whichever row the store happened to return first.
    let blocking = lineage.chain().iter().find_map(|id| {
        reading
            .invalidations
            .iter()
            .find(|found| &found.grant_id == id)
    });
    if let Some(found) = blocking {
        return FenceVerdict::Invalidated {
            blocked_by: found.grant_id.clone(),
            is_self: found.grant_id == lineage.grant_id(),
            sequence: found.sequence,
            reason: found.reason.clone(),
        };
    }

    FenceVerdict::Clear {
        root_grant_id: lineage.root_id().to_string(),
        depth: lineage.depth(),
        observed_sequence: reading.observed_sequence,
    }
}

/// The verdict for a grant the store has no lineage for.
///
/// A convenience so every caller spells the missing-lineage denial the same
/// way instead of inventing its own.
#[must_use]
pub fn missing_lineage(grant_id: &str) -> FenceVerdict {
    FenceVerdict::Indeterminate {
        cause: Uncertainty::LineageMissing {
            grant_id: grant_id.to_string(),
        },
    }
}

/// The verdict for a store that could not answer.
#[must_use]
pub fn store_unavailable(detail: &str) -> FenceVerdict {
    FenceVerdict::Indeterminate {
        cause: Uncertainty::StoreUnavailable {
            detail: detail.to_string(),
        },
    }
}

#[cfg(test)]
#[path = "verdict_tests.rs"]
mod verdict_tests;
