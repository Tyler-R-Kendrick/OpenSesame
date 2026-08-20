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

    /// Build from explicit readiness signals. Once production DPoP middleware
    /// is wired end-to-end, the gateway constructs its advertisement this way
    /// from real validator/replay/key-policy health.
    pub fn from_flags(
        enabled: bool,
        validator_configured: bool,
        replay_store_healthy: bool,
        key_policy_available: bool,
    ) -> Self {
        Self {
            validator_configured,
            replay_store_healthy,
            key_policy_available,
            enabled,
        }
    }

    /// Host API posture. `enabled` follows OPENSESAME_DPOP_ENABLED, but the
    /// readiness flags stay false until production DPoP middleware is wired
    /// end-to-end: claiming validator/replay/key-policy readiness without a
    /// live validation path would advertise DPoP the host cannot enforce.
    pub fn host_default() -> Self {
        Self::from_flags(dpop_env_enabled(), false, false, false)
    }
}

fn dpop_env_enabled() -> bool {
    std::env::var("OPENSESAME_DPOP_ENABLED")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
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

        // Pass the request clock so replay entries expire with the proof window.
        self.replay_cache.check_and_record_at(&claims.jti, now)?;

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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, OnceLock};

    // Env-mutating tests must not race each other (or parallel neighbors).
    fn env_lock() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
            .lock()
            .expect("env lock")
    }

    #[test]
    fn from_flags_requires_every_signal_for_readiness() {
        let all = DpopAdvertisement::from_flags(true, true, true, true);
        assert!(all.is_ready());
        for (v, r, k) in [
            (false, true, true),
            (true, false, true),
            (true, true, false),
        ] {
            assert!(
                !DpopAdvertisement::from_flags(true, v, r, k).is_ready(),
                "missing signal must not be ready: v={v} r={r} k={k}"
            );
        }
        assert!(!DpopAdvertisement::from_flags(false, true, true, true).is_ready());
    }

    #[test]
    fn host_default_never_claims_readiness_without_wired_middleware() {
        let _guard = env_lock();
        std::env::remove_var("OPENSESAME_DPOP_ENABLED");
        assert!(!DpopAdvertisement::host_default().is_ready());
        // Even with the env flag set, the unwired host must not advertise a
        // validator/replay/key-policy stack it does not have.
        std::env::set_var("OPENSESAME_DPOP_ENABLED", "true");
        let advertised = DpopAdvertisement::host_default();
        assert!(advertised.enabled);
        assert!(!advertised.is_ready());
        std::env::remove_var("OPENSESAME_DPOP_ENABLED");
    }

    #[test]
    fn dpop_env_enabled_parses_only_explicit_truths() {
        let _guard = env_lock();
        for (value, expected) in [
            (None, false),
            (Some("1"), true),
            (Some("true"), true),
            (Some("TRUE"), true),
            (Some("0"), false),
            (Some("yes"), false),
            (Some(""), false),
        ] {
            match value {
                Some(v) => std::env::set_var("OPENSESAME_DPOP_ENABLED", v),
                None => std::env::remove_var("OPENSESAME_DPOP_ENABLED"),
            }
            assert_eq!(dpop_env_enabled(), expected, "value={value:?}");
        }
        std::env::remove_var("OPENSESAME_DPOP_ENABLED");
    }
}
