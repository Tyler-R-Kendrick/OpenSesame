//! The AWS mint arm (ADR 0217, amending ADR 0049 §3): the Host assumes an IAM
//! role with STS and hands the caller the temporary credential STS issued.
//!
//! The source credential is an ordinary sealed aws-family connection (an IAM
//! access key pair, optionally with a session token). It signs one
//! `AssumeRole` request and never leaves this module: no route, log line,
//! event or receipt carries it, and the signature is computed by `aws-sigv4`
//! under a subscriber that discards the signer's own trace output.
//!
//! - [`binding`] is what the operator configures on the connection: the role,
//!   the region, the duration cap, an optional session policy and an optional
//!   sealed `ExternalId`.
//! - [`request`] derives the `AssumeRole` parameters: the session name from the
//!   mint's grant id, `SourceIdentity` from the caller, the duration under the
//!   binding's cap.
//! - [`client`] sends it through invoke-through (egress allowlist, no
//!   redirects, bounded body, timeout) and [`response`] reads the answer with a
//!   bounded XML reader, refusing anything it cannot trust.
//!
//! Every failure is one of [`StsFailure`]'s stable codes. None carries STS's
//! own message: an upstream's words are not ours to repeat.

pub mod binding;
pub mod client;
pub mod endpoint;
pub mod minted;
pub mod register;
pub mod request;
pub mod response;
pub mod signer;
#[cfg(any(test, feature = "sts-stand-in"))]
pub mod stand_in;
pub mod store;

pub use binding::{AwsStsBinding, AwsStsBindingInput, AwsStsBindingView};
pub use client::{assume_role, AssumedRole};
pub use minted::{AwsSessionCredentials, MintReceipt};
pub use request::AssumeRoleRequest;
pub use signer::SourceCredential;

/// The providers whose sealed configuration is an IAM key pair the mint may
/// sign with. `aws-sts` itself holds no key on the Host.
pub const MINTABLE_PROVIDERS: &[&str] = &["aws", "aws-kms", "aws-ps", "aws-bedrock"];

/// Whether `provider_id` is an aws-family connection that can carry a binding.
#[must_use]
pub fn is_mintable_provider(provider_id: &str) -> bool {
    MINTABLE_PROVIDERS.contains(&provider_id)
}

/// Why a mint failed, as a stable code. Carries nothing from the response.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StsFailure {
    /// STS refused the call (`AccessDenied`, an untrusted principal, a
    /// session policy the role does not allow, any other client error).
    AccessDenied,
    /// The source key is expired, deactivated or wrong
    /// (`ExpiredToken`, `InvalidClientTokenId`, `SignatureDoesNotMatch`).
    ExpiredSource,
    /// STS is not activated in the binding's region (`RegionDisabledException`).
    RegionDisabled,
    /// STS asked us to slow down (`Throttling`, HTTP 429).
    Throttled,
    /// The answer could not be trusted: unparseable, oversized, a redirect, a
    /// missing field, or an expiration in the past or beyond what was asked.
    MalformedResponse,
    /// STS could not be reached in time, or answered with a server error.
    Unreachable,
}

impl StsFailure {
    /// The frozen wire code.
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::AccessDenied => "aws.sts.access_denied",
            Self::ExpiredSource => "aws.sts.expired_source",
            Self::RegionDisabled => "aws.sts.region_disabled",
            Self::Throttled => "aws.sts.throttled",
            Self::MalformedResponse => "aws.sts.malformed_response",
            Self::Unreachable => "aws.sts.unreachable",
        }
    }

    /// A fixed sentence for a human; never a fragment of the response.
    #[must_use]
    pub const fn hint(self) -> &'static str {
        match self {
            Self::AccessDenied => "STS refused to assume the bound role",
            Self::ExpiredSource => "the connection's AWS key is expired, deactivated or wrong",
            Self::RegionDisabled => "STS is not activated in the bound region",
            Self::Throttled => "STS is throttling this account; try again later",
            Self::MalformedResponse => "STS returned an answer that could not be trusted",
            Self::Unreachable => "STS could not be reached",
        }
    }

    /// The Host's status for this failure: an upstream refusal is a bad
    /// gateway, throttling is passed on, unreachable is a gateway timeout.
    #[must_use]
    pub const fn http_status(self) -> u16 {
        match self {
            Self::Throttled => 429,
            Self::Unreachable => 504,
            Self::AccessDenied
            | Self::ExpiredSource
            | Self::RegionDisabled
            | Self::MalformedResponse => 502,
        }
    }
}

impl std::fmt::Display for StsFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.code())
    }
}

#[cfg(test)]
mod tests;
