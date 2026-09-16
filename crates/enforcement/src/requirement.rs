//! What a grant needs, stated field by field so a refusal names the question
//! that failed.
//!
//! A requirement is deliberately the same shape as a [`Guarantee`] minus the
//! mechanism, because that is the only way to compare two guarantees without
//! inventing the scalar this crate refuses to have. A caller does not ask for
//! "hard" enforcement; it names four floors and whether the enforcing
//! component has to be outside the subject, and
//! [`crate::preflight::preflight`] checks them one at a time.
//!
//! Every field is a floor or a ceiling rather than a value, so a platform that
//! does better than asked is admitted. There is no field for the mechanism: a
//! caller that names the implementation has stopped stating a requirement and
//! started picking an adapter.
//!
//! The defaults are the weakest thing that can be said, with one exception.
//! [`Requirement::independent`] sets the bypass floor to
//! [`Bypass::LocalPrivilegeEscalation`], because demanding a point outside the
//! subject and then accepting a guarantee the subject can shrug off would make
//! the demand decorative — if getting out costs nothing, it does not matter
//! whose code was nominally in the way.

use crate::dimension::Dimension;
use crate::guarantee::{Bypass, Guarantee, Latency, Observability, Survival};
use serde::{Deserialize, Serialize};

/// What one dimension must hold to.
///
/// Read the fields as a sentence: this dimension must be enforced from outside
/// the subject (`independent_point`), arrive no later than `latency_ceiling`,
/// outlive at least `survival_floor`, cost at least `bypass_floor` to escape,
/// and be knowable at least as well as `observability_floor`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Requirement {
    /// The axis being demanded.
    pub dimension: Dimension,
    /// Whether the enforcing component must be outside the subject. A limit
    /// the subject administers for itself is a preference, and a caller that
    /// needs a fact says so here.
    pub independent_point: bool,
    /// The longest the effect may take to arrive.
    pub latency_ceiling: Latency,
    /// The least the guarantee must outlive.
    pub survival_floor: Survival,
    /// The least it must cost the subject to get out from under it.
    pub bypass_floor: Bypass,
    /// The least we must be able to learn about whether it took effect.
    pub observability_floor: Observability,
}

impl Requirement {
    /// Demand only that something covers the dimension, wherever it lives.
    ///
    /// The honest floor for a cooperative limit that is still worth having —
    /// a runtime that declines to do the thing catches honest mistakes. It is
    /// not what a grant asks for; see [`Self::independent`].
    #[must_use]
    pub const fn covered(dimension: Dimension) -> Self {
        Self {
            dimension,
            independent_point: false,
            latency_ceiling: Latency::Unbounded,
            survival_floor: Survival::ProcessLifetime,
            bypass_floor: Bypass::TrivialForSubject,
            observability_floor: Observability::Unobservable,
        }
    }

    /// Demand that something *outside the subject* covers the dimension.
    ///
    /// Carries a [`Bypass::LocalPrivilegeEscalation`] floor with it: an
    /// independent point the subject can walk away from for free is not a
    /// boundary, whoever owns the code.
    #[must_use]
    pub const fn independent(dimension: Dimension) -> Self {
        Self {
            independent_point: true,
            bypass_floor: Bypass::LocalPrivilegeEscalation,
            ..Self::covered(dimension)
        }
    }

    /// Set the latency ceiling.
    #[must_use]
    pub const fn arriving_within(mut self, latency: Latency) -> Self {
        self.latency_ceiling = latency;
        self
    }

    /// Set the survival floor.
    #[must_use]
    pub const fn surviving(mut self, survival: Survival) -> Self {
        self.survival_floor = survival;
        self
    }

    /// Set the bypass floor.
    #[must_use]
    pub const fn bypass_at_least(mut self, bypass: Bypass) -> Self {
        self.bypass_floor = bypass;
        self
    }

    /// Set the observability floor.
    #[must_use]
    pub const fn observed_at_least(mut self, observability: Observability) -> Self {
        self.observability_floor = observability;
        self
    }

    /// Whether `guarantee` meets every part of this requirement.
    ///
    /// Preflight does not call this: it needs to know *which* parts failed, and
    /// a boolean would throw that away. It is here for a caller comparing
    /// candidate platforms, where the only question is whether each would do.
    #[must_use]
    pub fn met_by(&self, guarantee: &Guarantee) -> bool {
        (!self.independent_point || guarantee.point.independent_of_subject())
            && guarantee.latency.within(self.latency_ceiling)
            && guarantee.survival.at_least(self.survival_floor)
            && guarantee.bypass.at_least(self.bypass_floor)
            && guarantee.observability.at_least(self.observability_floor)
    }
}

/// The demands a grant makes, at most one per dimension.
///
/// A dimension with no requirement is not "satisfied by default" — it is not
/// asked about, and preflight skips it. That is the difference between a grant
/// that permits raw credential export (which has said the value may leave, so
/// it demands no isolation) and one that asks for isolation and gets none.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Requirements {
    stated: Vec<Requirement>,
}

impl Requirements {
    /// Demand nothing yet.
    #[must_use]
    pub const fn none() -> Self {
        Self { stated: Vec::new() }
    }

    /// Add a dimension's demand, replacing any earlier demand on the same
    /// axis. Last statement wins, so a caller may take a derived set and
    /// tighten one dimension without rebuilding it.
    #[must_use]
    pub fn require(mut self, requirement: Requirement) -> Self {
        self.stated
            .retain(|stated| stated.dimension != requirement.dimension);
        self.stated.push(requirement);
        self
    }

