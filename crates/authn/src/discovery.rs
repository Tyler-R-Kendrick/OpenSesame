//! Fail-closed OIDC discovery document parsing.
//!
//! A missing `issuer` or `jwks_uri` is not a document we will use. HTTP(S)
//! only; userinfo in the URL is rejected. The issuer string we accept is the
//! one in the document — callers compare it to the configured issuer.

use crate::token::TokenValidationError;
use serde::{Deserialize, Serialize};
use url::Url;

/// Hard ceiling so a huge document cannot become a parser DoS.
pub const MAX_DISCOVERY_BYTES: usize = 4096;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct OidcDiscovery {
    pub issuer: String,
    pub jwks_uri: String,
    #[serde(default)]
    pub authorization_endpoint: Option<String>,
    #[serde(default)]
    pub token_endpoint: Option<String>,
    #[serde(default)]
    pub device_authorization_endpoint: Option<String>,
}

impl OidcDiscovery {
    /// Absolute HTTPS (or loopback HTTP) URL with no userinfo.
    pub fn issuer_url(&self) -> Result<Url, TokenValidationError> {
        parse_metadata_url(&self.issuer)
    }

    pub fn jwks_url(&self) -> Result<Url, TokenValidationError> {
        parse_metadata_url(&self.jwks_uri)
    }
}

pub fn parse_oidc_discovery(bytes: &[u8]) -> Result<OidcDiscovery, TokenValidationError> {
    if bytes.len() > MAX_DISCOVERY_BYTES {
        return Err(TokenValidationError::MalformedDiscovery);
    }
    let doc: OidcDiscovery = serde_json::from_slice(bytes)
        .map_err(|_| TokenValidationError::MalformedDiscovery)?;
    if doc.issuer.is_empty() || doc.jwks_uri.is_empty() {
        return Err(TokenValidationError::MalformedDiscovery);
    }
    let issuer = parse_metadata_url(&doc.issuer)?;
    let jwks = parse_metadata_url(&doc.jwks_uri)?;
    // Fragment is never part of an issuer identifier (OIDC Core §1.4).
    if issuer.fragment().is_some() || jwks.fragment().is_some() {
        return Err(TokenValidationError::MalformedDiscovery);
    }
    Ok(doc)
}

/// Bind a presented issuer to the configured one. Scheme/host/port/path must
/// match after trailing-slash trim; a suffix host is not the same issuer.
pub fn assert_discovery_issuer(
    document: &OidcDiscovery,
    configured_issuer: &str,
) -> Result<(), TokenValidationError> {
    let got = parse_metadata_url(&document.issuer)?;
    let expected = parse_metadata_url(configured_issuer)?;
    let trim = |u: &Url| {
        let mut s = u.as_str().trim_end_matches('/').to_string();
        if let Some(stripped) = s.strip_suffix('/') {
            s = stripped.to_string();
        }
        s
    };
    if trim(&got) != trim(&expected) {
        return Err(TokenValidationError::IssuerMixUp);
    }
    Ok(())
}

fn parse_metadata_url(raw: &str) -> Result<Url, TokenValidationError> {
    let url = Url::parse(raw).map_err(|_| TokenValidationError::MalformedDiscovery)?;
    match url.scheme() {
        "https" => {}
        "http" => {
            let host = url.host_str().unwrap_or("");
            if host != "127.0.0.1" && host != "localhost" && host != "::1" {
                return Err(TokenValidationError::MalformedDiscovery);
            }
        }
        _ => return Err(TokenValidationError::MalformedDiscovery),
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(TokenValidationError::MalformedDiscovery);
    }
    if url.host_str().is_none() {
        return Err(TokenValidationError::MalformedDiscovery);
    }
    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requires_issuer_and_jwks() {
        assert!(parse_oidc_discovery(br#"{"issuer":"https://idp.example"}"#).is_err());
        assert!(parse_oidc_discovery(br#"{"jwks_uri":"https://idp.example/jwks"}"#).is_err());
    }

    #[test]
    fn rejects_userinfo_and_http_public() {
        assert!(parse_oidc_discovery(
            br#"{"issuer":"https://user:pass@idp.example","jwks_uri":"https://idp.example/jwks"}"#
        )
        .is_err());
        assert!(parse_oidc_discovery(
            br#"{"issuer":"http://idp.example","jwks_uri":"https://idp.example/jwks"}"#
        )
        .is_err());
    }

    #[test]
    fn accepts_https_and_binds_issuer() {
        let doc = parse_oidc_discovery(
            br#"{"issuer":"https://idp.example","jwks_uri":"https://idp.example/jwks"}"#,
        )
        .unwrap();
        assert!(assert_discovery_issuer(&doc, "https://idp.example").is_ok());
        assert!(assert_discovery_issuer(&doc, "https://idp.example.evil.test").is_err());
    }
}
