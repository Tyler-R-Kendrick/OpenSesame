//! The typed condition algebra (POL-ALGEBRA).
//!
//! Authority narrows. Every dimension a grant can restrict — the actions, the
//! resources, the audiences, the assurance floor, the deadline, the invoke
//! level, the export privilege — is one variant of a closed [`Condition`] set,
//! and the only two operations on it are "does this narrow that" and "what do
//! both of these permit together".
//!
//! Both operations are total on the kinds they accept and refuse everything
//! else *as an error*, which is the whole point of typing them:
//!
//! - a condition kind outside the closed set cannot be constructed from a wire
//!   string, so a term nobody implemented can never be silently skipped;
//! - a meet across two different kinds is a [`PolicyFault`], not an empty set
//!   and not one side winning, because there is no such intersection;
//! - an unknown assurance name is a fault rather than rank zero, which used to
//!   make an unrecognized `required_assurance` weaker than a password.
//!
//! The narrowing direction is the one `opensesame_domain::grant_attenuation`
//! already enforces hop by hop; this module is the same order relation as a
//! value, so a chain's *effective* authority can be computed rather than
//! assumed from its leaf.

use crate::error::{PolicyFault, UnknownTerm};
use chrono::{DateTime, Utc};
use opensesame_domain::{grant_attenuation::resources_attenuate, InvokeLevel};
use std::collections::BTreeSet;

/// The closed set of dimensions authority may be restricted along.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ConditionKind {
    Actions,
    Resources,
    Audiences,
    Assurance,
    NotAfter,
    InvokeLevel,
    RawExport,
}

impl ConditionKind {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Actions => "actions",
            Self::Resources => "resources",
            Self::Audiences => "audiences",
            Self::Assurance => "assurance",
            Self::NotAfter => "not_after",
            Self::InvokeLevel => "invoke_level",
            Self::RawExport => "raw_export",
        }
    }

    /// Parse a wire name. An unrecognized kind is a fault, never a no-op.
    ///
    /// # Errors
    ///
    /// Returns [`PolicyFault::Unknown`] when the name is outside the closed set.
    pub fn parse(name: &str) -> Result<Self, PolicyFault> {
        match name {
            "actions" => Ok(Self::Actions),
            "resources" => Ok(Self::Resources),
            "audiences" => Ok(Self::Audiences),
            "assurance" => Ok(Self::Assurance),
            "not_after" => Ok(Self::NotAfter),
            "invoke_level" => Ok(Self::InvokeLevel),
            "raw_export" => Ok(Self::RawExport),
            other => Err(PolicyFault::Unknown(UnknownTerm::ConditionKind(
                other.to_owned(),
            ))),
        }
    }
}

/// Authenticator strength, ranked. `Ord` is the ranking.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum AssuranceLevel {
    Password,
    Mfa,
    PhishingResistant,
}

impl AssuranceLevel {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Password => "password",
            Self::Mfa => "mfa",
            Self::PhishingResistant => "phishing-resistant",
        }
    }

    /// Parse an assurance name from a grant or an authentication context.
    ///
    /// # Errors
    ///
    /// Returns [`PolicyFault::Unknown`] for any name outside the ladder. An
    /// unknown *requirement* must not be satisfiable and an unknown *holding*
    /// must not satisfy anything, so neither may quietly become rank zero.
    pub fn parse(name: &str) -> Result<Self, PolicyFault> {
        match name {
            "pwd" | "password" => Ok(Self::Password),
            "mfa" => Ok(Self::Mfa),
            "phishing-resistant" => Ok(Self::PhishingResistant),
            other => Err(PolicyFault::Unknown(UnknownTerm::AssuranceLevel(
                other.to_owned(),
            ))),
        }
    }
}

/// One restriction along one dimension.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Condition {
    /// Exactly these action names. An empty set permits nothing.
    Actions(BTreeSet<String>),
    /// These resource selectors, in the grant's own selector grammar.
    Resources(BTreeSet<String>),
    /// Exactly these audiences.
    Audiences(BTreeSet<String>),
    /// At least this authenticator strength.
    Assurance(AssuranceLevel),
    /// Not valid after this instant.
    NotAfter(DateTime<Utc>),
    /// At most this invoke level.
    InvokeLevel(InvokeLevel),
    /// Whether raw credential export is permitted at all.
    RawExport(bool),
}

impl Condition {
    #[must_use]
    pub fn kind(&self) -> ConditionKind {
        match self {
            Self::Actions(_) => ConditionKind::Actions,
            Self::Resources(_) => ConditionKind::Resources,
            Self::Audiences(_) => ConditionKind::Audiences,
            Self::Assurance(_) => ConditionKind::Assurance,
            Self::NotAfter(_) => ConditionKind::NotAfter,
            Self::InvokeLevel(_) => ConditionKind::InvokeLevel,
            Self::RawExport(_) => ConditionKind::RawExport,
        }
    }

