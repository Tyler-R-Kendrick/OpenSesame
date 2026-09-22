//! The immutable identity of a request: SHA-256 over a canonical
//! serialization of the facts a decision is bound to.
//!
//! Two requests with the same nonce and user key but different claims (a
//! different token, a different chain, a different client kind) have
//! different digests, so a decision made for one can never be replayed for
//! the other. The digest deliberately covers a *hash* of the credential,
//! never the credential.

use serde::Serialize;
use sha2::{Digest as _, Sha256};

use crate::model::AuthorizationRequestClaims;

/// Canonical form. Field order is the serialization order (alphabetical), and
/// every value is either a string, a list of strings, or a hex digest.
#[derive(Serialize)]
struct Canonical<'a> {
    client_kind: &'a str,
    client_type: &'a str,
    connect_jwt_sha256: String,
    connect_token_sha256: String,
    request_nonce: &'a str,
    server_id: &'a str,
    tls_verified_chain_sha256: Vec<String>,
    user_nkey: &'a str,
    version: u32,
}

/// Hex SHA-256 request digest.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct RequestDigest(String);

impl RequestDigest {
    /// Compute the digest of verified claims.
    #[must_use]
    pub fn compute(claims: &AuthorizationRequestClaims) -> Self {
        let nats = &claims.nats;
        let token = if nats.connect_opts.auth_token.is_empty() {
            nats.connect_opts.pass.as_str()
        } else {
            nats.connect_opts.auth_token.as_str()
        };
        let chain = nats
            .client_tls
            .as_ref()
            .and_then(|tls| tls.verified_chains.first())
            .map(|chain| chain.iter().map(|pem| chain_entry_sha256(pem)).collect())
            .unwrap_or_default();
        let canonical = Canonical {
            client_kind: &nats.client_info.kind,
            client_type: &nats.client_info.client_type,
            connect_jwt_sha256: sha256_hex(nats.connect_opts.jwt.as_bytes()),
            connect_token_sha256: sha256_hex(token.as_bytes()),
            request_nonce: &nats.request_nonce,
            server_id: &nats.server_id.id,
            tls_verified_chain_sha256: chain,
            user_nkey: &nats.user_nkey,
            version: 1,
        };
        // A struct of strings and vectors cannot fail to serialize.
        let bytes = serde_json::to_vec(&canonical).unwrap_or_default();
        Self(sha256_hex(&bytes))
    }

    /// Wrap an already-computed hex digest after checking its shape.
    #[must_use]
    pub fn parse(hex64: &str) -> Option<Self> {
        let ok = hex64.len() == 64
            && hex64
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
        ok.then(|| Self(hex64.to_owned()))
    }

    /// The hex digest.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for RequestDigest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// SHA-256 of a chain entry: over the DER when the entry is PEM, over the
/// raw text otherwise (a malformed entry still gets a stable identity).
#[must_use]
pub fn chain_entry_sha256(entry: &str) -> String {
    match pem_to_der(entry) {
        Some(der) => sha256_hex(&der),
        None => sha256_hex(entry.as_bytes()),
    }
}

/// Decode the first `CERTIFICATE` PEM block of `entry`.
#[must_use]
pub fn pem_to_der(entry: &str) -> Option<Vec<u8>> {
    use base64::Engine as _;
    let start = entry.find("-----BEGIN CERTIFICATE-----")?;
    let rest = &entry[start + "-----BEGIN CERTIFICATE-----".len()..];
    let end = rest.find("-----END CERTIFICATE-----")?;
    let body: String = rest[..end].chars().filter(|c| !c.is_whitespace()).collect();
    base64::engine::general_purpose::STANDARD.decode(body).ok()
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fixtures::Parties;
    use crate::model::ClientTls;

    #[test]
    fn digest_is_stable_and_credential_blind() {
        let p = Parties::generate();
        let claims = p.request_claims(1, "token-a");
        let a = RequestDigest::compute(&claims);
        assert_eq!(a, RequestDigest::compute(&claims));
        assert_eq!(a.as_str().len(), 64);
        assert!(!serde_json::to_string(&claims).unwrap().contains(a.as_str()));
        assert!(RequestDigest::parse(a.as_str()).is_some());
        assert!(RequestDigest::parse("abc").is_none());
        assert!(RequestDigest::parse(&a.as_str().to_uppercase()).is_none());
    }

    #[test]
    fn changed_claims_change_the_digest_even_with_the_same_nonce() {
        let p = Parties::generate();
        let base = p.request_claims(1, "token-a");
        let mut other_token = base.clone();
        other_token.nats.connect_opts.auth_token = "token-b".into();
        let mut other_kind = base.clone();
        other_kind.nats.client_info.kind = "Leafnode".into();
        let mut with_chain = base.clone();
        with_chain.nats.client_tls = Some(ClientTls {
            verified_chains: vec![vec!["-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----".into()]],
            ..ClientTls::default()
        });
        let mut only_presented = base.clone();
        only_presented.nats.client_tls = Some(ClientTls {
            certs: vec!["-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----".into()],
            ..ClientTls::default()
        });
        let d = RequestDigest::compute(&base);
        assert_ne!(d, RequestDigest::compute(&other_token));
        assert_ne!(d, RequestDigest::compute(&other_kind));
        assert_ne!(d, RequestDigest::compute(&with_chain));
        // Unverified `certs` are not part of the request's identity.
        assert_eq!(d, RequestDigest::compute(&only_presented));
    }

    #[test]
    fn pem_decoding_is_lenient_on_whitespace_and_strict_on_markers() {
        let pem = "-----BEGIN CERTIFICATE-----\n AAEC \n-----END CERTIFICATE-----\n";
        assert_eq!(pem_to_der(pem), Some(vec![0, 1, 2]));
        assert_eq!(pem_to_der("AAEC"), None);
        assert_eq!(chain_entry_sha256("garbage"), chain_entry_sha256("garbage"));
        assert_ne!(chain_entry_sha256(pem), chain_entry_sha256("garbage"));
    }
}
