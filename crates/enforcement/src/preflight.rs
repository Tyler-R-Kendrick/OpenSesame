//! Grant preflight: judge the demands against the descriptor, before issuing.
//!
//! The point of doing this *before* a grant exists is that the alternative is
//! issuing authority whose terms nobody can hold, and discovering it when
//! someone tries to revoke. A grant that asks for termination on a surface
//! with no termination story is not a grant that degrades gracefully — it is a
//! promise to an operator that will not be kept.
//!
//! Two properties are load-bearing:
//!
//! - **An unsupported dimension is a refusal, never a pass.** The tempting bug
//!   is to skip a dimension nothing covers: there is no guarantee to compare
//!   against, so there is no comparison to fail. [`Shortfall::NotEnforced`]
//!   makes absence the loudest outcome rather than the quietest, and carries
//!   the descriptor's own [`UnsupportedResponse`] so the caller gets the
//!   reason and the remedy instead of a bare no.
//! - **Every shortfall is reported, not the first.** An operator deciding
//!   whether to move a workload needs the whole bill; stopping at the first
//!   failed field turns one decision into a sequence of them.
//!
//! The comparison is field by field, because that is the only way to compare
//! two guarantees without inventing the scalar this crate refuses to have. A
//! platform is not "enough" — it is enough *for the floors this caller named*,
//! and a different caller gets a different answer from the same descriptor.

use crate::descriptor::{Coverage, EnforcementDescriptor};
use crate::dimension::Dimension;
use crate::guarantee::{Bypass, Guarantee, Latency, Observability, Survival};
use crate::ledger::EffectLedger;
use crate::ownership::{EnforcementPoint, SubjectSurface};
use crate::requirement::{Requirement, Requirements};
use crate::unsupported::UnsupportedResponse;
use serde::Serialize;
use thiserror::Error;

/// One way a dimension fell short of what was demanded.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "shortfall", rename_all = "snake_case")]
pub enum Shortfall {
    /// Nothing enforces the dimension. Carries the platform's own reason.
    NotEnforced {
        /// Why, and what would change it.
        response: UnsupportedResponse,
    },
    /// The effect arrives too late.
    TooSlow {
        /// What the platform offers.
        offered: Latency,
        /// What was demanded.
        required: Latency,
    },
    /// The guarantee does not outlive what it must.
    TooShortLived {
        /// What the platform offers.
        offered: Survival,
        /// What was demanded.
        required: Survival,
    },
    /// The subject can get out too easily.
    TooEasilyBypassed {
        /// What the platform offers.
        offered: Bypass,
        /// What was demanded.
        required: Bypass,
    },
    /// We would not learn enough about whether it took effect.
    NotObservableEnough {
        /// What the platform offers.
        offered: Observability,
        /// What was demanded.
        required: Observability,
    },
    /// The enforcing component is the subject, or lives inside it.
    NotIndependentOfSubject {
        /// The point the platform named.
        offered: EnforcementPoint,
    },
}

impl Shortfall {
    /// Which field fell short, as a stable wire name.
    #[must_use]
    pub const fn kind(&self) -> &'static str {
        match self {
            Self::NotEnforced { .. } => "not_enforced",
            Self::TooSlow { .. } => "too_slow",
            Self::TooShortLived { .. } => "too_short_lived",
            Self::TooEasilyBypassed { .. } => "too_easily_bypassed",
            Self::NotObservableEnough { .. } => "not_observable_enough",
            Self::NotIndependentOfSubject { .. } => "not_independent_of_subject",
        }
    }
}

/// One dimension's shortfall, with the axis that makes it addressable.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct Unmet {
    /// The axis that fell short.
    pub dimension: Dimension,
    /// How. Flattened into the entry so a payload reads
    /// `{"dimension":"termination","shortfall":"not_enforced",...}` rather
    /// than nesting a field of the same name inside itself.
    #[serde(flatten)]
    pub shortfall: Shortfall,
}

/// A grant this platform cannot carry.
#[derive(Clone, Debug, PartialEq, Eq, Error, Serialize)]
#[error(
    "`{platform}` on `{}` cannot carry this grant: {} unmet requirement(s)",
    surface.as_str(),
    unmet.len()
)]
pub struct Refusal {
    /// The platform judged.
    pub platform: &'static str,
    /// The surface judged.
    pub surface: SubjectSurface,
    /// Every unmet demand, in [`Dimension::ALL`] order.
    pub unmet: Vec<Unmet>,
}

impl Refusal {
    /// Whether any dimension was refused because nothing enforces it, as
    /// opposed to enforcing it less well than demanded. The two want different
    /// operator copy: one is a platform gap, the other a policy mismatch.
    #[must_use]
    pub fn cites_unsupported(&self) -> bool {
        self.unmet
            .iter()
            .any(|unmet| matches!(unmet.shortfall, Shortfall::NotEnforced { .. }))
    }

