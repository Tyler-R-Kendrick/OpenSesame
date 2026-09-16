//! Typed refusals (POL-ERROR).
//!
//! A denial used to be a bare string dropped into a decision's JSON context.
//! Nothing checked the spelling, nothing enumerated the set, and an
//! unrecognized term simply did not appear — which is how "the engine could
//! not evaluate this" and "the engine evaluated this and it was fine" ended up
//! looking identical from the outside.
//!
//! There are two kinds of refusal here and they are deliberately different
//! types. A [`DenyReason`] is a decision: policy was evaluated and refused.
//! A [`PolicyFault`] is the absence of a decision: a term the engine does not
//! know, evidence it does not hold, an authority it cannot reach. A fault is
//! never a permit — it resolves to a denial carrying the fault as its reason,
//! because a rule that could not be evaluated has not been satisfied.

use crate::{ConditionKind, RequirementKind};
use std::fmt;

/// Longest reason detail any explanation will carry.
pub const MAX_DETAIL_LENGTH: usize = 128;

/// A term the engine was asked to evaluate and does not recognize.
///
/// Every variant exists because the alternative was a silent default: an
/// unknown resource type used to fall through to a guessed relation, and an
/// unknown assurance level used to rank as zero — which made
/// `required_assurance: "quantum-resistant"` *weaker* than a password.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum UnknownTerm {
    ResourceType(String),
    Action(String),
    ConditionKind(String),
    AssuranceLevel(String),
}

impl UnknownTerm {
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            Self::ResourceType(_) => "unknown_resource_type",
            Self::Action(_) => "unknown_action",
            Self::ConditionKind(_) => "unknown_condition_kind",
            Self::AssuranceLevel(_) => "unknown_assurance_level",
        }
    }

    /// The offending term, sanitized for a log line or a receipt.
    #[must_use]
    pub fn term(&self) -> String {
        match self {
            Self::ResourceType(t)
            | Self::Action(t)
            | Self::ConditionKind(t)
            | Self::AssuranceLevel(t) => sanitize_term(t),
        }
    }
}

impl fmt::Display for UnknownTerm {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code(), self.term())
    }
}

/// Why the engine could not reach a verdict. Resolves to a denial, never a permit.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PolicyFault {
    /// A vocabulary term outside the closed set.
    Unknown(UnknownTerm),
    /// Two conditions of different kinds were combined; there is no such meet.
    ConditionKindMismatch {
        left: ConditionKind,
        right: ConditionKind,
    },
    /// Policy states a requirement and the engine holds no evidence of its kind.
    MissingEvidence(RequirementKind),
    /// Evidence exists but is older than policy allows.
    StaleEvidence(RequirementKind),
    /// Evidence exists and is current but does not reach the required strength.
    WeakEvidence(RequirementKind),
    /// Nothing in the policy set applied to this request. A closed world denies.
    NoApplicableRule,
    /// The authority plane could not be consulted for a class that requires it.
    AuthorityUnavailable,
}

impl PolicyFault {
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            Self::Unknown(term) => term.code(),
            Self::ConditionKindMismatch { .. } => "condition_kind_mismatch",
            Self::MissingEvidence(_) => "evidence_missing",
            Self::StaleEvidence(_) => "evidence_stale",
            Self::WeakEvidence(_) => "evidence_weak",
            Self::NoApplicableRule => "no_applicable_rule",
            Self::AuthorityUnavailable => "authority_unavailable",
        }
    }

    /// Sanitized, value-blind detail: a term or a kind name, never a held value.
    #[must_use]
    pub fn detail(&self) -> Option<String> {
        match self {
            Self::Unknown(term) => Some(term.term()),
            Self::ConditionKindMismatch { left, right } => {
                Some(format!("{}/{}", left.as_str(), right.as_str()))
            }
            Self::MissingEvidence(kind) | Self::StaleEvidence(kind) | Self::WeakEvidence(kind) => {
                Some(kind.as_str().to_owned())
            }
            Self::NoApplicableRule | Self::AuthorityUnavailable => None,
        }
    }
}

