//! RFC 9421 HTTP Message Signatures — OpenSesame-supported subset.
//!
//! Covers: `content-digest`, `@method`, `@target-uri` with Ed25519.
//! Does NOT implement full RFC 9421 component catalog interoperability.

use crate::ProofError;
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use opensesame_domain::{
    ProtocolProfile, TokenPresentation, PROFILE_HTTP_MESSAGE_SIGNATURES_RFC9421_V1,
};
use std::collections::HashMap;

/// Incoming signed HTTP request fields (header values as received).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HttpSignedRequest {
    pub method: String,
    pub target_uri: String,
    pub content_digest: String,
    pub signature_input: String,
    pub signature: String,
}

/// Validated HTTP message signature context.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ValidatedHttpMessageSignature {
    pub key_id: String,
    pub created: i64,
    pub algorithm: String,
}

pub trait HttpMessageSignatureValidator: Send + Sync {
    fn validate(
        &self,
        request: &HttpSignedRequest,
    ) -> Result<ValidatedHttpMessageSignature, ProofError>;
}

/// Local Ed25519 validator keyed by `keyid`.
pub struct LocalHttpMessageSignatureValidator {
    keys: HashMap<String, VerifyingKey>,
    max_age_secs: i64,
}

impl LocalHttpMessageSignatureValidator {
    pub fn new(max_age_secs: i64) -> Self {
        Self {
            keys: HashMap::new(),
            max_age_secs,
        }
    }

    pub fn register_key(&mut self, key_id: impl Into<String>, key: VerifyingKey) {
        self.keys.insert(key_id.into(), key);
    }

    pub fn register_signing_key(&mut self, key_id: impl Into<String>, signing_key: &SigningKey) {
        self.register_key(key_id, signing_key.verifying_key());
    }
}

struct ParsedSignatureInput {
    label: String,
    covered: Vec<String>,
    created: i64,
    key_id: String,
    algorithm: String,
}

impl HttpMessageSignatureValidator for LocalHttpMessageSignatureValidator {
    fn validate(
        &self,
        request: &HttpSignedRequest,
    ) -> Result<ValidatedHttpMessageSignature, ProofError> {
        let profile = ProtocolProfile::parse_slug(PROFILE_HTTP_MESSAGE_SIGNATURES_RFC9421_V1)
            .map_err(ProofError::Domain)?;
        crate::validator::assert_token_presentation(
            &profile,
            TokenPresentation::HttpMessageSignature,
        )?;

        let parsed = parse_signature_input(&request.signature_input)?;

        if parsed.algorithm != "ed25519" {
            return Err(ProofError::InvalidProof(format!(
                "unsupported algorithm: {}",
                parsed.algorithm
            )));
        }

        let now = chrono::Utc::now().timestamp();
        if parsed.created + self.max_age_secs < now {
            return Err(ProofError::InvalidProof("signature expired".into()));
        }

        let verifying_key = self
            .keys
            .get(&parsed.key_id)
            .ok_or_else(|| ProofError::InvalidProof(format!("unknown keyid: {}", parsed.key_id)))?;

        let signature_base =
            build_signature_base(&parsed.covered, request, &request.signature_input)?;

        let sig_bytes = B64
            .decode(signature_value(&request.signature, &parsed.label)?)
            .map_err(|e| ProofError::InvalidProof(format!("signature base64: {e}")))?;
        let signature = Signature::from_slice(&sig_bytes)
            .map_err(|e| ProofError::InvalidProof(format!("signature bytes: {e}")))?;

        verifying_key
            .verify(signature_base.as_bytes(), &signature)
            .map_err(|_| ProofError::InvalidProof("signature verification failed".into()))?;

        Ok(ValidatedHttpMessageSignature {
            key_id: parsed.key_id,
            created: parsed.created,
            algorithm: parsed.algorithm,
        })
    }
}

/// Sign a request for tests and local development.
pub fn sign_request(
    signing_key: &SigningKey,
    key_id: &str,
    method: &str,
    target_uri: &str,
    body: &[u8],
    created: i64,
) -> HttpSignedRequest {
    let digest = content_digest_sha256(body);
    let covered = vec![
        "content-digest".to_string(),
        "@method".to_string(),
        "@target-uri".to_string(),
    ];
    let signature_input = format!(
        "sig=({});created={created};keyid=\"{key_id}\";alg=\"ed25519\"",
        covered
            .iter()
            .map(|c| format!("\"{c}\""))
            .collect::<Vec<_>>()
            .join(" ")
    );
    let req = HttpSignedRequest {
        method: method.to_string(),
        target_uri: target_uri.to_string(),
        content_digest: digest.clone(),
        signature_input: signature_input.clone(),
        signature: String::new(),
    };
    let signature_base = build_signature_base(&covered, &req, &signature_input).unwrap();
    let sig = signing_key.sign(signature_base.as_bytes());
    let signature = format!("sig=:{}:", B64.encode(sig.to_bytes()));
    HttpSignedRequest { signature, ..req }
}