    /// The unsupported responses behind this refusal.
    #[must_use]
    pub fn unsupported(&self) -> Vec<UnsupportedResponse> {
        self.unmet
            .iter()
            .filter_map(|unmet| match unmet.shortfall {
                Shortfall::NotEnforced { response } => Some(response),
                Shortfall::TooSlow { .. }
                | Shortfall::TooShortLived { .. }
                | Shortfall::TooEasilyBypassed { .. }
                | Shortfall::NotObservableEnough { .. }
                | Shortfall::NotIndependentOfSubject { .. } => None,
            })
            .collect()
    }
}

/// A grant whose demands this platform can carry.
///
/// Carries the guarantees relied on rather than a bare yes, so a receipt can
/// name *how* a call was held instead of leaving a later reader to infer it
/// from the platform's name.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Admitted {
    platform: &'static str,
    surface: SubjectSurface,
    held: Vec<(Dimension, Guarantee)>,
}

impl Admitted {
    /// The platform that will hold it.
    #[must_use]
    pub const fn platform(&self) -> &'static str {
        self.platform
    }

    /// The surface it was admitted on.
    #[must_use]
    pub const fn surface(&self) -> SubjectSurface {
        self.surface
    }

    /// The guarantee backing each demanded dimension.
    #[must_use]
    pub fn held(&self) -> &[(Dimension, Guarantee)] {
        &self.held
    }

    /// The guarantee relied on for one dimension, where it was demanded.
    #[must_use]
    pub fn guarantee(&self, dimension: Dimension) -> Option<Guarantee> {
        self.held
            .iter()
            .find(|(held, _)| *held == dimension)
            .map(|(_, guarantee)| *guarantee)
    }

    /// Open the effect ledger for this grant.
    ///
    /// Everything starts desired-in-force and *unobserved*: admission is a
    /// statement about what the platform can do, never a report that it has.
    #[must_use]
    pub fn open_ledger(&self, now_seconds: u64) -> EffectLedger {
        EffectLedger::opening_at(&self.held, now_seconds)
    }
}

/// Judge a grant's demands against what a platform holds.
///
/// # Errors
///
/// A [`Refusal`] listing every unmet demand. All dimensions are judged before
/// returning, so an operator sees the whole gap rather than the first one.
pub fn preflight(
    requirements: &Requirements,
    descriptor: &EnforcementDescriptor,
) -> Result<Admitted, Refusal> {
    let mut unmet = Vec::new();
    let mut held = Vec::new();
    for dimension in Dimension::ALL {
        let Some(requirement) = requirements.get(dimension) else {
            continue;
        };
        match descriptor.coverage(dimension) {
            Coverage::Enforced(guarantee) => {
                let before = unmet.len();
                judge(&requirement, guarantee, &mut unmet);
                if unmet.len() == before {
                    held.push((dimension, *guarantee));
                }
            }
            Coverage::Unsupported(_) => unmet.push(Unmet {
                dimension,
                shortfall: Shortfall::NotEnforced {
                    response: unsupported_response(descriptor, dimension),
                },
            }),
        }
    }
    if unmet.is_empty() {
        Ok(Admitted {
            platform: descriptor.platform(),
            surface: descriptor.surface(),
            held,
        })
    } else {
        Err(Refusal {
            platform: descriptor.platform(),
            surface: descriptor.surface(),
            unmet,
        })
    }
}

fn judge(requirement: &Requirement, guarantee: &Guarantee, unmet: &mut Vec<Unmet>) {
    let dimension = requirement.dimension;
    let mut note = |shortfall| {
        unmet.push(Unmet {
            dimension,
            shortfall,
        });
    };
    if requirement.independent_point && !guarantee.point.independent_of_subject() {
        note(Shortfall::NotIndependentOfSubject {
            offered: guarantee.point,
        });
    }
    if !guarantee.latency.within(requirement.latency_ceiling) {
        note(Shortfall::TooSlow {
            offered: guarantee.latency,
            required: requirement.latency_ceiling,
        });
    }
    if !guarantee.survival.at_least(requirement.survival_floor) {
        note(Shortfall::TooShortLived {
            offered: guarantee.survival,
            required: requirement.survival_floor,
        });
    }
    if !guarantee.bypass.at_least(requirement.bypass_floor) {
        note(Shortfall::TooEasilyBypassed {
            offered: guarantee.bypass,
            required: requirement.bypass_floor,
        });
    }
    if !guarantee
        .observability
        .at_least(requirement.observability_floor)
    {
        note(Shortfall::NotObservableEnough {
            offered: guarantee.observability,
            required: requirement.observability_floor,
        });
    }
}

/// The descriptor's own account of why a dimension is unenforced.
///
/// The coverage was already matched as unsupported by the caller, so the
/// fallback here is unreachable in practice; it is written as a value rather
/// than an `unwrap` so a future coverage variant cannot make preflight panic.
fn unsupported_response(
    descriptor: &EnforcementDescriptor,
    dimension: Dimension,
) -> UnsupportedResponse {
    descriptor
        .unsupported(dimension)
        .unwrap_or_else(|| UnsupportedResponse {
            platform: descriptor.platform(),
            surface: descriptor.surface(),
            dimension,
            reason: crate::unsupported::UnsupportedReason::NoAdapter,
            remedy: crate::unsupported::Remedy::NoneKnown,
            detail: "the descriptor gave no reason",
        })
}
