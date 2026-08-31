//! The closed set of corpora we will consult.
//!
//! Closed on purpose. A breach source is something we send a query to and then
//! believe about our tenants' secrets, so "which sources" is a trust decision,
//! not configuration. An operator chooses whether a source is enabled; nobody
//! adds one through a manifest.
//!
//! Both entries are Have I Been Pwned surfaces, and both were picked for the
//! same reason: neither one requires telling the source anything about the
//! tenant. See [`crate::digest`] for how that holds for passwords, and
//! [`crate::catalogue`] for how it holds for providers.

use serde::{Deserialize, Serialize};

/// A corpus the scanner consults.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, Hash)]
#[serde(rename_all = "snake_case")]
pub enum BreachSource {
    /// Have I Been Pwned's Pwned Passwords range API, queried by a five
    /// character hash prefix ([k-anonymity]).
    ///
    /// [k-anonymity]: https://haveibeenpwned.com/API/v3#PwnedPasswords
    HibpPasswords,
    /// Have I Been Pwned's public breach catalogue, fetched whole and matched
    /// against watched domains locally.
    HibpBreaches,
}

impl BreachSource {
    pub const ALL: [Self; 2] = [Self::HibpPasswords, Self::HibpBreaches];

    /// Frozen wire name.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::HibpPasswords => "hibp_passwords",
            Self::HibpBreaches => "hibp_breaches",
        }
    }

    /// Operator-facing name for a summary line.
    #[must_use]
    pub const fn title(self) -> &'static str {
        match self {
            Self::HibpPasswords => "Have I Been Pwned (Pwned Passwords)",
            Self::HibpBreaches => "Have I Been Pwned (breach catalogue)",
        }
    }

    #[must_use]
    pub fn parse(raw: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|source| source.as_str() == raw)
    }

    /// Whether consulting this source requires opening a sealed value.
    ///
    /// Only the password corpus does, and only to derive a hash prefix in
    /// memory. The catalogue is matched entirely against metadata, so a
    /// gateway running without a sealing key still gets provider-disclosure
    /// coverage.
    #[must_use]
    pub const fn reads_secret_material(self) -> bool {
        matches!(self, Self::HibpPasswords)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wire_names_are_frozen() {
        let names: Vec<&str> = BreachSource::ALL
            .iter()
            .map(|source| source.as_str())
            .collect();
        assert_eq!(names, ["hibp_passwords", "hibp_breaches"]);
    }

    #[test]
    fn every_wire_name_round_trips() {
        for source in BreachSource::ALL {
            assert_eq!(BreachSource::parse(source.as_str()), Some(source));
        }
        assert_eq!(BreachSource::parse("hibp_accounts"), None);
    }

    #[test]
    fn only_the_password_corpus_needs_a_sealed_value() {
        assert!(BreachSource::HibpPasswords.reads_secret_material());
        assert!(!BreachSource::HibpBreaches.reads_secret_material());
    }
}
