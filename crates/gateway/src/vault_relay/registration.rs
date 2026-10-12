//! Operator-pinned registration JWTs for org directory and publish policy.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use jsonwebtoken::{decode, jwk::Jwk, Algorithm, DecodingKey, Validation};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

use super::admit::OrgRole;

pub(crate) const REGISTRATION: &str = "x-opensesame-registration";
const TYP: &str = "vault-relay-registration+jwt";
const AUDIENCE: &str = "vault-relay";

#[derive(Clone)]
pub(crate) struct Verifier {
    issuer: String,
    keys: BTreeMap<String, DecodingKey>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TokenHeader {
    alg: String,
    typ: String,
    kid: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Claims {
    pub iss: String,
    pub aud: String,
    pub sub: String,
    pub exp: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nbf: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub org_role: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Identity {
    pub(crate) principal: String,
    pub(crate) role: Option<OrgRole>,
    /// Organization or user handle the registration is minted for.
    pub(crate) owner: Option<String>,
}

impl Verifier {
    pub(crate) fn from_env() -> Result<Option<Self>, String> {
        match (
            std::env::var("OPENSESAME_VAULT_RELAY_ISSUER").ok(),
            std::env::var("OPENSESAME_VAULT_RELAY_REGISTRATION_JWKS_JSON").ok(),
        ) {
            (None, None) => Ok(None),
            (Some(issuer), Some(keys)) => Self::new(issuer, &keys).map(Some),
            _ => Err("Vault relay registration requires an issuer and registration JWKS".into()),
        }
    }

    pub(crate) fn new(issuer: String, encoded: &str) -> Result<Self, String> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct KeySet {
            keys: Vec<serde_json::Value>,
        }
        let fail = || "Invalid vault relay registration trust configuration".to_string();
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

    pub(crate) fn verify(&self, token: &str, now: i64) -> Result<Claims, &'static str> {
        const INVALID: &str = "invalid_registration";
        if token.len() > 16384 {
            return Err(INVALID);
        }
        let header = token.split('.').next().ok_or(INVALID)?;
        let bytes = URL_SAFE_NO_PAD.decode(header).map_err(|_| INVALID)?;
        let header: TokenHeader = serde_json::from_slice(&bytes).map_err(|_| INVALID)?;
        if header.typ != TYP || header.alg != "RS256" {
            return Err(INVALID);
        }
        let key = self.keys.get(&header.kid).ok_or(INVALID)?;
        let mut policy = Validation::new(Algorithm::RS256);
        policy.set_issuer(&[&self.issuer]);
        policy.set_audience(&[AUDIENCE]);
        policy.leeway = 0;
        policy.validate_exp = false;
        policy.validate_nbf = false;
        let claims = decode::<Claims>(token, key, &policy)
            .map_err(|_| INVALID)?
            .claims;
        if claims.aud != AUDIENCE
            || claims.sub.is_empty()
            || claims.sub.len() > 128
            || claims.exp <= now
            || claims.exp > now.saturating_add(300)
            || claims.nbf.is_some_and(|nbf| nbf > now)
        {
            return Err(INVALID);
        }
        if claims
            .owner
            .as_deref()
            .is_some_and(|owner| owner.is_empty() || owner.len() > 63)
        {
            return Err(INVALID);
        }
        if claims
            .org_role
            .as_deref()
            .is_some_and(|role| parse_role(role).is_none())
        {
            return Err(INVALID);
        }
        Ok(claims)
    }

    pub(crate) fn identity_from_claims(claims: &Claims) -> Identity {
        Identity {
            principal: claims.sub.clone(),
            role: claims.org_role.as_deref().and_then(parse_role),
            owner: claims.owner.clone(),
        }
    }
}

fn parse_role(value: &str) -> Option<OrgRole> {
    match value {
        "owner" => Some(OrgRole::Owner),
        "admin" => Some(OrgRole::Admin),
        "member" => Some(OrgRole::Member),
        _ => None,
    }
}

pub(crate) fn token_from_headers(headers: &axum::http::HeaderMap) -> Option<String> {
    if let Some(value) = headers.get(REGISTRATION) {
        return value
            .to_str()
            .ok()
            .map(str::trim)
            .filter(|token| !token.is_empty())
            .map(str::to_owned);
    }
    let value = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())?;
    let token = value
        .strip_prefix("Bearer ")
        .or_else(|| value.strip_prefix("bearer "))?;
    let token = token.trim();
    if token.is_empty() {
        None
    } else {
        Some(token.to_owned())
    }
}
