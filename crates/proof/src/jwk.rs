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

/// Public JWK embedded in `DPoP` proofs.
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

#[must_use]
pub fn access_token_hash(access_token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(access_token.as_bytes());
    URL_SAFE_NO_PAD.encode(hasher.finalize())
}

///
/// # Errors
///
/// Returns an error when validation or the underlying operation fails.
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

/// Smallest RSA modulus accepted for a proof key.
///
/// A token bound to a 1024-bit key is bound to a key an observer can factor, and
/// once they hold the private key the confirmation claim confirms them.
pub const MIN_RSA_MODULUS_BITS: usize = 2048;
/// Ed25519 public keys are exactly this long; anything else is not one.
const ED25519_PUBLIC_KEY_LEN: usize = 32;

fn decode_b64(label: &str, value: &str) -> Result<Vec<u8>, ProofError> {
    URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|e| ProofError::InvalidProof(format!("{label}: {e}")))
}

/// Bit length of a big-endian integer, ignoring leading zero bytes.
fn bit_length(bytes: &[u8]) -> usize {
    match bytes.iter().position(|b| *b != 0) {
        None => 0,
        Some(i) => (bytes.len() - i - 1) * 8 + (8 - bytes[i].leading_zeros() as usize),
    }
}

/// Refuse proof keys that are the wrong shape or too weak to be worth binding to.
///
/// The proof is self-signed, so a weak key does not let an attacker forge one
/// directly — the fence is that `jkt` must match the token's confirmation claim.
/// It does mean a token bound to such a key can be taken over by anyone who
/// recovers the private key from the public one, which is the whole point of a
/// 512-bit modulus or an exponent of 1.
///
/// # Errors
///
/// Returns an error when validation or the underlying operation fails.
pub fn assert_proof_key_strength(jwk: &Jwk) -> Result<(), ProofError> {
    match &jwk.algorithm {
        AlgorithmParameters::OctetKeyPair(params) => {
            if params.curve != EllipticCurve::Ed25519 {
                return Err(ProofError::UnsupportedAlgorithm(format!(
                    "OKP curve {:?}",
                    params.curve
                )));
            }
            let x = decode_b64("okp x", &params.x)?;
            if x.len() != ED25519_PUBLIC_KEY_LEN {
                return Err(ProofError::WeakProofKey(format!(
                    "Ed25519 public key of {} bytes",
                    x.len()
                )));
            }
            Ok(())
        }
        AlgorithmParameters::RSA(params) => {
            let n = decode_b64("rsa n", &params.n)?;
            let bits = bit_length(&n);
            if bits < MIN_RSA_MODULUS_BITS {
                return Err(ProofError::WeakProofKey(format!(
                    "RSA modulus of {bits} bits is below the {MIN_RSA_MODULUS_BITS}-bit floor"
                )));
            }
            let e = decode_b64("rsa e", &params.e)?;
            let exponent_bits = bit_length(&e);
            let odd = e.last().is_some_and(|b| b % 2 == 1);
            // e = 1 makes a signature the message itself; an even e is not a
            // valid exponent at all.
            if exponent_bits < 2 || !odd {
                return Err(ProofError::WeakProofKey(
                    "RSA public exponent must be odd and greater than one".into(),
                ));
            }
            Ok(())
        }
        _ => Err(ProofError::UnsupportedAlgorithm(
            "proof key must be OKP (Ed25519) or RSA".into(),
        )),
    }
}

/// RFC 7638 JWK thumbprint (base64url-encoded SHA-256).
///
/// # Errors
///
/// Returns an error when validation or the underlying operation fails.
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
    let encoded_header = proof_jwt
        .split('.')
        .next()
        .ok_or_else(|| ProofError::InvalidProof("malformed jwt".into()))?;
    let header_bytes = URL_SAFE_NO_PAD
        .decode(encoded_header)
        .map_err(|e| ProofError::InvalidProof(e.to_string()))?;
    serde_json::from_slice(&header_bytes).map_err(|e| ProofError::InvalidProof(e.to_string()))
}

///
/// # Errors
///
/// Returns an error when validation or the underlying operation fails.
pub fn decode_dpop_proof(
    proof_jwt: &str,
    expected_method: &str,
    expected_uri: &str,
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
    assert_proof_key_strength(&jwk)?;
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

    if !claims.htm.eq_ignore_ascii_case(expected_method) {
        return Err(ProofError::InvalidProof("htm mismatch".into()));
    }

    let normalized_htu = normalize_htu(&claims.htu)?;
    let expected_normalized = normalize_htu(expected_uri)?;
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
        (Some(_), None | Some(_)) => {
            return Err(ProofError::AccessTokenHashMismatch);
        }
    }

    Ok((claims, jwk, jkt))
}

#[must_use]
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

///
/// # Errors
///
/// Returns an error when validation or the underlying operation fails.
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
