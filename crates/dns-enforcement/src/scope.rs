//! Which names an allowance may name (DNS-SCOPE).
//!
//! A DNS allowance is a hole in a filter, so its width is the whole question.
//! The rules here are deliberately narrower than what Blocky would accept in a
//! list file: Blocky is happy to be handed `com`, and a person who types that
//! into an allowance has not written a permission, they have written an
//! exemption from the product.
//!
//! Two refusals do the load-bearing work:
//!
//! - **A single-label rule is refused.** `com`, `org`, `internal` — each of
//!   these covers every name beneath a public suffix. There is no legitimate
//!   allowance at that width, and the ones that look legitimate (`localhost`)
//!   are resolved before a filter ever sees them.
//! - **A wildcard is refused, not translated.** Blocky's list format has no
//!   `*.example.org` form; the entry `example.org` already covers its
//!   subdomains. Accepting the wildcard spelling and quietly dropping the `*`
//!   would mean the string a person approved is not the string that was
//!   applied, so [`DomainRule::parse`] rejects it and says which spelling to
//!   use.

use std::fmt;

use serde::{Deserialize, Serialize};

/// The longest a presentation-format domain name may be, in octets.
const MAX_NAME_OCTETS: usize = 253;

/// The longest a single label may be, in octets.
const MAX_LABEL_OCTETS: usize = 63;

/// Why a proposed rule is not a rule.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum ScopeError {
    /// The rule was empty, or was only separators and whitespace.
    #[error("a domain rule cannot be empty")]
    Empty,
    /// The rule was the DNS root.
    #[error("the DNS root is not an allowance scope")]
    Root,
    /// The rule used a wildcard spelling.
    #[error(
        "wildcards are not a rule spelling: write `{suggestion}`, which already covers its subdomains"
    )]
    Wildcard {
        /// The rule the caller should have written instead.
        suggestion: String,
    },
    /// The rule named a single label, which is a public suffix or wider.
    #[error("`{label}` is a single label, which covers every name beneath it")]
    SingleLabel {
        /// The label that was offered.
        label: String,
    },
    /// The rule was longer than DNS permits.
    #[error("a domain name is at most {MAX_NAME_OCTETS} octets, got {octets}")]
    TooLong {
        /// The length that was offered.
        octets: usize,
    },
    /// One label was empty (`a..b`) or longer than DNS permits.
    #[error("`{label}` is not a usable label")]
    BadLabel {
        /// The label at fault.
        label: String,
    },
    /// The rule held a character that cannot appear in a hostname label.
    #[error("`{character}` cannot appear in a domain rule")]
    BadCharacter {
        /// The offending character.
        character: char,
    },
}

/// A domain name an allowance or a denial may name, normalised.
///
/// Normalisation is lowercase, no trailing dot, no surrounding whitespace —
/// so two spellings of the same name compare equal, and the string that was
/// approved is the string that reaches the list file.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct DomainRule(String);

impl DomainRule {
    /// Parse and normalise a rule.
    ///
    /// # Errors
    ///
    /// Returns [`ScopeError`] when the name is unusable or too wide to be an
    /// allowance — see the module documentation for why width is an error and
    /// not a warning.
    pub fn parse(raw: &str) -> Result<Self, ScopeError> {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return Err(ScopeError::Empty);
        }
        if trimmed == "." {
            return Err(ScopeError::Root);
        }

        let lowered = trimmed.to_ascii_lowercase();
        let name = lowered.strip_suffix('.').unwrap_or(&lowered);

        if let Some(rest) = name.strip_prefix("*.") {
            return Err(ScopeError::Wildcard {
                suggestion: rest.to_owned(),
            });
        }
        if name.contains('*') {
            return Err(ScopeError::Wildcard {
                suggestion: name.replace("*.", "").replace('*', ""),
            });
        }
        if name.is_empty() {
            return Err(ScopeError::Empty);
        }
        if name.len() > MAX_NAME_OCTETS {
            return Err(ScopeError::TooLong { octets: name.len() });
        }

        let labels: Vec<&str> = name.split('.').collect();
        for label in &labels {
            if label.is_empty() || label.len() > MAX_LABEL_OCTETS {
                return Err(ScopeError::BadLabel {
                    label: (*label).to_owned(),
                });
            }
            if label.starts_with('-') || label.ends_with('-') {
                return Err(ScopeError::BadLabel {
                    label: (*label).to_owned(),
                });
            }
            if let Some(bad) = label
                .chars()
                .find(|c| !c.is_ascii_alphanumeric() && *c != '-')
            {
                return Err(ScopeError::BadCharacter { character: bad });
            }
        }
        if labels.len() < 2 {
            return Err(ScopeError::SingleLabel {
                label: name.to_owned(),
            });
        }

