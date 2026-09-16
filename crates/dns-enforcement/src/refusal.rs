//! The one error a caller sees, and the distinction that matters inside it.
//!
//! Every other module refuses things for its own reasons. What a caller has to
//! be able to tell apart is narrower and more important than which module spoke:
//!
//! - **A decision.** The mechanism ran and said no. A rule was too wide, a
//!   topology leaked, a claim was not DNS-shaped.
//! - **A capability gap.** The mechanism did not run. Blocky is not installed,
//!   not reachable, or reachable and switched off.
//!
//! Collapsing those two is how a filter comes to be reported as working while it
//! is not running. [`Refusal::is_capability_gap`] is the split, and the contract
//! around it is that a gap is *surfaced*, never defaulted: there is no path in
//! this crate that answers "not blocked" because it could not ask.

use crate::blocky::ProtocolError;
use crate::coverage::TruthError;
use crate::lifetime::LifetimeError;
use crate::scope::ScopeError;
use crate::topology::{IdError, IsolationError};

/// Why an operation did not happen.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum Refusal {
    /// No DNS enforcement is available: no binary, no endpoint, no answer.
    ///
    /// This is the state the assignment's "do not fake success" is about. A
    /// caller receiving it knows nothing about any domain, and must not record
    /// an allowance as applied or a denial as in force.
    #[error("DNS enforcement is unavailable: {detail}")]
    CapabilityUnavailable {
        /// What was tried and what happened, for an operator log.
        detail: String,
    },
    /// Blocky answered, and is not currently enforcing.
    ///
    /// Distinct from [`Self::CapabilityUnavailable`] because the remedy is
    /// different — this instance is up and has been switched off — but equally
    /// not a success.
    #[error("DNS enforcement is present but not enforcing: {detail}")]
    NotEnforcing {
        /// The condition observed, e.g. which groups are disabled.
        detail: String,
    },
    /// The endpoint address was not one this crate will talk to.
    #[error("endpoint refused: {detail}")]
    BadEndpoint {
        /// Why the address was refused.
        detail: String,
    },
    /// A proposed rule was not a usable scope.
    #[error(transparent)]
    Scope(#[from] ScopeError),
    /// An identifier was unusable.
    #[error(transparent)]
    Id(#[from] IdError),
    /// A topology would not isolate its units.
    #[error(transparent)]
    Isolation(#[from] IsolationError),
    /// An allowance lifetime was not acceptable.
    #[error(transparent)]
    Lifetime(#[from] LifetimeError),
    /// A protocol value could not be built or read.
    #[error(transparent)]
    Protocol(#[from] ProtocolError),
    /// A claim was not DNS-shaped.
    #[error(transparent)]
    Truth(#[from] TruthError),
}

impl Refusal {
    /// Whether the mechanism failed to run, as opposed to running and saying no.
    ///
    /// A caller that treats this as a denial is safe. A caller that treats it as
    /// an allowance, or as evidence that nothing needed doing, is the failure
    /// mode this method exists to prevent.
    #[must_use]
    pub const fn is_capability_gap(&self) -> bool {
        matches!(
            self,
            Self::CapabilityUnavailable { .. } | Self::NotEnforcing { .. }
        )
    }

    /// A capability gap, from something that went wrong while reaching Blocky.
    pub fn unavailable(detail: impl Into<String>) -> Self {
        Self::CapabilityUnavailable {
            detail: detail.into(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::Refusal;
    use crate::coverage::{Claim, Coverage};
    use crate::scope::DomainRule;

    #[test]
    fn a_missing_backend_is_a_capability_gap_and_a_wide_rule_is_a_decision() {
        // The split a caller reads. Both are refusals; only one means "we did
        // not look".
        assert!(Refusal::unavailable("connection refused").is_capability_gap());
        assert!(Refusal::NotEnforcing {
            detail: "all groups disabled".to_owned()
        }
        .is_capability_gap());

        let scope_error = DomainRule::parse("com").expect_err("too wide");
        assert!(!Refusal::from(scope_error).is_capability_gap());
    }

    #[test]
    fn every_refusal_from_another_module_arrives_as_a_decision() {
        let truth = Coverage::attest(Claim::ScreenTime).expect_err("refused");
        assert!(!Refusal::from(truth).is_capability_gap());

        let bad_endpoint = Refusal::BadEndpoint {
            detail: "userinfo in URL".to_owned(),
        };
        assert!(!bad_endpoint.is_capability_gap());
    }

    #[test]
    fn a_capability_gap_carries_the_detail_an_operator_needs() {
        let refusal = Refusal::unavailable("no route to 127.0.0.1:54780");
        assert!(refusal.to_string().contains("127.0.0.1:54780"));
        assert!(refusal.to_string().contains("unavailable"));
    }
}
