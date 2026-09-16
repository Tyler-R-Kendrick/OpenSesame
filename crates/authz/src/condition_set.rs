//! A conjunction of typed conditions, and what a request has to look like to
//! satisfy one (POL-ALGEBRA, continued).
//!
//! A [`ConditionSet`] holds at most one condition per dimension, because two
//! restrictions along the same dimension are not two rules — they are one rule,
//! the narrower of the two. Inserting a second one takes the meet, so a set can
//! only ever get tighter, and a grant's set is derived from the grant rather
//! than authored beside it.
//!
//! The set is also where a chain's *effective* authority is computed. A
//! validated chain is attenuation-checked hop by hop, but the leaf is what a
//! caller presents, and reading authority off the leaf alone trusts every hop
//! in between to have been checked along every dimension.
//! [`ConditionSet::effective`] folds the whole chain instead, so the answer is
//! the intersection of what every ancestor allowed.

use crate::condition::{AssuranceLevel, Condition, ConditionKind};
use crate::error::{DenyReason, PolicyFault};
use chrono::{DateTime, Utc};
use opensesame_domain::ValidatedGrantChain;
use opensesame_domain::{grant_attenuation::resources_attenuate, Grant, InvokeLevel};
use std::collections::{BTreeMap, BTreeSet};

/// What the request says about the resource it names.
///
/// The two cases are not interchangeable and neither is a default. A connection
/// id is not a selector in the grant's resource grammar, so a request naming one
/// is [`Self::NotResourceScoped`] and is fenced by the relationship tuple and
/// the egress binding instead — that decision is stated here rather than implied
/// by a missing field.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ResourceFact<'a> {
    /// A resource id inside the grant's selector namespace.
    Named(&'a str),
    /// A resource whose id the grant's selectors do not describe.
    NotResourceScoped,
}

/// What the request states. Only stated facts; nothing inferred, nothing held.
#[derive(Clone, Copy, Debug)]
pub struct RequestFacts<'a> {
    pub action: &'a str,
    pub resource: ResourceFact<'a>,
    pub audience: Option<&'a str>,
    pub invoke_level: Option<InvokeLevel>,
    pub exports_raw_credential: bool,
    pub at: DateTime<Utc>,
}

/// A conjunction of conditions, at most one per dimension.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ConditionSet {
    by_kind: BTreeMap<ConditionKind, Condition>,
}

impl ConditionSet {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Add a restriction. An existing restriction of the same kind is met with
    /// the new one, so this never widens the set.
    ///
    /// # Errors
    ///
    /// Propagates a meet fault, rather than dropping one restriction in favour
    /// of the other.
    pub fn insert(&mut self, condition: Condition) -> Result<(), PolicyFault> {
        let kind = condition.kind();
        let merged = match self.by_kind.get(&kind) {
            Some(existing) => existing.meet(&condition)?,
            None => condition,
        };
        self.by_kind.insert(kind, merged);
        Ok(())
    }

    #[must_use]
    pub fn get(&self, kind: ConditionKind) -> Option<&Condition> {
        self.by_kind.get(&kind)
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.by_kind.is_empty()
    }

    /// True when every dimension `parent` restricts is restricted at least as
    /// tightly here. A dimension the parent restricts and this set omits is a
    /// widening, exactly as an omitted budget key is in the domain's
    /// attenuation rules.
    ///
    /// # Errors
    ///
    /// Propagates a fault from the underlying comparison.
    pub fn narrows(&self, parent: &Self) -> Result<bool, PolicyFault> {
        for (kind, condition) in &parent.by_kind {
            match self.by_kind.get(kind) {
                Some(mine) if mine.narrows(condition)? => {}
                _ => return Ok(false),
            }
        }
        Ok(true)
    }

    /// The conjunction of both sets: every dimension either restricts.
    ///
    /// # Errors
    ///
    /// Propagates a meet fault.
    pub fn meet(&self, other: &Self) -> Result<Self, PolicyFault> {
        let mut merged = self.clone();
        for condition in other.by_kind.values() {
            merged.insert(condition.clone())?;
        }
        Ok(merged)
    }

    /// Read a grant's own restrictions off the grant.
    ///
    /// # Errors
    ///
    /// Returns a fault when the grant names an assurance level outside the
    /// ladder — an unrecognized requirement is unsatisfiable, not absent.
    pub fn from_grant(grant: &Grant) -> Result<Self, PolicyFault> {
        let mut set = Self::new();
        // Both sets are inserted even when empty. A grant that names no actions
        // or no resources authorizes none of them, and omitting the dimension
        // would leave it unchecked instead.
        set.insert(Condition::Actions(names(&grant.actions)))?;
        set.insert(Condition::Resources(names(&grant.resources)))?;
        if !grant.constraints.audiences.is_empty() {
            set.insert(Condition::Audiences(names(&grant.constraints.audiences)))?;
        }
        if let Some(required) = &grant.constraints.required_assurance {
            set.insert(Condition::Assurance(AssuranceLevel::parse(required)?))?;
        }
        set.insert(Condition::NotAfter(grant.constraints.expires_at))?;
        set.insert(Condition::RawExport(
            grant.constraints.raw_credential_export,
        ))?;
        Ok(set)
    }

