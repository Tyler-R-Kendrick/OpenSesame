//! The axes a guarantee is answered on.
//!
//! There is deliberately no ordering on this enum and no way to collapse the
//! three answers into one. A platform that stops a credential at its deadline
//! but cannot stop a run in flight is not "weaker" than one that does the
//! reverse — it is *differently shaped*, and a caller that needs termination
//! must be refused by the first and admitted by the second.

use serde::{Deserialize, Serialize};

/// One axis of enforcement, stated as the question it answers.
///
/// Adding a variant here is a breaking change on purpose:
/// [`crate::conformance::audit`] refuses a descriptor that leaves a dimension
/// unanswered, so a new axis cannot ship with the existing platforms quietly
/// defaulting to "yes".
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Dimension {
    /// Does the authority stop being usable when its deadline passes, without
    /// anyone asking?
    Expiry,
    /// Can authority already in flight be stopped now, on demand?
    Termination,
    /// Is the subject held to the grant's reach — its audiences, its networks,
    /// its own share of the device — by something other than its own restraint?
    Isolation,
}

impl Dimension {
    /// Every dimension, in a stable order.
    pub const ALL: [Self; 3] = [Self::Expiry, Self::Termination, Self::Isolation];

    /// The wire name, which is also the key in a refusal payload.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Expiry => "expiry",
            Self::Termination => "termination",
            Self::Isolation => "isolation",
        }
    }

    /// The question this dimension asks, for an operator-facing rendering.
    #[must_use]
    pub const fn question(self) -> &'static str {
        match self {
            Self::Expiry => "does the authority lapse on its own at the deadline?",
            Self::Termination => "can authority in flight be stopped on demand?",
            Self::Isolation => "is the subject held to the grant's reach by something else?",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::Dimension;

    #[test]
    fn every_dimension_is_in_all_and_has_a_distinct_wire_name() {
        // `ALL` is what the conformance audit walks. A dimension missing from
        // it would be a dimension no platform ever has to answer.
        let mut names: Vec<&str> = Dimension::ALL.iter().map(|d| d.as_str()).collect();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), Dimension::ALL.len());
        assert_eq!(names, ["expiry", "isolation", "termination"]);
    }

    #[test]
    fn dimensions_are_not_comparable_as_strengths() {
        // The ordering exists so a `BTreeMap` key works; it is not a ladder.
        // Nothing in this crate reads `Expiry < Termination` as "less".
        assert!(Dimension::Expiry < Dimension::Termination);
        assert_ne!(Dimension::Expiry, Dimension::Termination);
    }
}