    /// True when `self` permits no more than `parent` along this dimension.
    ///
    /// # Errors
    ///
    /// Returns [`PolicyFault::ConditionKindMismatch`] when the two conditions
    /// restrict different dimensions. There is no ordering across kinds, and
    /// answering `false` would read as "this widens", which is also untrue.
    pub fn narrows(&self, parent: &Self) -> Result<bool, PolicyFault> {
        match (self, parent) {
            (Self::Actions(child), Self::Actions(parent))
            | (Self::Audiences(child), Self::Audiences(parent)) => Ok(child.is_subset(parent)),
            (Self::Resources(child), Self::Resources(parent)) => Ok(resources_attenuate(
                &child.iter().cloned().collect::<Vec<_>>(),
                &parent.iter().cloned().collect::<Vec<_>>(),
            )),
            (Self::Assurance(child), Self::Assurance(parent)) => Ok(child >= parent),
            (Self::NotAfter(child), Self::NotAfter(parent)) => Ok(child <= parent),
            (Self::InvokeLevel(child), Self::InvokeLevel(parent)) => Ok(child <= parent),
            (Self::RawExport(child), Self::RawExport(parent)) => Ok(!*child || *parent),
            (left, right) => Err(PolicyFault::ConditionKindMismatch {
                left: left.kind(),
                right: right.kind(),
            }),
        }
    }

    /// What both conditions permit together — the greatest lower bound.
    ///
    /// For selector sets this is conservative by construction: a member
    /// survives only when the other side already contains it, so the result is
    /// never wider than either input even where the two grammars overlap in a
    /// way no exact intersection could express.
    ///
    /// # Errors
    ///
    /// Returns [`PolicyFault::ConditionKindMismatch`] across dimensions.
    pub fn meet(&self, other: &Self) -> Result<Self, PolicyFault> {
        match (self, other) {
            (Self::Actions(left), Self::Actions(right)) => {
                Ok(Self::Actions(left.intersection(right).cloned().collect()))
            }
            (Self::Audiences(left), Self::Audiences(right)) => {
                Ok(Self::Audiences(left.intersection(right).cloned().collect()))
            }
            (Self::Resources(left), Self::Resources(right)) => {
                Ok(Self::Resources(meet_selectors(left, right)))
            }
            (Self::Assurance(left), Self::Assurance(right)) => {
                Ok(Self::Assurance(*left.max(right)))
            }
            (Self::NotAfter(left), Self::NotAfter(right)) => Ok(Self::NotAfter(*left.min(right))),
            (Self::InvokeLevel(left), Self::InvokeLevel(right)) => {
                Ok(Self::InvokeLevel(*left.min(right)))
            }
            (Self::RawExport(left), Self::RawExport(right)) => Ok(Self::RawExport(*left && *right)),
            (left, right) => Err(PolicyFault::ConditionKindMismatch {
                left: left.kind(),
                right: right.kind(),
            }),
        }
    }
}

/// Keep the selectors each side already covers, from both sides.
fn meet_selectors(left: &BTreeSet<String>, right: &BTreeSet<String>) -> BTreeSet<String> {
    let covered = |selector: &String, side: &BTreeSet<String>| {
        resources_attenuate(
            std::slice::from_ref(selector),
            &side.iter().cloned().collect::<Vec<_>>(),
        )
    };
    left.iter()
        .filter(|selector| covered(selector, right))
        .chain(right.iter().filter(|selector| covered(selector, left)))
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn actions(names: &[&str]) -> Condition {
        Condition::Actions(names.iter().map(|n| (*n).to_owned()).collect())
    }

    #[test]
    fn an_unknown_kind_or_assurance_is_a_fault_not_a_default() {
        assert!(matches!(
            ConditionKind::parse("whatever"),
            Err(PolicyFault::Unknown(UnknownTerm::ConditionKind(_)))
        ));
        // The bug this replaces: rank(unknown) == 0, so an unrecognized
        // required_assurance compared equal to holding nothing at all.
        assert!(matches!(
            AssuranceLevel::parse("quantum-resistant"),
            Err(PolicyFault::Unknown(UnknownTerm::AssuranceLevel(_)))
        ));
    }

    #[test]
    fn narrowing_is_reflexive_and_a_meet_narrows_both_sides() {
        let parent = actions(&["read", "write"]);
        let child = actions(&["read"]);
        assert!(parent.narrows(&parent).unwrap());
        assert!(child.narrows(&parent).unwrap());
        assert!(!parent.narrows(&child).unwrap());
        let meet = parent.meet(&child).unwrap();
        assert!(meet.narrows(&parent).unwrap());
        assert!(meet.narrows(&child).unwrap());
        assert_eq!(meet, child);
    }

    #[test]
    fn a_meet_across_kinds_is_refused_rather_than_resolved() {
        let fault = actions(&["read"])
            .meet(&Condition::RawExport(false))
            .unwrap_err();
        assert!(matches!(
            fault,
            PolicyFault::ConditionKindMismatch {
                left: ConditionKind::Actions,
                right: ConditionKind::RawExport
            }
        ));
        assert!(actions(&["read"])
            .narrows(&Condition::RawExport(true))
            .is_err());
    }

    #[test]
    fn an_empty_action_set_permits_nothing_rather_than_everything() {
        let empty = actions(&[]);
        assert!(empty.narrows(&actions(&["read"])).unwrap());
        assert_eq!(empty.meet(&actions(&["read"])).unwrap(), empty);
    }
}