    /// The authority a whole validated chain actually leaves: the meet of every
    /// hop, root to leaf.
    ///
    /// # Errors
    ///
    /// Propagates a fault from any hop.
    pub fn effective(chain: &ValidatedGrantChain) -> Result<Self, PolicyFault> {
        let mut effective = Self::new();
        for grant in chain.grants() {
            effective = effective.meet(&Self::from_grant(grant)?)?;
        }
        Ok(effective)
    }

    /// The first dimension along which the chain's leaf claims more than its
    /// ancestors allowed, if any.
    ///
    /// # Errors
    ///
    /// Propagates a fault from any hop.
    pub fn lineage_widening(
        chain: &ValidatedGrantChain,
    ) -> Result<Option<ConditionKind>, PolicyFault> {
        let leaf = Self::from_grant(chain.leaf())?;
        let mut ancestors = Self::new();
        for grant in chain.grants().iter().rev().skip(1) {
            ancestors = ancestors.meet(&Self::from_grant(grant)?)?;
        }
        if ancestors.is_empty() {
            return Ok(None);
        }
        for (kind, condition) in &ancestors.by_kind {
            match leaf.get(*kind) {
                Some(mine) if mine.narrows(condition)? => {}
                _ => return Ok(Some(*kind)),
            }
        }
        Ok(None)
    }

    /// Check a request against every dimension in the set.
    ///
    /// The match is exhaustive over [`Condition`] on purpose: a new dimension
    /// cannot be added to the algebra without a decision being taken here, so no
    /// restriction can end up unenforced merely by being new.
    /// [`ConditionKind::Assurance`] is the one dimension a request cannot state
    /// — a caller asserting its own authenticator strength is not evidence of it
    /// — and it is settled by the evidence layer instead.
    ///
    /// # Errors
    ///
    /// Returns the typed reason for the first dimension the request fails.
    pub fn check(&self, facts: &RequestFacts<'_>) -> Result<(), DenyReason> {
        for condition in self.by_kind.values() {
            match condition {
                Condition::Actions(allowed) => check_action(allowed, facts.action)?,
                Condition::Resources(allowed) => check_resource(allowed, facts.resource)?,
                Condition::Audiences(allowed) => check_audience(allowed, facts.audience)?,
                Condition::NotAfter(deadline) => check_deadline(*deadline, facts.at)?,
                Condition::InvokeLevel(ceiling) => check_invoke_level(*ceiling, facts)?,
                Condition::RawExport(permitted) => check_export(*permitted, facts)?,
                Condition::Assurance(_) => {}
            }
        }
        Ok(())
    }
}

fn names(values: &[String]) -> BTreeSet<String> {
    values.iter().cloned().collect()
}

fn check_action(allowed: &BTreeSet<String>, action: &str) -> Result<(), DenyReason> {
    if allowed.contains(action) {
        return Ok(());
    }
    Err(DenyReason::GrantAction(action.to_owned()))
}

fn check_resource(
    allowed: &BTreeSet<String>,
    resource: ResourceFact<'_>,
) -> Result<(), DenyReason> {
    let ResourceFact::Named(id) = resource else {
        return Ok(());
    };
    let selectors: Vec<String> = allowed.iter().cloned().collect();
    if resources_attenuate(&[id.to_owned()], &selectors) {
        return Ok(());
    }
    Err(DenyReason::GrantResource(id.to_owned()))
}

fn check_audience(allowed: &BTreeSet<String>, audience: Option<&str>) -> Result<(), DenyReason> {
    // A stated restriction the request says nothing about is unsatisfied. The
    // engine used to skip the audience check when the context omitted one,
    // which turned "must be this audience" into "must be this audience unless
    // you decline to mention one".
    let Some(audience) = audience else {
        return Err(DenyReason::Condition(ConditionKind::Audiences));
    };
    if allowed.contains(audience) {
        return Ok(());
    }
    Err(DenyReason::Audience(audience.to_owned()))
}

fn check_deadline(deadline: DateTime<Utc>, at: DateTime<Utc>) -> Result<(), DenyReason> {
    if at <= deadline {
        return Ok(());
    }
    Err(DenyReason::Condition(ConditionKind::NotAfter))
}

fn check_invoke_level(ceiling: InvokeLevel, facts: &RequestFacts<'_>) -> Result<(), DenyReason> {
    let Some(level) = facts.invoke_level else {
        return Err(DenyReason::Condition(ConditionKind::InvokeLevel));
    };
    if level <= ceiling {
        return Ok(());
    }
    Err(DenyReason::Condition(ConditionKind::InvokeLevel))
}

fn check_export(permitted: bool, facts: &RequestFacts<'_>) -> Result<(), DenyReason> {
    if permitted || !facts.exports_raw_credential {
        return Ok(());
    }
    Err(DenyReason::ExportDefaultDeny)
}
