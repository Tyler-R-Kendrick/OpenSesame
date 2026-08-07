use crate::jwk::{decode_dpop_proof, DpopPublicJwk};
use crate::replay::ReplayCache;
use crate::ProofError;
use opensesame_domain::DomainError;

/// Validated DPoP proof context after RFC 9449 checks.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ValidatedDpopProof {
    pub jti: String,
    pub jkt: String,
    pub htm: String,
    pub htu: String,
    pub iat: i64,
    pub ath: Option<String>,
    pub jwk: DpopPublicJwk,
}

/// Advertisement gate: only claim DPoP support when validator + replay are ready.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DpopAdvertisement {
    pub validator_configured: bool,
    pub replay_store_healthy: bool,
    pub key_policy_available: bool,
    pub enabled: bool,
}

impl DpopAdvertisement {
    pub fn is_ready(&self) -> bool {
        self.enabled
            && self.validator_configured
            && self.replay_store_healthy
            && self.key_policy_available
    }

    /// Default Host API posture until production DPoP middleware is wired end-to-end.
    pub fn host_default() -> Self {
        Self {
            validator_configured: true,
            replay_store_healthy: true,
            key_policy_available: true,
            // Advertise only when OPENSESAME_DPOP_ENABLED=true.
            enabled: std::env::var("OPENSESAME_DPOP_ENABLED")
                .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
                .unwrap_or(false),
        }
    }
}

/// RFC 9449 DPoP proof validator.
pub struct DpopValidator<R: ReplayCache> {
    replay_cache: R,
    max_age_secs: i64,
}

impl<R: ReplayCache> DpopValidator<R> {
    pub fn new(replay_cache: R, max_age_secs: i64) -> Self {
        Self {
            replay_cache,
            max_age_secs,
        }
    }

    /// Validate a DPoP proof JWT for an HTTP request.
    ///
    /// Checks: `typ`, `alg`, `jkt`, `jti`, `htm`, `htu`, `iat`, optional `ath`,
    /// optional `cnf.jkt` against the access token, and replay via `jti`.
    pub fn validate(
        &self,
        proof_jwt: Option<&str>,
        htm: &str,
        htu: &str,
        now: i64,
        access_token: Option<&str>,
        token_cnf_jkt: Option<&str>,
    ) -> Result<ValidatedDpopProof, ProofError> {
        let proof_jwt = proof_jwt.ok_or(ProofError::MissingProof)?;

        let expected_ath = access_token.map(crate::jwk::access_token_hash);
        let (claims, jwk, jkt) = decode_dpop_proof(
            proof_jwt,
            htm,
            htu,
            expected_ath.as_deref(),
            self.max_age_secs,
            now,
        )?;

        if let Some(expected_jkt) = token_cnf_jkt {
            if expected_jkt != jkt {
                return Err(ProofError::ConfirmationThumbprintMismatch);
            }
        }

        self.replay_cache.check_and_record(&claims.jti)?;

        Ok(ValidatedDpopProof {
            jti: claims.jti,
            jkt,
            htm: claims.htm,
            htu: claims.htu,
            iat: claims.iat,
            ath: claims.ath,
            jwk,
        })
    }
}

/// Reject presenting a DPoP-bound token as a plain Bearer token.
pub fn reject_dpop_bound_as_bearer(
    token_is_dpop_bound: bool,
    authorization_scheme: &str,
) -> Result<(), DomainError> {
    if token_is_dpop_bound && authorization_scheme.eq_ignore_ascii_case("bearer") {
        return Err(DomainError::TokenPresentationDowngrade);
    }
    Ok(())
}

/// Assert token presentation satisfies a protocol profile minimum.
pub fn assert_token_presentation(
    profile: &opensesame_domain::ProtocolProfile,
    presentation: opensesame_domain::TokenPresentation,
) -> Result<(), ProofError> {
    profile
        .assert_presentation_allowed(presentation)
        .map_err(|e| match e {
            DomainError::TokenPresentationDowngrade => ProofError::TokenPresentationDowngrade,
            other => ProofError::Domain(other),
        })
}
