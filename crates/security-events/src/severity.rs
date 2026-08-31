//! How loud a security event is, on a ladder every downstream standard maps to.
//!
//! Four rungs, chosen because they are exactly `PagerDuty` Events API v2's
//! vocabulary and project cleanly onto the other two sinks. Picking a ladder
//! that needs collapsing at the edge is how a `critical` quietly becomes a
//! `warning` on one sink and not another; this one never needs it.

use serde::{Deserialize, Serialize};

/// Severity of a security event, ordered least to most urgent.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, Hash)]
#[serde(rename_all = "snake_case")]
pub enum Severity {
    /// Something happened worth recording. Nobody is woken.
    Info,
    /// A deadline or exposure is approaching. Human attention, not urgency.
    Warning,
    /// Something is wrong now and a human has to look.
    Error,
    /// Credentials are exposed or authority has lapsed. Page someone.
    Critical,
}

impl Severity {
    pub const ALL: [Self; 4] = [Self::Info, Self::Warning, Self::Error, Self::Critical];

    /// Frozen wire name. Identical to `PagerDuty` Events API v2's `severity`
    /// vocabulary and used verbatim as an Alertmanager `severity` label.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Info => "info",
            Self::Warning => "warning",
            Self::Error => "error",
            Self::Critical => "critical",
        }
    }

    #[must_use]
    pub fn parse(raw: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|level| level.as_str() == raw)
    }

    /// RFC 5424 numeric severity.
    ///
    /// Deliberately not the whole 0–7 range: a security event is never
    /// `debug`, and `emergency` means the system is unusable, which is a claim
    /// about the host rather than about one expiring certificate.
    #[must_use]
    pub const fn syslog_code(self) -> u8 {
        match self {
            Self::Info => 6,     // Informational
            Self::Warning => 4,  // Warning
            Self::Error => 3,    // Error
            Self::Critical => 2, // Critical
        }
    }

    /// Whether this rung is loud enough to satisfy a subscription's floor.
    #[must_use]
    pub fn at_least(self, floor: Self) -> bool {
        self >= floor
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wire_names_are_frozen_and_match_pagerduty() {
        let names: Vec<&str> = Severity::ALL.iter().map(|level| level.as_str()).collect();
        assert_eq!(names, ["info", "warning", "error", "critical"]);
    }

    #[test]
    fn the_ladder_is_ordered_least_to_most_urgent() {
        assert!(Severity::Info < Severity::Warning);
        assert!(Severity::Warning < Severity::Error);
        assert!(Severity::Error < Severity::Critical);
    }

    #[test]
    fn a_floor_admits_itself_and_everything_louder() {
        assert!(Severity::Critical.at_least(Severity::Warning));
        assert!(Severity::Warning.at_least(Severity::Warning));
        assert!(!Severity::Info.at_least(Severity::Warning));
    }

    #[test]
    fn syslog_codes_stay_inside_the_useful_band() {
        for level in Severity::ALL {
            let code = level.syslog_code();
            assert!((2..=6).contains(&code), "{level:?} mapped to {code}");
        }
        assert!(Severity::Critical.syslog_code() < Severity::Info.syslog_code());
    }

    #[test]
    fn every_wire_name_round_trips() {
        for level in Severity::ALL {
            assert_eq!(Severity::parse(level.as_str()), Some(level));
        }
        assert_eq!(Severity::parse("fatal"), None);
    }
}
