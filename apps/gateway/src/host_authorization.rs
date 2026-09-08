//! Identity evidence is verified against operator-pinned public keys, never token metadata.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use jsonwebtoken::{decode, jwk::Jwk, Algorithm, DecodingKey, Validation};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
#[cfg(test)]
#[path = "host_authorization_tests.rs"]
mod tests;

#[derive(Clone)]
pub struct HostAuthorizationVerifier {
    issuer: String,
    keys: BTreeMap<String, DecodingKey>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EvidenceHeader {
    alg: String,
    typ: String,
    kid: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct HostEvidence {
    pub iss: String,
    pub aud: String,
    pub host_audience: String,
    pub expires_at: i64,
    pub sub: String,
    pub organization_id: String,
    pub organization_role: opensesame_domain::OrganizationRole,
    pub challenge_id: String,
    pub challenge_digest: String,
    pub operation: String,
    pub target_id: String,
    pub transition: Option<String>,
    pub origin: String,
    pub dpop_jkt: String,
    pub auth_time: i64,
    pub amr: Vec<String>,
    pub assurance: String,
    pub iat: i64,
    pub nbf: Option<i64>,
    pub exp: i64,
    pub jti: String,
}

impl HostAuthorizationVerifier {
    pub fn from_env() -> Result<Option<Self>, String> {
        match (
            std::env::var("OPENSESAME_HOST_AUTHORIZATION_ISSUER").ok(),
            std::env::var("OPENSESAME_HOST_AUTHORIZATION_JWKS_JSON").ok(),
        ) {
            (None, None) => Ok(None),
            (Some(issuer), Some(keys)) => Self::new(issuer, &keys).map(Some),
            _ => Err("Host authorization requires an issuer and public JWKS".into()),
        }
    }

    pub fn new(issuer: String, encoded: &str) -> Result<Self, String> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct KeySet {
            keys: Vec<serde_json::Value>,
        }
        let fail = || "Invalid Host authorization trust configuration".to_string();
        let url = url::Url::parse(&issuer).map_err(|_| fail())?;
        if encoded.len() > 65536
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || (url.scheme() != "https"
                && opensesame_host_core::deployment_mode::endpoint_exposure(&issuer)
                    != Ok(opensesame_host_core::deployment_mode::ExposureClass::LocalOnly))
        {
            return Err(fail());
        }
        let set: KeySet = serde_json::from_str(encoded).map_err(|_| fail())?;
        if set.keys.is_empty() || set.keys.len() > 16 {
            return Err(fail());
        }
        let mut keys = BTreeMap::new();
        for value in set.keys {
            if ["d", "p", "q", "dp", "dq", "qi", "oth", "k", "x5u", "jku"]
                .iter()
                .any(|key| value.get(key).is_some())
                || value["kty"] != "RSA"
                || value["alg"] != "RS256"
                || value.get("use").is_some_and(|usage| usage != "sig")
            {
                return Err(fail());
            }
            let kid = value["kid"]
                .as_str()
                .filter(|kid| !kid.is_empty() && kid.len() <= 128)
                .ok_or_else(fail)?
                .to_owned();
            let jwk: Jwk = serde_json::from_value(value).map_err(|_| fail())?;
            opensesame_proof::assert_proof_key_strength(&jwk).map_err(|_| fail())?;
            if keys
                .insert(kid, DecodingKey::from_jwk(&jwk).map_err(|_| fail())?)
                .is_some()
            {
                return Err(fail());
            }
        }
        Ok(Self { issuer, keys })
    }

    pub fn verify(
        &self,
        token: &str,
        audience: &str,
        now: i64,
    ) -> Result<HostEvidence, &'static str> {
        const INVALID: &str = "invalid_host_authorization";
        if token.len() > 16384 {
            return Err(INVALID);
        }
        let header = token.split('.').next().ok_or(INVALID)?;
        let bytes = URL_SAFE_NO_PAD.decode(header).map_err(|_| INVALID)?;
        let header: EvidenceHeader = serde_json::from_slice(&bytes).map_err(|_| INVALID)?;
        if header.typ != "host-authorization+jwt" || header.alg != "RS256" {
            return Err(INVALID);
        }
        let key = self.keys.get(&header.kid).ok_or(INVALID)?;
        let mut policy = Validation::new(Algorithm::RS256);
        policy.set_issuer(&[&self.issuer]);
        policy.set_audience(&[audience]);
        policy.leeway = 0;
        // All time claims use the same caller-supplied verification instant below.
        policy.validate_exp = false;
        policy.validate_nbf = false;
        let evidence = decode::<HostEvidence>(token, key, &policy)
            .map_err(|_| INVALID)?
            .claims;
        if evidence.host_audience != audience
            || evidence.expires_at < evidence.exp
            || evidence.iat > now
            || evidence.nbf.is_some_and(|not_before| not_before > now)
            || evidence.auth_time > now
            || evidence.auth_time < now.saturating_sub(300)
            || evidence.exp <= now
            || evidence.exp > evidence.iat.saturating_add(300)
            || evidence.iat < evidence.auth_time
            || evidence.jti.len() < 16
            || evidence.jti.len() > 128
            || evidence.assurance != "phishing_resistant"
            || evidence.amr != ["webauthn"]
            || crate::session_claims::parse_principal(&evidence.sub).is_none()
            || opensesame_domain::OrganizationId::parse(&evidence.organization_id).is_err()
        {
            return Err(INVALID);
        }
        Ok(evidence)
    }
}
