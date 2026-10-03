//! What a refusal means, and what a runner does after a substituted login.
//!
//! The failure contract is ADR 0150 §6.3's last rule made into a type: a
//! login that fails after substitution falls back to the recipe's CDP fill,
//! and **never** to retrying substitution. [`AfterSubstitution`] has no
//! variant that says "substitute again", and
//! [`ArmedSubstitution::conclude`](super::ArmedSubstitution::conclude) takes
//! the declaration by value, so once an attempt has ended there is no
//! declaration left to retry with.

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::tools::StepError;

/// The fence a login submission hit. Stable strings: they are the
/// `surrogate.*` names the runner raises on ADR 0080's feed, beside
/// invoke-through's.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RefusalCode {
    /// The surrogate went somewhere other than the declared action: another
    /// scheme, host or port, or another path on the right origin. The
    /// signature of a page script exfiltrating what it read from the field.
    Misdirected,
    /// Right destination, but the surrogate appeared somewhere other than
    /// exactly once, as the whole value of the declared field: another field,
    /// a key, the query, a header, a second copy, nested JSON, an array, or a
    /// body format substitution is never done in (multipart).
    Misplaced,
    /// A request substitution does not handle: not a POST, a compressed body,
    /// a content type other than form or JSON, a charset other than UTF-8, or
    /// a body that does not parse as the type it claims.
    Unsupported,
    /// The declared submission carries no surrogate at all — the page hashed,
    /// encrypted or dropped it before the wire.
    Absent,
    /// The surrogate was already substituted once in this attempt. A second
    /// submission is never substituted; the attempt is over.
    Replayed,
}

impl RefusalCode {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Misdirected => "surrogate.misdirected",
            Self::Misplaced => "surrogate.misplaced",
            Self::Unsupported => "surrogate.unsupported",
            Self::Absent => "surrogate.absent",
            Self::Replayed => "surrogate.replayed",
        }
    }

    /// Whether this refusal means something copied the surrogate. A tripwire
    /// parks the run for a person; anything else is a page shape substitution
    /// does not fit, and the login proceeds by CDP fill.
    #[must_use]
    pub const fn is_tripwire(self) -> bool {
        matches!(self, Self::Misdirected | Self::Misplaced)
    }
}

/// A refused submission. Names the fence and, where it helps a person, the
/// site or destination — never a surrogate or a credential: every detail is
/// defanged before it is stored.
#[derive(Clone, Debug, PartialEq, Eq, Error)]
#[error("{}", .code.as_str())]
pub struct Refusal {
    pub code: RefusalCode,
    /// For `Misplaced`: where it was found (`query`, `body`, a header name,
    /// `form-key`, `json-nested`, …). For `Misdirected`: where it was sent.
    pub detail: Option<String>,
}

impl Refusal {
    /// What the page is told when its request is failed, whatever the code:
    /// a script probing with guesses learns nothing about which were real.
    pub const CLIENT_MESSAGE: &'static str = "request refused by the credential broker";

    pub(super) fn new(code: RefusalCode, detail: &str) -> Self {
        Self {
            code,
            detail: Some(super::sighting::defang(detail)),
        }
    }

    /// What the runner does next.
    #[must_use]
    pub const fn next(&self) -> AfterSubstitution {
        if self.code.is_tripwire() {
            AfterSubstitution::Park(ParkReason::Tripwire(self.code))
        } else {
            AfterSubstitution::FallBackToCdpFill(FallbackReason::Refused(self.code))
        }
    }
}

/// Where a substitution attempt leaves the login.
///
/// There is no `Retry` and no `SubstituteAgain`. That absence is the contract.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AfterSubstitution {
    /// The substituted submission signed in.
    LoggedIn,
    /// Log in the ordinary way: navigate again, `fill_credential` the
    /// reference, submit. The substitution declaration is gone by now.
    FallBackToCdpFill(FallbackReason),
    /// Stop and hand the run to a person.
    Park(ParkReason),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FallbackReason {
    /// The site rejected the substituted login. Possibly the page transformed
    /// the surrogate client-side; possibly the credential is wrong. CDP fill
    /// tells them apart.
    Rejected,
    /// Refused at egress for a reason that is the page's shape, not theft.
    Refused(RefusalCode),
    /// The submit happened and no request carried the surrogate.
    NotSubmitted,
    /// The password field could not take the surrogate.
    NoSuchField,
    /// A browser step failed during the attempt.
    Step(StepError),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ParkReason {
    /// Something copied the surrogate out of its field.
    Tripwire(RefusalCode),
    /// The site answered in a way that proves nothing (ADR 0076 constraint 5).
    Indeterminate,
    /// The CDP fallback could not find its field.
    NoSuchField,
    /// A browser step failed during the CDP fallback.
    Step(StepError),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_tripwire_parks_and_a_shape_falls_back() {
        for code in [RefusalCode::Misdirected, RefusalCode::Misplaced] {
            assert_eq!(
                Refusal::new(code, "x").next(),
                AfterSubstitution::Park(ParkReason::Tripwire(code))
            );
        }
        for code in [
            RefusalCode::Unsupported,
            RefusalCode::Absent,
            RefusalCode::Replayed,
        ] {
            assert_eq!(
                Refusal::new(code, "x").next(),
                AfterSubstitution::FallBackToCdpFill(FallbackReason::Refused(code))
            );
        }
    }

    #[test]
    fn codes_have_stable_notice_names() {
        assert_eq!(RefusalCode::Misdirected.as_str(), "surrogate.misdirected");
        assert_eq!(RefusalCode::Absent.as_str(), "surrogate.absent");
        assert_eq!(
            Refusal::new(RefusalCode::Misplaced, "query").to_string(),
            "surrogate.misplaced"
        );
    }
}
