//! Who actually holds a guarantee, and where the subject stands relative to it.
//!
//! This is the module the other four hang off. A guarantee's shape is mostly
//! decided by two facts: which component would have to fail for the guarantee
//! to fail ([`EnforcementPoint`]), and whether the subject was ever handed the
//! value in the first place ([`SubjectSurface`]).
//!
//! The distinction that matters is not "strong" versus "weak" but *independent*
//! versus *self-administered*. A limit the subject enforces on itself is a
//! preference. It may be worth having — a cooperative runtime catches honest
//! mistakes — but it is not the same kind of fact as a kernel refusing a
//! syscall, and this crate will not let the two be written the same way.

use serde::{Deserialize, Serialize};

/// The component that would have to fail for a guarantee to fail.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EnforcementPoint {
    /// The operating system: a namespace, a seccomp filter, a process group.
    OsKernel,
    /// The Host authority plane — gateway or daemon — deciding each call.
    HostBroker,
    /// The egress broker that refuses a destination outside the allowlist.
    NetworkBroker,
    /// The provider's own authorization server: token lifetime, revocation.
    Provider,
    /// A library inside the subject that declines to do the thing.
    SubjectRuntime,
    /// The subject's own word for it. Not an enforcement point; modelled so a
    /// descriptor can say so out loud instead of leaving the field blank.
    SubjectItself,
}

impl EnforcementPoint {
    /// Whether the subject would have to defeat something outside itself.
    ///
    /// [`Self::SubjectRuntime`] is false: a library linked into the subject is
    /// removed by not linking it.
    #[must_use]
    pub const fn independent_of_subject(self) -> bool {
        match self {
            Self::OsKernel | Self::HostBroker | Self::NetworkBroker | Self::Provider => true,
            Self::SubjectRuntime | Self::SubjectItself => false,
        }
    }

    /// The wire name.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::OsKernel => "os_kernel",
            Self::HostBroker => "host_broker",
            Self::NetworkBroker => "network_broker",
            Self::Provider => "provider",
            Self::SubjectRuntime => "subject_runtime",
            Self::SubjectItself => "subject_itself",
        }
    }
}

/// Where authority is exercised, and — the load-bearing part — who holds the
/// value while it is live.
///
/// The same host answers the dimensions differently for different surfaces,
/// which is the clearest reason a single scalar cannot describe enforcement:
/// [`Self::BrokeredInvocation`] and [`Self::MintedCredential`] run on the same
/// machine, under the same code, and have almost nothing in common.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SubjectSurface {
    /// The subject never holds the value. Every call is brokered, so every
    /// call is a decision point.
    BrokeredInvocation,
    /// The value was minted into the subject's hands. The host is no longer in
    /// the loop, whatever it would prefer.
    MintedCredential,
    /// The subject runs in a sandbox this host supervises: it can be observed,
    /// paused, and killed.
    SupervisedSandbox,
    /// The subject is an application on a platform we do not administer.
    ForeignPlatformApp,
}

impl SubjectSurface {
    /// Whether a guarantee on this surface could plausibly be held at `point`.
    ///
    /// The rule with teeth is [`Self::MintedCredential`]: once the value is in
    /// the subject's hands the Host broker is not consulted again, so a
    /// descriptor claiming `HostBroker` enforcement there is describing a call
    /// path that does not exist. Likewise nothing on a foreign platform is
    /// held by our kernel or our brokers.
    #[must_use]
    pub const fn admits(self, point: EnforcementPoint) -> bool {
        match self {
            Self::BrokeredInvocation | Self::SupervisedSandbox => true,
            Self::MintedCredential => !matches!(
                point,
                EnforcementPoint::HostBroker | EnforcementPoint::NetworkBroker
            ),
            Self::ForeignPlatformApp => matches!(
                point,
                EnforcementPoint::Provider
                    | EnforcementPoint::SubjectRuntime
                    | EnforcementPoint::SubjectItself
            ),
        }
    }

    /// The wire name.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::BrokeredInvocation => "brokered_invocation",
            Self::MintedCredential => "minted_credential",
            Self::SupervisedSandbox => "supervised_sandbox",
            Self::ForeignPlatformApp => "foreign_platform_app",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{EnforcementPoint, SubjectSurface};

    const OURS: [EnforcementPoint; 3] = [
        EnforcementPoint::OsKernel,
        EnforcementPoint::HostBroker,
        EnforcementPoint::NetworkBroker,
    ];

    #[test]
    fn a_library_in_the_subject_is_not_independent_of_the_subject() {
        // The whole point of the distinction: `SubjectRuntime` reads like
        // enforcement and is not. Removing it is one line of a manifest.
        assert!(!EnforcementPoint::SubjectRuntime.independent_of_subject());
        assert!(!EnforcementPoint::SubjectItself.independent_of_subject());
        for point in OURS {
            assert!(point.independent_of_subject(), "{point:?}");
        }
        assert!(EnforcementPoint::Provider.independent_of_subject());
    }

    #[test]
    fn a_minted_credential_is_not_held_by_the_broker_that_minted_it() {
        let minted = SubjectSurface::MintedCredential;
        assert!(!minted.admits(EnforcementPoint::HostBroker));
        assert!(!minted.admits(EnforcementPoint::NetworkBroker));
        // The provider still holds what it holds — a TTL, a revocation list.
        assert!(minted.admits(EnforcementPoint::Provider));
    }

    #[test]
    fn a_foreign_platform_app_is_held_by_nothing_of_ours() {
        let foreign = SubjectSurface::ForeignPlatformApp;
        for ours in OURS {
            assert!(!foreign.admits(ours), "{ours:?}");
        }
        assert!(foreign.admits(EnforcementPoint::Provider));
    }

    #[test]
    fn a_brokered_call_is_a_decision_point_for_every_dimension() {
        for point in [
            EnforcementPoint::OsKernel,
            EnforcementPoint::HostBroker,
            EnforcementPoint::NetworkBroker,
            EnforcementPoint::Provider,
            EnforcementPoint::SubjectRuntime,
            EnforcementPoint::SubjectItself,
        ] {
            assert!(
                SubjectSurface::BrokeredInvocation.admits(point),
                "{point:?}"
            );
        }
    }
}
