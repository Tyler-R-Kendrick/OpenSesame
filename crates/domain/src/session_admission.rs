//! Who lets a person into a public session (ADR 0137).
//!
//! ADR 0079 §7 made every admission the operator's decision. An operator
//! may instead decide once, for the whole session, that anybody who asks is
//! let in — and only as an observer, holding nothing. Keys are never handed
//! out by policy: a grant wraps a key for one person, ADR 0079 §3 cannot take
//! it back, so a participant seat still takes the operator's own decision.

use serde::{Deserialize, Serialize};

/// How a public session answers a request to join.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionAdmission {
    /// The operator admits or refuses each request (ADR 0079 §7).
    #[default]
    Operator,
    /// Whoever asks is seated at once as an observer, holding nothing.
    ObserverOnAsk,
}

impl SessionAdmission {
    /// The wire and storage spelling.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Operator => "operator",
            Self::ObserverOnAsk => "observer_on_ask",
        }
    }

    /// Read the wire and storage spelling; anything else is refused.
    #[must_use]
    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "operator" => Some(Self::Operator),
            "observer_on_ask" => Some(Self::ObserverOnAsk),
            _ => None,
        }
    }

    /// Whether this policy may stand on a session of `visibility`. Only a
    /// public session takes requests at all, so a private one that "admits
    /// on ask" would say something nobody could act on — refused, not ignored.
    #[must_use]
    pub fn fits(self, visibility: crate::SessionVisibility) -> bool {
        self == Self::Operator || visibility == crate::SessionVisibility::Public
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::SessionVisibility;

    #[test]
    fn spells_both_ways_and_refuses_the_rest() {
        for admission in [SessionAdmission::Operator, SessionAdmission::ObserverOnAsk] {
            assert_eq!(SessionAdmission::parse(admission.as_str()), Some(admission));
        }
        assert_eq!(SessionAdmission::parse("participant_on_ask"), None);
        assert_eq!(SessionAdmission::parse(""), None);
        assert_eq!(SessionAdmission::default(), SessionAdmission::Operator);
    }

    #[test]
    fn admits_on_ask_only_where_anyone_can_ask() {
        assert!(SessionAdmission::ObserverOnAsk.fits(SessionVisibility::Public));
        assert!(!SessionAdmission::ObserverOnAsk.fits(SessionVisibility::Private));
        assert!(SessionAdmission::Operator.fits(SessionVisibility::Private));
    }
}