pub fn content_digest_sha256(body: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let hash = Sha256::digest(body);
    format!("sha-256=:{}:", B64.encode(hash))
}

fn parse_signature_input(input: &str) -> Result<ParsedSignatureInput, ProofError> {
    let label = input.split('=').next().unwrap_or("sig").trim().to_string();
    let paren_start = input
        .find('(')
        .ok_or_else(|| ProofError::InvalidProof("missing covered components".into()))?;
    let paren_end = input
        .find(')')
        .ok_or_else(|| ProofError::InvalidProof("missing covered components end".into()))?;
    let inner = &input[paren_start + 1..paren_end];
    let covered: Vec<String> = inner
        .split_whitespace()
        .map(|c| c.trim_matches('"').to_string())
        .filter(|c| !c.is_empty())
        .collect();
    if covered.is_empty() {
        return Err(ProofError::InvalidProof("empty covered components".into()));
    }

    let mut created = None;
    let mut key_id = None;
    let mut algorithm = None;
    for part in input[paren_end + 1..].split(';') {
        let part = part.trim();
        if let Some(v) = part.strip_prefix("created=") {
            created = Some(
                v.parse::<i64>()
                    .map_err(|e| ProofError::InvalidProof(format!("created: {e}")))?,
            );
        } else if let Some(v) = part.strip_prefix("keyid=") {
            key_id = Some(v.trim_matches('"').to_string());
        } else if let Some(v) = part.strip_prefix("alg=") {
            algorithm = Some(v.trim_matches('"').to_string());
        }
    }

    Ok(ParsedSignatureInput {
        label,
        covered,
        created: created.ok_or_else(|| ProofError::InvalidProof("missing created".into()))?,
        key_id: key_id.ok_or_else(|| ProofError::InvalidProof("missing keyid".into()))?,
        algorithm: algorithm.ok_or_else(|| ProofError::InvalidProof("missing alg".into()))?,
    })
}

fn signature_value(signature_header: &str, label: &str) -> Result<String, ProofError> {
    let prefix = format!("{label}=:");
    let start = signature_header
        .find(&prefix)
        .ok_or_else(|| ProofError::InvalidProof("missing signature label".into()))?
        + prefix.len();
    let end = signature_header[start..]
        .find(':')
        .ok_or_else(|| ProofError::InvalidProof("malformed signature".into()))?
        + start;
    Ok(signature_header[start..end].to_string())
}

fn build_signature_base(
    covered: &[String],
    request: &HttpSignedRequest,
    signature_input: &str,
) -> Result<String, ProofError> {
    let mut lines = Vec::new();
    for component in covered {
        let value = match component.as_str() {
            "content-digest" => request.content_digest.clone(),
            "@method" => request.method.to_uppercase(),
            "@target-uri" => request.target_uri.clone(),
            other => {
                return Err(ProofError::InvalidProof(format!(
                    "unsupported component: {other}"
                )));
            }
        };
        lines.push(format!("\"{component}\": {value}"));
    }
    lines.push(format!("\"@signature-params\": {signature_input}"));
    Ok(lines.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::rngs::OsRng;

    fn fixture() -> (SigningKey, LocalHttpMessageSignatureValidator) {
        let signing_key = SigningKey::generate(&mut OsRng);
        let mut validator = LocalHttpMessageSignatureValidator::new(300);
        validator.register_signing_key("test-key", &signing_key);
        (signing_key, validator)
    }

    #[test]
    fn valid_signature_accepts() {
        let (signing_key, validator) = fixture();
        let body = br#"{"hello":"world"}"#;
        let signed = sign_request(
            &signing_key,
            "test-key",
            "POST",
            "https://host.example/api/v1/tasks",
            body,
            chrono::Utc::now().timestamp(),
        );
        assert!(validator.validate(&signed).is_ok());
    }

    #[test]
    fn mutated_body_rejects() {
        let (signing_key, validator) = fixture();
        let body = br#"{"hello":"world"}"#;
        let mut signed = sign_request(
            &signing_key,
            "test-key",
            "POST",
            "https://host.example/api/v1/tasks",
            body,
            chrono::Utc::now().timestamp(),
        );
        signed.content_digest = content_digest_sha256(b"mutated");
        assert!(validator.validate(&signed).is_err());
    }

    #[test]
    fn replay_signature_with_different_content_rejects() {
        let (signing_key, validator) = fixture();
        let body = br#"{"a":1}"#;
        let signed = sign_request(
            &signing_key,
            "test-key",
            "POST",
            "https://host.example/api/v1/tasks",
            body,
            chrono::Utc::now().timestamp(),
        );
        let replay = HttpSignedRequest {
            content_digest: content_digest_sha256(b"different body"),
            ..signed
        };
        assert!(validator.validate(&replay).is_err());
    }

    #[test]
    fn profile_registered() {
        let profile =
            ProtocolProfile::parse_slug(PROFILE_HTTP_MESSAGE_SIGNATURES_RFC9421_V1).unwrap();
        assert_eq!(
            profile.minimum_presentation,
            TokenPresentation::HttpMessageSignature
        );
    }
}
