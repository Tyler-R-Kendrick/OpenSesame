//! "We cannot do that" as a value a caller can branch on.
//!
//! The failure mode this exists to prevent is an adapter that answers a
//! dimension it has no implementation for, because the field was required and
//! the plausible-sounding value was right there. So the only two shapes a
//! dimension can have are a [`crate::guarantee::Guarantee`] naming real code
//! and an [`Unsupported`] naming why there is none — and an unsupported answer
//! is not an error string. It carries a reason code, the platform and surface
//! it applies to, and, where one exists, the remedy.
//!
//! A caller that gets one of these can render it, log it, or act on it without
//! parsing prose.

use crate::dimension::Dimension;
use crate::ownership::SubjectSurface;
use serde::{Deserialize, Serialize};

/// Why a dimension has no guarantee on this platform.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UnsupportedReason {
    /// Nobody has written the adapter. Legal only when the descriptor's
    /// adapter is declared absent, so this reason cannot be used to paper over
    /// a gap in an adapter that otherwise claims to work.
    NoAdapter,
    /// The platform provides no mechanism at all. Writing one is not a matter
    /// of effort.
    PlatformProvidesNoMechanism,
    /// A mechanism exists but needs privilege this process does not have and
    /// will not ask for.
    PrivilegeUnavailable,
    /// The provider does not offer it — no revocation endpoint, no session
    /// kill, no short-lived token.
    ProviderDoesNotOffer,
    /// The surface put the value beyond reach: once minted, nothing local
    /// stands between the subject and the credential.
    ValueLeftTheBoundary,
}

impl UnsupportedReason {
    /// The wire name.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::NoAdapter => "no_adapter",
            Self::PlatformProvidesNoMechanism => "platform_provides_no_mechanism",
            Self::PrivilegeUnavailable => "privilege_unavailable",
            Self::ProviderDoesNotOffer => "provider_does_not_offer",
            Self::ValueLeftTheBoundary => "value_left_the_boundary",
        }
    }
}

/// What would change the answer, where anything would.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Remedy {
    /// Nothing available today. Said plainly rather than left blank.
    NoneKnown,
    /// Broker the calls instead of minting the credential.
    BrokerTheInvocation,
    /// Run the subject on a host this deployment supervises.
    RunOnSupervisedHost,
    /// Pick a provider that offers the control.
    ChooseProviderWithControl,
    /// Narrow the grant so the dimension is not required.
    NarrowTheGrant,
}

/// A dimension with no guarantee behind it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct Unsupported {
    /// Why.
    pub reason: UnsupportedReason,
    /// What would change it.
    pub remedy: Remedy,
    /// One short, checked-in sentence. Not a formatted message and not a
    /// place to put a value.
    pub detail: &'static str,
}

impl Unsupported {
    /// State an unsupported dimension.
    #[must_use]
    pub const fn new(reason: UnsupportedReason, remedy: Remedy, detail: &'static str) -> Self {
        Self {
            reason,
            remedy,
            detail,
        }
    }
}

/// The full, machine-readable form: the unsupported fact plus the context that
/// makes it addressable.
///
/// This is what a Host API route answers with when a grant asks for something
/// the platform does not hold. It is deliberately a separate type from
/// [`Unsupported`] — a descriptor stores the reason once per dimension, and the
/// platform and surface are the descriptor's, not the reason's.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct UnsupportedResponse {
    /// The platform identifier, e.g. `linux-host` or `apple-ios`.
    pub platform: &'static str,
    /// The surface the subject runs on.
    pub surface: SubjectSurface,
    /// Which dimension is unanswered.
    pub dimension: Dimension,
    /// Why.
    pub reason: UnsupportedReason,
    /// What would change it.
    pub remedy: Remedy,
    /// The checked-in sentence.
    pub detail: &'static str,
}

impl UnsupportedResponse {
    pub(crate) const fn assemble(
        platform: &'static str,
        surface: SubjectSurface,
        dimension: Dimension,
        unsupported: Unsupported,
    ) -> Self {
        Self {
            platform,
            surface,
            dimension,
            reason: unsupported.reason,
            remedy: unsupported.remedy,
            detail: unsupported.detail,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{Remedy, Unsupported, UnsupportedReason, UnsupportedResponse};
    use crate::dimension::Dimension;
    use crate::ownership::SubjectSurface;

    #[test]
    fn a_response_carries_the_context_a_caller_needs_to_act() {
        let response = UnsupportedResponse::assemble(
            "apple-ios",
            SubjectSurface::ForeignPlatformApp,
            Dimension::Termination,
            Unsupported::new(
                UnsupportedReason::NoAdapter,
                Remedy::NoneKnown,
                "no iOS adapter exists",
            ),
        );
        assert_eq!(response.platform, "apple-ios");
        assert_eq!(response.dimension, Dimension::Termination);
        assert_eq!(response.reason.as_str(), "no_adapter");
        assert_eq!(response.remedy, Remedy::NoneKnown);
    }

    #[test]
    fn every_reason_has_a_distinct_wire_name() {
        let names = [
            UnsupportedReason::NoAdapter,
            UnsupportedReason::PlatformProvidesNoMechanism,
            UnsupportedReason::PrivilegeUnavailable,
            UnsupportedReason::ProviderDoesNotOffer,
            UnsupportedReason::ValueLeftTheBoundary,
        ];
        let mut wire: Vec<&str> = names.iter().map(|r| r.as_str()).collect();
        wire.sort_unstable();
        wire.dedup();
        assert_eq!(wire.len(), names.len());
    }
}
