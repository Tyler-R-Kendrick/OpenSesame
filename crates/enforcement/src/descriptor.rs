//! The descriptor: every dimension, answered once, or refused by name.
//!
//! An [`EnforcementDescriptor`] is what an adapter publishes about itself. It
//! is built through [`EnforcementDescriptor::builder`], and building it runs
//! [`crate::conformance::audit`] — so a descriptor that exists has already
//! answered every dimension and has already been checked for the claims a
//! platform cannot make. There is no constructor that skips that.

use crate::conformance::{audit, ConformanceViolation};
use crate::dimension::Dimension;
use crate::guarantee::Guarantee;
use crate::ownership::SubjectSurface;
use crate::unsupported::{Unsupported, UnsupportedResponse};
use serde::Serialize;

/// Whether there is code behind this descriptor at all.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum AdapterStatus {
    /// An adapter exists. `module` names where it lives so a reader can check
    /// the claims against the code.
    Implemented {
        /// Path or crate of the implementing code.
        module: &'static str,
    },
    /// No adapter exists. Every dimension must then be unsupported — see
    /// [`ConformanceViolation::AbsentAdapterClaimsEnforcement`].
    Absent,
}

impl AdapterStatus {
    /// Whether an implementation exists.
    #[must_use]
    pub const fn is_implemented(self) -> bool {
        matches!(self, Self::Implemented { .. })
    }
}

/// A dimension's answer: real code, or a named absence.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "coverage", rename_all = "snake_case")]
pub enum Coverage {
    /// Something enforces this.
    Enforced(Guarantee),
    /// Nothing does, and here is why.
    Unsupported(Unsupported),
}

impl Coverage {
    /// The guarantee, where there is one.
    #[must_use]
    pub const fn guarantee(&self) -> Option<&Guarantee> {
        match self {
            Self::Enforced(guarantee) => Some(guarantee),
            Self::Unsupported(_) => None,
        }
    }

    /// The absence, where that is the answer.
    #[must_use]
    pub const fn unsupported(&self) -> Option<&Unsupported> {
        match self {
            Self::Unsupported(unsupported) => Some(unsupported),
            Self::Enforced(_) => None,
        }
    }
}

/// One dimension paired with its answer. The descriptor holds one per
/// dimension, in [`Dimension::ALL`] order, so lookup cannot miss and
/// serialization is stable.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct DimensionCoverage {
    /// The axis.
    pub dimension: Dimension,
    /// The answer.
    pub coverage: Coverage,
}

/// What a platform and surface actually hold, dimension by dimension.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct EnforcementDescriptor {
    platform: &'static str,
    surface: SubjectSurface,
    adapter: AdapterStatus,
    coverage: [DimensionCoverage; Dimension::ALL.len()],
}

impl EnforcementDescriptor {
    /// Start describing a platform.
    #[must_use]
    pub const fn builder(
        platform: &'static str,
        surface: SubjectSurface,
        adapter: AdapterStatus,
    ) -> DescriptorBuilder {
        DescriptorBuilder {
            platform,
            surface,
            adapter,
            answers: [None; Dimension::ALL.len()],
        }
    }

    /// The platform identifier.
    #[must_use]
    pub const fn platform(&self) -> &'static str {
        self.platform
    }

    /// The surface the subject runs on.
    #[must_use]
    pub const fn surface(&self) -> SubjectSurface {
        self.surface
    }

    /// Whether there is code behind this, and where.
    #[must_use]
    pub const fn adapter(&self) -> AdapterStatus {
        self.adapter
    }

    /// This dimension's answer. Infallible: a built descriptor answers all of
    /// them.
    #[must_use]
    pub fn coverage(&self, dimension: Dimension) -> &Coverage {
        &self.coverage[index_of(dimension)].coverage
    }

    /// Every answer, in [`Dimension::ALL`] order.
    #[must_use]
    pub const fn coverages(&self) -> &[DimensionCoverage] {
        &self.coverage
    }

    /// The guarantee for this dimension, where there is one.
    #[must_use]
    pub fn guarantee(&self, dimension: Dimension) -> Option<&Guarantee> {
        self.coverage(dimension).guarantee()
    }

    /// The machine-readable absence for this dimension, where that is the
    /// answer.
    #[must_use]
    pub fn unsupported(&self, dimension: Dimension) -> Option<UnsupportedResponse> {
        self.coverage(dimension).unsupported().map(|unsupported| {
            UnsupportedResponse::assemble(self.platform, self.surface, dimension, *unsupported)
        })
    }

    /// Every unsupported dimension, ready to hand back to a caller.
    #[must_use]
    pub fn unsupported_dimensions(&self) -> Vec<UnsupportedResponse> {
        Dimension::ALL
            .iter()
            .filter_map(|dimension| self.unsupported(*dimension))
            .collect()
    }
}

const fn index_of(dimension: Dimension) -> usize {
    match dimension {
        Dimension::Expiry => 0,
        Dimension::Termination => 1,
        Dimension::Isolation => 2,
    }
}

/// Collects one answer per dimension. [`DescriptorBuilder::build`] is the only
/// way to obtain an [`EnforcementDescriptor`].
#[derive(Clone, Copy, Debug)]
pub struct DescriptorBuilder {
    platform: &'static str,
    surface: SubjectSurface,
    adapter: AdapterStatus,
    answers: [Option<Coverage>; Dimension::ALL.len()],
}

impl DescriptorBuilder {
    /// Answer one dimension with a guarantee.
    #[must_use]
    pub const fn enforced(self, dimension: Dimension, guarantee: Guarantee) -> Self {
        self.answer(dimension, Coverage::Enforced(guarantee))
    }