impl fmt::Display for PolicyFault {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.detail() {
            Some(detail) => write!(f, "{}: {detail}", self.code()),
            None => write!(f, "{}", self.code()),
        }
    }
}

/// Why a request was refused. A closed set with stable codes.
///
/// The codes for the pre-existing denials are the strings the decision context
/// already carried (`relationship`, `grant_action`, …), so receipts and
/// dashboards written against them keep working; what changed is that they are
/// now produced from one vocabulary instead of typed out at each call site.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DenyReason {
    Relationship,
    GrantMissing,
    GrantAction(String),
    GrantResource(String),
    Audience(String),
    ExportDefaultDeny,
    DiscoveryNotExecute,
    /// A typed condition the request did not satisfy — or could not be checked
    /// against, because the request stated no value of that kind.
    Condition(ConditionKind),
    /// A stated requirement that the held evidence did not satisfy.
    Requirement(RequirementKind),
    /// The leaf grant claims authority no ancestor in its lineage held.
    LineageWidened(ConditionKind),
    /// Lineage was presented that does not bind the grant the caller presented.
    LineageUnbound,
    Fault(PolicyFault),
}

impl DenyReason {
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            Self::Relationship => "relationship",
            Self::GrantMissing => "grant_missing",
            Self::GrantAction(_) => "grant_action",
            Self::GrantResource(_) => "grant_resource",
            Self::Audience(_) => "audience",
            Self::ExportDefaultDeny => "export_default_deny",
            Self::DiscoveryNotExecute => "discovery_not_execute",
            Self::Condition(_) => "condition_unsatisfied",
            Self::Requirement(_) => "requirement_unsatisfied",
            Self::LineageWidened(_) => "lineage_widened",
            Self::LineageUnbound => "lineage_unbound",
            Self::Fault(fault) => fault.code(),
        }
    }

    /// Sanitized detail. Carries the term the *request* named or the kind that
    /// failed — never a held credential, an assurance the caller holds, or any
    /// part of the request's client-authored properties.
    #[must_use]
    pub fn detail(&self) -> Option<String> {
        match self {
            Self::GrantAction(term) | Self::GrantResource(term) | Self::Audience(term) => {
                Some(sanitize_term(term))
            }
            Self::Condition(kind) | Self::LineageWidened(kind) => Some(kind.as_str().to_owned()),
            Self::Requirement(kind) => Some(kind.as_str().to_owned()),
            Self::Fault(fault) => fault.detail(),
            Self::Relationship
            | Self::GrantMissing
            | Self::ExportDefaultDeny
            | Self::DiscoveryNotExecute
            | Self::LineageUnbound => None,
        }
    }

    /// The fault behind this denial, when the denial was an inability to decide.
    #[must_use]
    pub fn fault(&self) -> Option<&PolicyFault> {
        match self {
            Self::Fault(fault) => Some(fault),
            _ => None,
        }
    }
}

impl From<PolicyFault> for DenyReason {
    fn from(fault: PolicyFault) -> Self {
        Self::Fault(fault)
    }
}

impl From<UnknownTerm> for DenyReason {
    fn from(term: UnknownTerm) -> Self {
        Self::Fault(PolicyFault::Unknown(term))
    }
}

impl fmt::Display for DenyReason {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.detail() {
            Some(detail) => write!(f, "{}: {detail}", self.code()),
            None => write!(f, "{}", self.code()),
        }
    }
}

/// Bound and de-fang a term that came off the wire before it is explained.
///
/// A request may name a 40kB action with newlines in it. That string ends up in
/// a log line, a receipt summary and an explanation, so it is truncated on a
/// character boundary and stripped of control characters first.
#[must_use]
pub fn sanitize_term(term: &str) -> String {
    let cleaned: String = term
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .take(MAX_DETAIL_LENGTH)
        .collect();
    cleaned
}
