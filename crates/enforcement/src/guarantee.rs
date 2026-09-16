//! One dimension's answer, as a record rather than a grade.
//!
//! A [`Guarantee`] is five independent facts plus the mechanism that produces
//! them. None of the five is derivable from the others, which is the argument
//! against the scalar this crate replaces: "hard" was being used to mean *any*
//! of "the subject cannot defeat it", "it takes effect at once", "it outlives a
//! reboot", and "we can see that it happened", and a caller who needed one of
//! those got whichever the adapter author had in mind.
//!
//! The individual fields *are* ordered — a bypass needing a distinct authority
//! really is harder than one needing nothing — and [`crate::requirement`]
//! compares them one at a time. What has no order is the guarantee as a whole,
//! and there is no method here that returns a score.

use crate::dimension::Dimension;
use crate::ownership::EnforcementPoint;
use serde::{Deserialize, Serialize};

/// The concrete thing that does the enforcing.
///
/// A closed catalogue: an adapter describes itself by naming one of these, so a
/// reader can go find the code. Free text here would let an adapter invent a
/// mechanism that sounds like enforcement and is a comment.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Mechanism {
    /// The broker re-reads the grant's deadline on every authorize.
    GrantExpiryCheck,
    /// The provider issued a short-lived token and will stop honouring it.
    ProviderTokenTtl,
    /// A broker-held lease that lapses on its own and can also be pulled.
    BrokerLeaseExpiry,
    /// The provider's revocation endpoint or session kill.
    ProviderRevocation,
    /// The broker declines the next call — for being over, out of scope, or
    /// aimed somewhere the grant does not reach.
    BrokerRefusal,
    /// The supervisor kills the process group.
    ProcessTermination,
    /// The invoke-through egress allowlist.
    EgressAllowlist,
    /// An OS sandbox: namespaces, seccomp, an app container.
    OsSandbox,
    /// Sealing the vault so the material is no longer readable.
    VaultSeal,
}

impl Mechanism {
    /// The dimensions this mechanism can honestly answer.
    ///
    /// Checked by [`crate::conformance::audit`]: an adapter cannot list a
    /// token TTL as its termination story.
    #[must_use]
    pub const fn serves(self) -> &'static [Dimension] {
        match self {
            Self::GrantExpiryCheck | Self::ProviderTokenTtl => &[Dimension::Expiry],
            Self::BrokerLeaseExpiry => &[Dimension::Expiry, Dimension::Termination],
            Self::ProviderRevocation | Self::ProcessTermination => &[Dimension::Termination],
            Self::BrokerRefusal => &[Dimension::Termination, Dimension::Isolation],
            Self::EgressAllowlist | Self::OsSandbox | Self::VaultSeal => &[Dimension::Isolation],
        }
    }

    /// Whether this mechanism answers `dimension`.
    #[must_use]
    pub fn answers(self, dimension: Dimension) -> bool {
        self.serves().contains(&dimension)
    }
}

/// What it would take for the subject to get out from under the guarantee.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Bypass {
    /// Nothing. The subject declines to cooperate and that is the end of it.
    TrivialForSubject,
    /// The subject must defeat a boundary on its own device.
    LocalPrivilegeEscalation,
    /// The subject must hold authority it was never issued — the broker's key,
    /// the provider's session, another principal's grant.
    DistinctAuthority,
}

impl Bypass {
    const fn rank(self) -> u8 {
        match self {
            Self::TrivialForSubject => 0,
            Self::LocalPrivilegeEscalation => 1,
            Self::DistinctAuthority => 2,
        }
    }

    /// Whether this is at least as hard to bypass as `floor`.
    #[must_use]
    pub const fn at_least(self, floor: Self) -> bool {
        self.rank() >= floor.rank()
    }
}

/// How long the effect takes to arrive once authority has decided.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Latency {
    /// Before the next use. There is no window.
    BeforeNextUse,
    /// Within a stated number of seconds.
    WithinSeconds(u32),
    /// No bound exists. Often the honest answer for a token already minted.
    Unbounded,
}

impl Latency {
    /// Whether this arrives at least as fast as `ceiling`.
    ///
    /// [`Self::Unbounded`] satisfies only [`Self::Unbounded`] — a caller that
    /// named any ceiling at all did so to exclude it.
    #[must_use]
    pub const fn within(self, ceiling: Self) -> bool {
        match (self, ceiling) {
            (Self::BeforeNextUse, _) | (_, Self::Unbounded) => true,
            (Self::WithinSeconds(have), Self::WithinSeconds(want)) => have <= want,
            (Self::Unbounded | Self::WithinSeconds(_), Self::BeforeNextUse)
            | (Self::Unbounded, Self::WithinSeconds(_)) => false,
        }
    }

    /// The bound in seconds, where one exists. Used to judge whether a pending
    /// effect is merely pending or overdue.
    #[must_use]
    pub const fn budget_seconds(self) -> Option<u32> {
        match self {
            Self::BeforeNextUse => Some(0),
            Self::WithinSeconds(seconds) => Some(seconds),
            Self::Unbounded => None,
        }
    }
}

