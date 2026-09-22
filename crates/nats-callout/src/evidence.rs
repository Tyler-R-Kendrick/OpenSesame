//! What a verified request says about the *end user*.
//!
//! Two kinds of evidence exist and both are forwarded to the Host, which is
//! the only party that verifies them:
//!
//! - an **upstream token** — the OIDC/Identity JWT the client put in
//!   `connect_opts.auth_token` (or, for clients that can only send a
//!   password, in `connect_opts.pass`);
//! - the **server-verified TLS chain** — `client_tls.verified_chains[0]`,
//!   leaf first, which nats-server built against its own client CA.
//!
//! `client_tls.certs` — whatever bytes the client *presented* — is never
//! evidence and is never forwarded: a certificate is public.

use serde::{Deserialize, Serialize};

use crate::model::AuthorizationRequestClaims;

/// Evidence extracted from a verified request.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExtractedEvidence {
    /// A compact JWS the client sent; verified by the Host, never here.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub upstream_token: Option<String>,
    /// PEM entries of the first server-verified chain, leaf first.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tls_verified_chain: Option<Vec<String>>,
}

impl ExtractedEvidence {
    /// True when nothing verifiable was carried.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.upstream_token.is_none() && self.tls_verified_chain.is_none()
    }
}

/// Largest upstream token forwarded (a JWT with a large id_token-style
/// claim set is a few KiB).
pub const MAX_TOKEN_BYTES: usize = 16 * 1024;
/// Most chain entries forwarded (leaf + intermediates; a root is pointless).
pub const MAX_CHAIN_ENTRIES: usize = 5;

/// Does this look like a compact JWS (three base64url segments)?
#[must_use]
pub fn looks_like_jws(candidate: &str) -> bool {
    if candidate.is_empty() || candidate.len() > MAX_TOKEN_BYTES {
        return false;
    }
    let mut segments = 0;
    for segment in candidate.split('.') {
        segments += 1;
        if segment.is_empty()
            || !segment
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        {
            return false;
        }
    }
    segments == 3
}

/// Extract the end-user evidence from verified claims.
#[must_use]
pub fn extract(claims: &AuthorizationRequestClaims) -> ExtractedEvidence {
    let opts = &claims.nats.connect_opts;
    let upstream_token = [opts.auth_token.as_str(), opts.pass.as_str()]
        .into_iter()
        .find(|candidate| looks_like_jws(candidate))
        .map(str::to_owned);
    let tls_verified_chain = claims
        .nats
        .client_tls
        .as_ref()
        .and_then(|tls| tls.verified_chains.first())
        .filter(|chain| !chain.is_empty() && chain.len() <= MAX_CHAIN_ENTRIES)
        .filter(|chain| chain.iter().all(|entry| crate::digest::pem_to_der(entry).is_some()))
        .cloned();
    ExtractedEvidence {
        upstream_token,
        tls_verified_chain,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fixtures::Parties;
    use crate::model::ClientTls;

    const PEM: &str = "-----BEGIN CERTIFICATE-----\nAAEC\n-----END CERTIFICATE-----";

    #[test]
    fn token_comes_from_auth_token_then_pass_and_must_look_like_a_jws() {
        let p = Parties::generate();
        let claims = p.request_claims(1, "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln");
        assert_eq!(
            extract(&claims).upstream_token.as_deref(),
            Some("eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln")
        );
        let mut claims = p.request_claims(1, "");
        claims.nats.connect_opts.pass = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln".into();
        assert!(extract(&claims).upstream_token.is_some());
        let mut claims = p.request_claims(1, "");
        claims.nats.connect_opts.pass = "hunter2".into();
        let evidence = extract(&claims);
        assert!(evidence.upstream_token.is_none());
        assert!(evidence.is_empty());
    }

    #[test]
    fn only_verified_chains_are_evidence() {
        let p = Parties::generate();
        let mut claims = p.request_claims(1, "");
        claims.nats.client_tls = Some(ClientTls {
            certs: vec![PEM.into()],
            ..ClientTls::default()
        });
        assert!(extract(&claims).tls_verified_chain.is_none());
        claims.nats.client_tls = Some(ClientTls {
            certs: vec!["-----BEGIN CERTIFICATE-----\nZZZZ\n-----END CERTIFICATE-----".into()],
            verified_chains: vec![vec![PEM.into(), PEM.into()]],
            ..ClientTls::default()
        });
        let chain = extract(&claims).tls_verified_chain.unwrap();
        assert_eq!(chain.len(), 2);
        assert!(!chain.iter().any(|c| c.contains("ZZZZ")));
    }

    #[test]
    fn chain_bounds_and_shape_are_enforced() {
        let p = Parties::generate();
        let mut claims = p.request_claims(1, "");
        claims.nats.client_tls = Some(ClientTls {
            verified_chains: vec![vec![PEM.into(); MAX_CHAIN_ENTRIES + 1]],
            ..ClientTls::default()
        });
        assert!(extract(&claims).tls_verified_chain.is_none());
        claims.nats.client_tls = Some(ClientTls {
            verified_chains: vec![vec!["not pem".into()]],
            ..ClientTls::default()
        });
        assert!(extract(&claims).tls_verified_chain.is_none());
        claims.nats.client_tls = Some(ClientTls {
            verified_chains: vec![vec![]],
            ..ClientTls::default()
        });
        assert!(extract(&claims).tls_verified_chain.is_none());
    }

    #[test]
    fn jws_shape_check() {
        assert!(looks_like_jws("a.b.c"));
        assert!(!looks_like_jws("a.b"));
        assert!(!looks_like_jws("a..c"));
        assert!(!looks_like_jws("a.b.c.d"));
        assert!(!looks_like_jws("a.b=.c"));
        assert!(!looks_like_jws(&"a".repeat(MAX_TOKEN_BYTES + 1)));
    }
}