    /// One dimension's demand, if it was made.
    #[must_use]
    pub fn get(&self, dimension: Dimension) -> Option<Requirement> {
        self.stated
            .iter()
            .find(|requirement| requirement.dimension == dimension)
            .copied()
    }

    /// Every demand, in the order it was stated.
    #[must_use]
    pub fn stated(&self) -> &[Requirement] {
        &self.stated
    }

    /// The axes demanded, in [`Dimension::ALL`] order.
    #[must_use]
    pub fn dimensions(&self) -> Vec<Dimension> {
        Dimension::ALL
            .into_iter()
            .filter(|dimension| self.get(*dimension).is_some())
            .collect()
    }

    /// Whether anything is demanded at all.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.stated.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::{Requirement, Requirements};
    use crate::dimension::Dimension;
    use crate::guarantee::{Bypass, Guarantee, Latency, Mechanism, Observability, Survival};
    use crate::ownership::EnforcementPoint;

    fn cooperative() -> Guarantee {
        Guarantee::new(
            Mechanism::OsSandbox,
            EnforcementPoint::SubjectRuntime,
            Bypass::TrivialForSubject,
            Latency::WithinSeconds(60),
            Survival::ProcessLifetime,
            Observability::Inferred,
        )
    }

    fn brokered() -> Guarantee {
        Guarantee::new(
            Mechanism::EgressAllowlist,
            EnforcementPoint::NetworkBroker,
            Bypass::DistinctAuthority,
            Latency::BeforeNextUse,
            Survival::ProcessRestart,
            Observability::Reported,
        )
    }

    #[test]
    fn demanding_an_independent_point_carries_a_bypass_floor_with_it() {
        // Otherwise the demand is decorative: it would not matter whose code
        // was nominally in the way if getting out cost the subject nothing.
        let requirement = Requirement::independent(Dimension::Isolation);
        assert!(requirement.independent_point);
        assert_eq!(requirement.bypass_floor, Bypass::LocalPrivilegeEscalation);
        assert!(!requirement.met_by(&cooperative()));
        assert!(requirement.met_by(&brokered()));
    }

    #[test]
    fn a_covered_requirement_admits_a_cooperative_limit() {
        // A limit the subject keeps for itself is still worth having; it is
        // just not the same kind of fact, and `covered` is how a caller says
        // it will take either.
        let requirement = Requirement::covered(Dimension::Isolation);
        assert!(!requirement.independent_point);
        assert_eq!(requirement.bypass_floor, Bypass::TrivialForSubject);
        assert!(requirement.met_by(&cooperative()));
        assert!(requirement.met_by(&brokered()));
    }

    #[test]
    fn the_default_floors_are_the_weakest_thing_that_can_be_said() {
        let requirement = Requirement::covered(Dimension::Expiry);
        assert_eq!(requirement.latency_ceiling, Latency::Unbounded);
        assert_eq!(requirement.survival_floor, Survival::ProcessLifetime);
        assert_eq!(requirement.observability_floor, Observability::Unobservable);
    }

    #[test]
    fn each_floor_is_checked_on_its_own() {
        let brokered = brokered();
        assert!(!Requirement::covered(Dimension::Isolation)
            .surviving(Survival::NetworkPartition)
            .met_by(&brokered));
        assert!(Requirement::covered(Dimension::Isolation)
            .observed_at_least(Observability::Reported)
            .met_by(&brokered));
        assert!(!Requirement::covered(Dimension::Isolation)
            .observed_at_least(Observability::Reported)
            .met_by(&cooperative()));
        // A guarantee with no window meets any ceiling, including a zero one:
        // there is nothing in flight to be late.
        assert!(Requirement::covered(Dimension::Isolation)
            .arriving_within(Latency::WithinSeconds(0))
            .met_by(&brokered));
        assert!(!Requirement::covered(Dimension::Isolation)
            .arriving_within(Latency::WithinSeconds(30))
            .met_by(&cooperative()));
    }

    #[test]
    fn a_dimension_can_be_tightened_without_rebuilding_the_set() {
        let base = Requirements::none()
            .require(Requirement::covered(Dimension::Expiry))
            .require(Requirement::covered(Dimension::Termination));
        let tightened = base
            .clone()
            .require(Requirement::independent(Dimension::Expiry));
        // Replaced, not appended: one demand per axis.
        assert_eq!(tightened.stated().len(), 2);
        assert!(
            tightened
                .get(Dimension::Expiry)
                .expect("expiry is demanded")
                .independent_point
        );
        assert!(
            !base
                .get(Dimension::Expiry)
                .expect("expiry is demanded")
                .independent_point
        );
    }

    #[test]
    fn a_dimension_nobody_asked_about_is_absent_rather_than_satisfied() {
        let requirements = Requirements::none().require(Requirement::covered(Dimension::Expiry));
        assert!(requirements.get(Dimension::Isolation).is_none());
        assert_eq!(requirements.dimensions(), vec![Dimension::Expiry]);
        assert!(!requirements.is_empty());
        assert!(Requirements::none().is_empty());
        assert!(Requirements::none().dimensions().is_empty());
    }

    #[test]
    fn dimensions_are_reported_in_a_stable_order_whatever_order_they_arrived() {
        let requirements = Requirements::none()
            .require(Requirement::covered(Dimension::Isolation))
            .require(Requirement::covered(Dimension::Expiry));
        assert_eq!(
            requirements.dimensions(),
            vec![Dimension::Expiry, Dimension::Isolation]
        );
        // `stated` keeps arrival order; `dimensions` is canonical.
        assert_eq!(requirements.stated()[0].dimension, Dimension::Isolation);
    }
}