/// What the guarantee outlives.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Survival {
    /// It holds while the enforcing process lives, and not a moment longer.
    ProcessLifetime,
    /// It is persisted, so restarting the enforcer does not lift it.
    ProcessRestart,
    /// It survives the device being rebooted.
    DeviceReboot,
    /// It holds while the device cannot reach us at all.
    NetworkPartition,
}

impl Survival {
    const fn rank(self) -> u8 {
        match self {
            Self::ProcessLifetime => 0,
            Self::ProcessRestart => 1,
            Self::DeviceReboot => 2,
            Self::NetworkPartition => 3,
        }
    }

    /// Whether this outlives at least as much as `floor`.
    #[must_use]
    pub const fn at_least(self, floor: Self) -> bool {
        self.rank() >= floor.rank()
    }
}

/// How we would come to know the guarantee actually took effect.
///
/// This is the field that keeps [`crate::effect`] honest. A dimension nothing
/// reports on can never move to an observed-settled state, however long we wait.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Observability {
    /// Nothing reports. Any claim that it happened would be a guess.
    Unobservable,
    /// We know what we asked for — a TTL we set — but nothing confirms it.
    Inferred,
    /// The enforcement point reports the state back.
    Reported,
}

impl Observability {
    const fn rank(self) -> u8 {
        match self {
            Self::Unobservable => 0,
            Self::Inferred => 1,
            Self::Reported => 2,
        }
    }

    /// Whether this tells us at least as much as `floor`.
    #[must_use]
    pub const fn at_least(self, floor: Self) -> bool {
        self.rank() >= floor.rank()
    }
}

/// One dimension's answer.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Guarantee {
    /// The code that does it.
    pub mechanism: Mechanism,
    /// Who would have to fail.
    pub point: EnforcementPoint,
    /// What getting out would take.
    pub bypass: Bypass,
    /// How fast it arrives.
    pub latency: Latency,
    /// What it outlives.
    pub survival: Survival,
    /// How we would know.
    pub observability: Observability,
}

impl Guarantee {
    /// Assemble a guarantee. Consistency is judged by
    /// [`crate::conformance::audit`] when the descriptor is built, not here —
    /// so the audit stays the single place the rules live.
    #[must_use]
    pub const fn new(
        mechanism: Mechanism,
        point: EnforcementPoint,
        bypass: Bypass,
        latency: Latency,
        survival: Survival,
        observability: Observability,
    ) -> Self {
        Self {
            mechanism,
            point,
            bypass,
            latency,
            survival,
            observability,
        }
    }

    /// Whether the only thing reporting this state is the subject itself.
    #[must_use]
    pub const fn self_reported(&self) -> bool {
        matches!(self.observability, Observability::Reported)
            && !self.point.independent_of_subject()
    }
}

#[cfg(test)]
mod tests {
    use super::{Bypass, Latency, Mechanism, Observability, Survival};
    use crate::dimension::Dimension;

    #[test]
    fn a_token_lifetime_is_not_a_termination_story() {
        assert!(Mechanism::ProviderTokenTtl.answers(Dimension::Expiry));
        assert!(!Mechanism::ProviderTokenTtl.answers(Dimension::Termination));
        // A lease is both, because pulling one and letting it lapse are the
        // same code path.
        assert!(Mechanism::BrokerLeaseExpiry.answers(Dimension::Expiry));
        assert!(Mechanism::BrokerLeaseExpiry.answers(Dimension::Termination));
    }

    #[test]
    fn every_mechanism_answers_at_least_one_dimension() {
        for mechanism in [
            Mechanism::GrantExpiryCheck,
            Mechanism::ProviderTokenTtl,
            Mechanism::BrokerLeaseExpiry,
            Mechanism::ProviderRevocation,
            Mechanism::BrokerRefusal,
            Mechanism::ProcessTermination,
            Mechanism::EgressAllowlist,
            Mechanism::OsSandbox,
            Mechanism::VaultSeal,
        ] {
            assert!(!mechanism.serves().is_empty(), "{mechanism:?}");
        }
    }

    #[test]
    fn unbounded_latency_fails_any_stated_ceiling() {
        assert!(!Latency::Unbounded.within(Latency::WithinSeconds(86_400)));
        assert!(!Latency::Unbounded.within(Latency::BeforeNextUse));
        assert!(Latency::Unbounded.within(Latency::Unbounded));
        assert!(Latency::BeforeNextUse.within(Latency::WithinSeconds(0)));
        assert!(Latency::WithinSeconds(30).within(Latency::WithinSeconds(30)));
        assert!(!Latency::WithinSeconds(31).within(Latency::WithinSeconds(30)));
        assert!(!Latency::WithinSeconds(1).within(Latency::BeforeNextUse));
    }

    #[test]
    fn each_field_orders_on_its_own_and_nothing_totals_them() {
        assert!(Bypass::DistinctAuthority.at_least(Bypass::LocalPrivilegeEscalation));
        assert!(!Bypass::TrivialForSubject.at_least(Bypass::LocalPrivilegeEscalation));
        assert!(Survival::NetworkPartition.at_least(Survival::DeviceReboot));
        assert!(!Survival::ProcessLifetime.at_least(Survival::ProcessRestart));
        assert!(Observability::Reported.at_least(Observability::Inferred));
        assert!(!Observability::Unobservable.at_least(Observability::Inferred));
    }
}
