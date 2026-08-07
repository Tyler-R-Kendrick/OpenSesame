use crate::ProofError;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use ed25519_dalek::SigningKey;
use jsonwebtoken::jwk::Jwk;
use jsonwebtoken::jwk::{
    AlgorithmParameters, CommonParameters, EllipticCurve, OctetKeyPairParameters, OctetKeyPairType,
};
use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const DPOP_TYP: &str = "dpop+jwt";

/// Public JWK embedded in DPoP proofs.
pub type DpopPublicJwk = Jwk;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DpopClaims {
    pub jti: String,
    pub htm: String,
    pub htu: String,
    pub iat: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ath: Option<String>,
}

pub fn access_token_hash(access_token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(access_token.as_bytes());
    URL_SAFE_NO_PAD.encode(hasher.finalize())
}

pub fn normalize_htu(url: &str) -> Result<String, ProofError> {
    let parsed = url::Url::parse(url).map_err(|e| ProofError::InvalidProof(e.to_string()))?;
    let host = parsed
        .host_str()
        .ok_or_else(|| ProofError::InvalidProof("htu missing host".into()))?;
    Ok(match parsed.port() {
        Some(port) => format!("{}://{}:{}{}", parsed.scheme(), host, port, parsed.path()),
        None => format!("{}://{}{}", parsed.scheme(), host, parsed.path()),
    })
}

/// RFC 7638 JWK thumbprint (base64url-encoded SHA-256).
pub fn jwk_thumbprint(jwk: &Jwk) -> Result<String, ProofError> {
    let canonical = match &jwk.algorithm {
        AlgorithmParameters::OctetKeyPair(params) => {
            let crv = match params.curve {
                EllipticCurve::Ed25519 => "Ed25519",
                EllipticCurve::P256 => "P-256",
                EllipticCurve::P384 => "P-384",
                EllipticCurve::P521 => "P-521",
            };
            serde_json::json!({
                "crv": crv,
                "kty": "OKP",
                "x": params.x,
            })
        }
        AlgorithmParameters::RSA(params) => {
            serde_json::json!({
                "e": params.e,
                "kty": "RSA",
                "n": params.n,
            })
        }
        _ => {
            return Err(ProofError::InvalidProof(
                "unsupported JWK for thumbprint".into(),
            ));
        }
    };
    let bytes =
        serde_json::to_vec(&canonical).map_err(|e| ProofError::InvalidProof(e.to_string()))?;
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    Ok(URL_SAFE_NO_PAD.encode(hasher.finalize()))
}

fn decode_header(proof_jwt: &str) -> Result<Header, ProofError> {
    let encoded = proof_jwt
        .split('.')
        .next()
        .ok_or_else(|| ProofError::InvalidProof("malformed jwt".into()))?;
    let decoded = URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|e| ProofError::InvalidProof(e.to_string()))?;
    serde_json::from_slice(&decoded).map_err(|e| ProofError::InvalidProof(e.to_string()))
}

pub fn decode_dpop_proof(
    proof_jwt: &str,
    expected_htm: &str,
    expected_htu: &str,
    expected_ath: Option<&str>,
    max_age_secs: i64,
    now: i64,
) -> Result<(DpopClaims, Jwk, String), ProofError> {
    let header = decode_header(proof_jwt)?;

    let typ = header
        .typ
        .as_deref()
        .ok_or_else(|| ProofError::InvalidProof("missing typ".into()))?;
    if typ != DPOP_TYP {
        return Err(ProofError::InvalidProof(format!(
            "expected typ {DPOP_TYP}, got {typ}"
        )));
    }

    if header.alg != Algorithm::EdDSA && header.alg != Algorithm::RS256 {
        return Err(ProofError::UnsupportedAlgorithm(format!(
            "{:?}",
            header.alg
        )));
    }

    let jwk = header
        .jwk
        .clone()
        .ok_or_else(|| ProofError::InvalidProof("missing jwk header".into()))?;
    let jkt = jwk_thumbprint(&jwk)?;

    let decoding_key =
        DecodingKey::from_jwk(&jwk).map_err(|e| ProofError::InvalidProof(e.to_string()))?;
    // DPoP proofs use iat (not exp/nbf); clear JWT defaults and pin alg to header.
    let mut validation = Validation::new(header.alg);
    validation.validate_exp = false;
    validation.validate_nbf = false;
    validation.required_spec_claims.clear();
    validation.validate_aud = false;

    let token_data = jsonwebtoken::decode::<DpopClaims>(proof_jwt, &decoding_key, &validation)
        .map_err(|e| ProofError::InvalidProof(e.to_string()))?;
    let claims = token_data.claims;

    if !claims.htm.eq_ignore_ascii_case(expected_htm) {
        return Err(ProofError::InvalidProof("htm mismatch".into()));
    }

    let normalized_htu = normalize_htu(&claims.htu)?;
    let expected_normalized = normalize_htu(expected_htu)?;
    if normalized_htu != expected_normalized {
        return Err(ProofError::InvalidProof("htu mismatch".into()));
    }

    if now - claims.iat > max_age_secs {
        return Err(ProofError::InvalidProof("iat too old".into()));
    }
    if claims.iat > now + 60 {
        return Err(ProofError::InvalidProof("iat in future".into()));
    }

    match (expected_ath, claims.ath.as_deref()) {
        (Some(expected), Some(actual)) if expected == actual => {}
        (None, None) => {}
        (None, Some(_)) => {
            return Err(ProofError::InvalidProof("unexpected ath on proof".into()));
        }
        (Some(_), None) | (Some(_), Some(_)) => {
            return Err(ProofError::AccessTokenHashMismatch);
        }
    }

    Ok((claims, jwk, jkt))
}

pub fn ed25519_jwk_from_seed(seed: &[u8; 32]) -> (Jwk, EncodingKey) {
    let signing_key = SigningKey::from_bytes(seed);
    let x = URL_SAFE_NO_PAD.encode(signing_key.verifying_key().as_bytes());
    let jwk = Jwk {
        common: CommonParameters::default(),
        algorithm: AlgorithmParameters::OctetKeyPair(OctetKeyPairParameters {
            key_type: OctetKeyPairType::OctetKeyPair,
            curve: EllipticCurve::Ed25519,
            x,
        }),
    };
    let encoding_key = EncodingKey::from_ed_der(&ed25519_private_der(seed));
    (jwk, encoding_key)
}

fn ed25519_private_der(seed: &[u8; 32]) -> Vec<u8> {
    let mut der = vec![
        0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04,
        0x20,
    ];
    der.extend_from_slice(seed);
    der
}

pub fn sign_dpop_proof(
    jwk: &Jwk,
    encoding_key: &EncodingKey,
    claims: &DpopClaims,
) -> Result<String, ProofError> {
    let mut header = Header::new(Algorithm::EdDSA);
    header.typ = Some(DPOP_TYP.to_string());
    header.jwk = Some(jwk.clone());
    jsonwebtoken::encode(&header, claims, encoding_key)
        .map_err(|e| ProofError::InvalidProof(e.to_string()))
}