    /// Answer one dimension by naming why nothing enforces it.
    #[must_use]
    pub const fn unsupported(self, dimension: Dimension, unsupported: Unsupported) -> Self {
        self.answer(dimension, Coverage::Unsupported(unsupported))
    }

    /// Answer one dimension. A second answer for the same dimension replaces
    /// the first — the audit is what judges the final set.
    #[must_use]
    pub const fn answer(mut self, dimension: Dimension, coverage: Coverage) -> Self {
        self.answers[index_of(dimension)] = Some(coverage);
        self
    }

    /// Check the answers and freeze them.
    ///
    /// # Errors
    ///
    /// Every [`ConformanceViolation`] found, rather than the first: an adapter
    /// author fixing one claim should see the rest in the same run.
    pub fn build(self) -> Result<EnforcementDescriptor, Vec<ConformanceViolation>> {
        let mut unanswered = Vec::new();
        let mut coverage = Vec::with_capacity(Dimension::ALL.len());
        for dimension in Dimension::ALL {
            match self.answers[index_of(dimension)] {
                Some(answer) => coverage.push(DimensionCoverage {
                    dimension,
                    coverage: answer,
                }),
                None => unanswered.push(ConformanceViolation::DimensionUnanswered { dimension }),
            }
        }
        if !unanswered.is_empty() {
            return Err(unanswered);
        }
        let frozen = [coverage[0], coverage[1], coverage[2]];
        let descriptor = EnforcementDescriptor {
            platform: self.platform,
            surface: self.surface,
            adapter: self.adapter,
            coverage: frozen,
        };
        audit(&descriptor)?;
        Ok(descriptor)
    }
}

#[cfg(test)]
mod tests {
    use super::{AdapterStatus, EnforcementDescriptor};
    use crate::conformance::ConformanceViolation;
    use crate::dimension::Dimension;
    use crate::guarantee::{Bypass, Guarantee, Latency, Mechanism, Observability, Survival};
    use crate::ownership::{EnforcementPoint, SubjectSurface};
    use crate::unsupported::{Remedy, Unsupported, UnsupportedReason};

    fn absent() -> Unsupported {
        Unsupported::new(
            UnsupportedReason::NoAdapter,
            Remedy::NoneKnown,
            "no adapter",
        )
    }

    #[test]
    fn a_dimension_left_out_is_not_a_descriptor() {
        // The reason `Dimension` is a breaking change to extend: adding an
        // axis makes every existing platform fail to build until it answers.
        let error = EnforcementDescriptor::builder(
            "test",
            SubjectSurface::ForeignPlatformApp,
            AdapterStatus::Absent,
        )
        .unsupported(Dimension::Expiry, absent())
        .build()
        .expect_err("two dimensions unanswered");
        assert_eq!(
            error,
            vec![
                ConformanceViolation::DimensionUnanswered {
                    dimension: Dimension::Termination
                },
                ConformanceViolation::DimensionUnanswered {
                    dimension: Dimension::Isolation
                },
            ]
        );
    }

    #[test]
    fn a_built_descriptor_answers_every_dimension_without_an_unwrap() {
        let descriptor = EnforcementDescriptor::builder(
            "apple-ios",
            SubjectSurface::ForeignPlatformApp,
            AdapterStatus::Absent,
        )
        .unsupported(Dimension::Expiry, absent())
        .unsupported(Dimension::Termination, absent())
        .unsupported(Dimension::Isolation, absent())
        .build()
        .expect("an honestly empty descriptor is a valid one");
        for dimension in Dimension::ALL {
            assert!(descriptor.guarantee(dimension).is_none(), "{dimension:?}");
            let response = descriptor
                .unsupported(dimension)
                .expect("an absent adapter answers with a reason");
            assert_eq!(response.platform, "apple-ios");
            assert_eq!(response.dimension, dimension);
        }
        assert_eq!(descriptor.unsupported_dimensions().len(), 3);
    }

    #[test]
    fn a_later_answer_replaces_an_earlier_one_for_the_same_dimension() {
        let descriptor = EnforcementDescriptor::builder(
            "linux-host",
            SubjectSurface::BrokeredInvocation,
            AdapterStatus::Implemented {
                module: "crates/gateway",
            },
        )
        .unsupported(Dimension::Expiry, absent())
        .enforced(
            Dimension::Expiry,
            Guarantee::new(
                Mechanism::GrantExpiryCheck,
                EnforcementPoint::HostBroker,
                Bypass::DistinctAuthority,
                Latency::BeforeNextUse,
                Survival::ProcessRestart,
                Observability::Reported,
            ),
        )
        .enforced(
            Dimension::Termination,
            Guarantee::new(
                Mechanism::BrokerRefusal,
                EnforcementPoint::HostBroker,
                Bypass::DistinctAuthority,
                Latency::BeforeNextUse,
                Survival::ProcessRestart,
                Observability::Reported,
            ),
        )
        .enforced(
            Dimension::Isolation,
            Guarantee::new(
                Mechanism::EgressAllowlist,
                EnforcementPoint::NetworkBroker,
                Bypass::DistinctAuthority,
                Latency::BeforeNextUse,
                Survival::ProcessRestart,
                Observability::Reported,
            ),
        )
        .build()
        .expect("a consistent descriptor");
        assert_eq!(
            descriptor.guarantee(Dimension::Expiry).map(|g| g.mechanism),
            Some(Mechanism::GrantExpiryCheck)
        );
        assert!(descriptor.adapter().is_implemented());
    }
}
