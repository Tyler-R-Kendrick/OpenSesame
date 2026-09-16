//! How layer verdicts become one decision (POL-COMBINE).
//!
//! The engine asks several independent questions — is the authority plane
//! reachable, does a relationship exist, does the grant cover this, do its
//! conditions hold, is there evidence for what it requires — and a decision is
//! the combination of those answers. The combining rule is deny-overrides with
//! a closed world:
//!
//! 1. any [`Effect::Deny`] denies;
//! 2. any [`Effect::Indeterminate`] denies, carrying the fault — a layer that
//!    could not evaluate has not permitted;
//! 3. no [`Effect::Permit`] at all denies with [`PolicyFault::NoApplicableRule`],
//!    because "no rule matched" is not "allowed";
//! 4. otherwise permit, carrying the union of every permitting layer's
//!    obligations.
//!
//! Rule 3 is the one worth stating out loud: the previous shape returned a
//! permit as the fall-through of a function whose early returns were all
//! denials, so a request that no layer recognized was allowed by omission.
//!
//! Which refusal a denial *reports* is decided by layer rank, not by argument
//! order, so the same set of verdicts always produces the same explanation. The
//! earliest-ranked refusal wins whether it is a denial or a fault: an
//! unreachable authority plane is the answer even when a later layer would also
//! have objected, because "come back when the authority is up" and "you may not
//! do this" are different things to be told.

use crate::error::{DenyReason, PolicyFault};
use crate::AuthZenObligation;
use std::collections::HashSet;

/// A single layer's answer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Effect {
    Permit,
    Deny,
    /// The layer could not evaluate. Combines as a denial.
    Indeterminate,
    /// The layer had nothing to say about this request.
    NotApplicable,
}

impl Effect {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Permit => "permit",
            Self::Deny => "deny",
            Self::Indeterminate => "indeterminate",
            Self::NotApplicable => "not_applicable",
        }
    }
}

/// The independent questions a decision is made of.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum PolicyLayer {
    Availability,
    Relationship,
    Lineage,
    GrantAuthority,
    Conditions,
    Evidence,
    Executability,
}

impl PolicyLayer {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Availability => "availability",
            Self::Relationship => "relationship",
            Self::Lineage => "lineage",
            Self::GrantAuthority => "grant_authority",
            Self::Conditions => "conditions",
            Self::Evidence => "evidence",
            Self::Executability => "executability",
        }
    }

    /// Precedence for choosing the decisive reason. Lower decides first.
    #[must_use]
    pub fn rank(self) -> u8 {
        match self {
            Self::Availability => 0,
            Self::Relationship => 1,
            Self::Lineage => 2,
            Self::GrantAuthority => 3,
            Self::Conditions => 4,
            Self::Evidence => 5,
            Self::Executability => 6,
        }
    }
}

/// One layer's verdict, with the obligations it attaches when it permits.
#[derive(Clone, Debug)]
pub struct LayerOutcome {
    pub layer: PolicyLayer,
    pub effect: Effect,
    pub reason: Option<DenyReason>,
    pub obligations: Vec<AuthZenObligation>,
}

impl LayerOutcome {
    #[must_use]
    pub fn permit(layer: PolicyLayer) -> Self {
        Self {
            layer,
            effect: Effect::Permit,
            reason: None,
            obligations: vec![],
        }
    }

    #[must_use]
    pub fn permit_with(layer: PolicyLayer, obligations: Vec<AuthZenObligation>) -> Self {
        Self {
            layer,
            effect: Effect::Permit,
            reason: None,
            obligations,
        }
    }

    #[must_use]
    pub fn deny(layer: PolicyLayer, reason: DenyReason) -> Self {
        Self {
            layer,
            effect: Effect::Deny,
            reason: Some(reason),
            obligations: vec![],
        }
    }

    /// A layer that could not evaluate. Combines as a denial, keeping the fault.
    #[must_use]
    pub fn fault(layer: PolicyLayer, fault: PolicyFault) -> Self {
        Self {
            layer,
            effect: Effect::Indeterminate,
            reason: Some(DenyReason::Fault(fault)),
            obligations: vec![],
        }
    }

    #[must_use]
    pub fn not_applicable(layer: PolicyLayer) -> Self {
        Self {
            layer,
            effect: Effect::NotApplicable,
            reason: None,
            obligations: vec![],
        }
    }
}

/// The combined decision. Only ever [`Effect::Permit`] or [`Effect::Deny`].
#[derive(Clone, Debug)]
pub struct Combination {
    effect: Effect,
    reason: Option<DenyReason>,
    obligations: Vec<AuthZenObligation>,
    outcomes: Vec<LayerOutcome>,
}

impl Combination {
    #[must_use]
    pub fn permitted(&self) -> bool {
        self.effect == Effect::Permit
    }

    #[must_use]
    pub fn effect(&self) -> Effect {
        self.effect
    }

    #[must_use]
    pub fn reason(&self) -> Option<&DenyReason> {
        self.reason.as_ref()
    }

    #[must_use]
    pub fn obligations(&self) -> &[AuthZenObligation] {
        &self.obligations
    }

    /// Layer verdicts in precedence order.
    #[must_use]
    pub fn outcomes(&self) -> &[LayerOutcome] {
        &self.outcomes
    }
}

/// Combine layer verdicts: deny-overrides, closed world, fail-closed on faults.
#[must_use]
pub fn deny_overrides(outcomes: Vec<LayerOutcome>) -> Combination {
    let mut ordered = outcomes;
    ordered.sort_by_key(|outcome| outcome.layer.rank());

    if let Some(reason) = decisive_refusal(&ordered) {
        return denied(reason, ordered);
    }
    if !ordered
        .iter()
        .any(|outcome| outcome.effect == Effect::Permit)
    {
        return denied(DenyReason::Fault(PolicyFault::NoApplicableRule), ordered);
    }
    let obligations = union_obligations(&ordered);
    Combination {
        effect: Effect::Permit,
        reason: None,
        obligations,
        outcomes: ordered,
    }
}

/// The earliest-ranked layer that refused, denial or fault alike.
fn decisive_refusal(ordered: &[LayerOutcome]) -> Option<DenyReason> {
    ordered
        .iter()
        .find(|outcome| matches!(outcome.effect, Effect::Deny | Effect::Indeterminate))
        .map(|outcome| {
            outcome
                .reason
                .clone()
                .unwrap_or(DenyReason::Fault(PolicyFault::NoApplicableRule))
        })
}

fn denied(reason: DenyReason, outcomes: Vec<LayerOutcome>) -> Combination {
    Combination {
        effect: Effect::Deny,
        reason: Some(reason),
        // A denial carries no obligations: there is nothing to discharge.
        obligations: vec![],
        outcomes,
    }
}

/// Every permitting layer's obligations, in layer order, deduplicated.
///
/// Dropping one would turn "permitted, and you must write a signed receipt"
/// into "permitted".
fn union_obligations(ordered: &[LayerOutcome]) -> Vec<AuthZenObligation> {
    let mut seen = HashSet::new();
    let mut union = Vec::new();
    for outcome in ordered
        .iter()
        .filter(|outcome| outcome.effect == Effect::Permit)
    {
        for obligation in &outcome.obligations {
            let key = format!("{}|{}", obligation.id, obligation.attributes);
            if seen.insert(key) {
                union.push(obligation.clone());
            }
        }
    }
    union
}