        Ok(Self(name.to_owned()))
    }

    /// The normalised name, as it is written into a list file.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Whether this rule answers for `qname`.
    ///
    /// This mirrors Blocky's own list matching, which was measured: an entry
    /// covers the name itself and every name beneath it, and never a sibling
    /// that merely shares a suffix (`notexample.org` is not covered by
    /// `example.org`).
    #[must_use]
    pub fn covers(&self, qname: &str) -> bool {
        let candidate = qname.trim().trim_end_matches('.').to_ascii_lowercase();
        if candidate == self.0 {
            return true;
        }
        candidate
            .strip_suffix(&self.0)
            .is_some_and(|head| head.ends_with('.'))
    }

    /// Whether this rule is `parent` or something strictly beneath it.
    ///
    /// This is the narrowing check an allowance derived from a broader
    /// authority has to pass: `docs.example.org` narrows `example.org`, and
    /// nothing narrows a rule it does not sit under.
    #[must_use]
    pub fn narrows(&self, parent: &Self) -> bool {
        parent.covers(&self.0)
    }
}

impl fmt::Display for DomainRule {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl TryFrom<String> for DomainRule {
    type Error = ScopeError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::parse(&value)
    }
}

impl From<DomainRule> for String {
    fn from(value: DomainRule) -> Self {
        value.0
    }
}

#[cfg(test)]
mod tests {
    use super::{DomainRule, ScopeError};

    fn rule(raw: &str) -> DomainRule {
        DomainRule::parse(raw).expect("rule should parse")
    }

    #[test]
    fn spellings_of_one_name_normalise_together() {
        // The approved string and the applied string have to be the same one.
        assert_eq!(rule("Example.ORG").as_str(), "example.org");
        assert_eq!(rule(" example.org. ").as_str(), "example.org");
        assert_eq!(rule("Example.org"), rule("example.org."));
    }

    #[test]
    fn a_single_label_is_too_wide_to_be_an_allowance() {
        // `com` in an allowlist is an exemption from the product.
        assert_eq!(
            DomainRule::parse("com"),
            Err(ScopeError::SingleLabel {
                label: "com".to_owned()
            })
        );
        assert_eq!(
            DomainRule::parse("localhost"),
            Err(ScopeError::SingleLabel {
                label: "localhost".to_owned()
            })
        );
    }

    #[test]
    fn a_wildcard_is_refused_with_the_spelling_to_use_instead() {
        // Silently dropping the `*` would apply a string nobody approved.
        assert_eq!(
            DomainRule::parse("*.example.org"),
            Err(ScopeError::Wildcard {
                suggestion: "example.org".to_owned()
            })
        );
    }

    #[test]
    fn the_root_and_the_empty_rule_are_refused() {
        assert_eq!(DomainRule::parse("."), Err(ScopeError::Root));
        assert_eq!(DomainRule::parse("   "), Err(ScopeError::Empty));
    }

    #[test]
    fn malformed_names_are_refused() {
        assert!(matches!(
            DomainRule::parse("a..b"),
            Err(ScopeError::BadLabel { .. })
        ));
        assert!(matches!(
            DomainRule::parse("-bad.example.org"),
            Err(ScopeError::BadLabel { .. })
        ));
        assert!(matches!(
            DomainRule::parse("under_score.example.org"),
            Err(ScopeError::BadCharacter { character: '_' })
        ));
        let long_label = "a".repeat(64);
        assert!(matches!(
            DomainRule::parse(&format!("{long_label}.example.org")),
            Err(ScopeError::BadLabel { .. })
        ));
    }

    #[test]
    fn a_rule_covers_itself_and_its_subdomains_but_never_a_suffix_sibling() {
        let parent = rule("example.org");
        assert!(parent.covers("example.org"));
        assert!(parent.covers("docs.example.org"));
        assert!(parent.covers("DEEP.docs.Example.org."));
        // The bug this guards: a naive `ends_with` lets a stranger's domain
        // through by buying a name that ends in ours.
        assert!(!parent.covers("notexample.org"));
        assert!(!parent.covers("example.org.evil.test"));
    }

    #[test]
    fn narrowing_runs_downward_only() {
        let parent = rule("example.org");
        let child = rule("docs.example.org");
        assert!(child.narrows(&parent));
        assert!(parent.narrows(&parent));
        // A parent does not narrow its own child, which is the direction an
        // attenuated allowance would have to travel to widen itself.
        assert!(!parent.narrows(&child));
        assert!(!rule("other.test").narrows(&parent));
    }

    #[test]
    fn a_rule_round_trips_through_serde_by_reparsing() {
        let json = serde_json::to_string(&rule("docs.example.org")).expect("serialise");
        assert_eq!(json, "\"docs.example.org\"");
        let back: DomainRule = serde_json::from_str(&json).expect("deserialise");
        assert_eq!(back, rule("docs.example.org"));
        // Deserialising goes through `parse`, so a too-wide rule cannot be
        // smuggled in as stored state.
        assert!(serde_json::from_str::<DomainRule>("\"com\"").is_err());
    }
}
