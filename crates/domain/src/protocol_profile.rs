//! Protocol profiles for token presentation and downgrade policy.

use crate::{DomainError, ProtocolProfileId};
use serde::{Deserialize, Serialize};

/// Built-in profile identifiers (stable strings).
pub const PROFILE_OPENSESAME_TASK_DPOP_RFC9449_V1: &str = "opensesame-task-dpop-rfc9449-v1";
pub const PROFILE_OAUTH_BEARER_RFC6750_V1: &str = "oauth-bearer-rfc6750-v1";
pub const PROFILE_MCP_AUTHORIZATION_2026_07_28_BEARER: &str = "mcp-authorization-2026-07-28-bearer";
pub const PROFILE_OAUTH_TOKEN_EXCHANGE_RFC8693_SEMANTICS_V1: &str =
    "oauth-token-exchange-rfc8693-semantics-v1";
pub const PROFILE_HTTP_MESSAGE_SIGNATURES_RFC9421_V1: &str = "http-message-signatures-rfc9421-v1";
pub const PROFILE_AAUTH_DRAFT_10_EXPERIMENTAL: &str = "aauth-draft-10-experimental";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProtocolFamily {
    OpenSesameTask,
    OAuth,
    Mcp,
    HttpMessageSignatures,
    Experimental,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProtocolMaturity {
    Experimental,
    Draft,
    Stable,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TokenPresentation {
    Bearer,
    DpopBound,
    HttpMessageSignature,
    MutualTls,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DowngradePolicy {
    /// Reject presentation weaker than profile minimum.
    FailClosed,
    /// Allow downgrade only with explicit policy decision (not automatic).
    RequiresPolicyDecision,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProtocolProfile {
    pub id: ProtocolProfileId,
    pub slug: String,
    pub family: ProtocolFamily,
    pub maturity: ProtocolMaturity,
    pub minimum_presentation: TokenPresentation,
    pub downgrade_policy: DowngradePolicy,
    pub requires_task_binding: bool,
    pub requires_replay_protection: bool,
}

impl ProtocolProfile {
    pub fn parse_slug(slug: &str) -> Result<Self, DomainError> {
        let (family, maturity, minimum_presentation, requires_task_binding, requires_replay) =
            match slug {
                PROFILE_OPENSESAME_TASK_DPOP_RFC9449_V1 => (
                    ProtocolFamily::OpenSesameTask,
                    ProtocolMaturity::Stable,
                    TokenPresentation::DpopBound,
                    true,
                    true,
                ),
                PROFILE_OAUTH_BEARER_RFC6750_V1 => (
                    ProtocolFamily::OAuth,
                    ProtocolMaturity::Stable,
                    TokenPresentation::Bearer,
                    false,
                    false,
                ),
                PROFILE_MCP_AUTHORIZATION_2026_07_28_BEARER => (
                    ProtocolFamily::Mcp,
                    ProtocolMaturity::Draft,
                    TokenPresentation::Bearer,
                    false,
                    false,
                ),
                PROFILE_OAUTH_TOKEN_EXCHANGE_RFC8693_SEMANTICS_V1 => (
                    ProtocolFamily::OAuth,
                    ProtocolMaturity::Stable,
                    TokenPresentation::Bearer,
                    false,
                    false,
                ),
                PROFILE_HTTP_MESSAGE_SIGNATURES_RFC9421_V1 => (
                    ProtocolFamily::HttpMessageSignatures,
                    ProtocolMaturity::Stable,
                    TokenPresentation::HttpMessageSignature,
                    false,
                    true,
                ),
                PROFILE_AAUTH_DRAFT_10_EXPERIMENTAL => (
                    ProtocolFamily::Experimental,
                    ProtocolMaturity::Experimental,
                    TokenPresentation::DpopBound,
                    true,
                    true,
                ),
                _ => {
                    return Err(DomainError::UnknownProtocolProfile(slug.to_string()));
                }
            };

        Ok(Self {
            id: ProtocolProfileId::from_slug(slug),
            slug: slug.to_string(),
            family,
            maturity,
            minimum_presentation,
            downgrade_policy: DowngradePolicy::FailClosed,
            requires_task_binding,
            requires_replay_protection: requires_replay,
        })
    }

    pub fn assert_presentation_allowed(
        &self,
        presentation: TokenPresentation,
    ) -> Result<(), DomainError> {
        if presentation_strength(presentation) < presentation_strength(self.minimum_presentation) {
            return Err(DomainError::TokenPresentationDowngrade);
        }
        Ok(())
    }
}

fn presentation_strength(p: TokenPresentation) -> u8 {
    match p {
        TokenPresentation::Bearer => 0,
        TokenPresentation::DpopBound => 1,
        TokenPresentation::HttpMessageSignature => 2,
        TokenPresentation::MutualTls => 3,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_profiles_parse() {
        for slug in [
            PROFILE_OPENSESAME_TASK_DPOP_RFC9449_V1,
            PROFILE_OAUTH_BEARER_RFC6750_V1,
            PROFILE_MCP_AUTHORIZATION_2026_07_28_BEARER,
            PROFILE_OAUTH_TOKEN_EXCHANGE_RFC8693_SEMANTICS_V1,
            PROFILE_HTTP_MESSAGE_SIGNATURES_RFC9421_V1,
            PROFILE_AAUTH_DRAFT_10_EXPERIMENTAL,
        ] {
            let p = ProtocolProfile::parse_slug(slug).unwrap();
            assert_eq!(p.slug, slug);
        }
    }

    #[test]
    fn bearer_downgrade_rejected_for_dpop_profile() {
        let p = ProtocolProfile::parse_slug(PROFILE_OPENSESAME_TASK_DPOP_RFC9449_V1).unwrap();
        assert!(p
            .assert_presentation_allowed(TokenPresentation::Bearer)
            .is_err());
        assert!(p
            .assert_presentation_allowed(TokenPresentation::DpopBound)
            .is_ok());
    }
}
