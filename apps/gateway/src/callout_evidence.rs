//! Verifying the **end user's** evidence in a NATS auth callout.
//!
//! Bridge authentication and end-user authentication are separate facts
//! (ADR 0130 / [R-CALLOUT]). The bridge proves only that a request arrived on
//! its authenticated NATS connection; this module is what turns the client's
//! CONNECT token into an authenticated `(issuer, subject)`. Mapping an
//! arbitrary issuer+subject is not authentication, so nothing here hands a
//! pair back until a signature has verified against a key fetched from the
//! issuer's own JWKS.
//!
//! The fetch reuses the Host's egress fences rather than inventing new ones:
//! the issuer must be on the operator allowlist, https (loopback http only
//! outside production), never a blocked host, resolved addresses re-checked
//! after DNS, no proxy, no redirects, bounded body and timeouts, and one
//! bounded per-issuer key cache.

use std::collections::BTreeMap;
use std::net::IpAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use jsonwebtoken::{decode, decode_header, jwk::Jwk, Algorithm, DecodingKey, Validation};
use serde::Deserialize;

#[cfg(test)]
#[path = "callout_evidence_tests.rs"]
mod tests;

/// Algorithms a callout token may be signed with. Symmetric algorithms and
/// `none` are absent by construction, not by check.
pub const ALLOWED_ALGORITHMS: [Algorithm; 4] = [
    Algorithm::RS256,
    Algorithm::RS384,
    Algorithm::ES256,
    Algorithm::EdDSA,
];
/// Largest token accepted.
pub const MAX_TOKEN_BYTES: usize = 16 * 1024;
/// Largest JWKS document accepted.
pub const MAX_JWKS_BYTES: usize = 64 * 1024;
/// Keys accepted from one issuer.
pub const MAX_KEYS: usize = 16;
/// How long a fetched key set is reused.
pub const CACHE_TTL: Duration = Duration::from_secs(300);

/// Why evidence was refused. Every value is a stable deny code.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EvidenceError {
    /// No verifiable end-user evidence was carried at all.
    Missing,
    /// The issuer is not on the Host allowlist.
    UnknownIssuer,
    /// The token is malformed, or its header names a disallowed algorithm.
    Malformed,
    /// The issuer's JWKS could not be fetched inside the egress fences.
    IssuerUnreachable,
    /// Signature, issuer, audience, expiry or a required claim failed.
    Invalid,
}

impl EvidenceError {
    /// The stable machine code.
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::Missing => "unsigned_evidence",
            Self::UnknownIssuer => "unknown_issuer",
            Self::Malformed => "malformed_evidence",
            Self::IssuerUnreachable => "issuer_unreachable",
            Self::Invalid => "invalid_token",
        }
    }
}

/// What a verified token asserts. `project_ids` is kept only so the caller
/// can see that it was *not* used: memberships come from Identity.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
pub struct VerifiedEvidence {
    #[serde(default)]
    pub iss: String,
    #[serde(default)]
    pub sub: String,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub exp: i64,
}

#[derive(Deserialize)]
struct KeySet {
    #[serde(default)]
    keys: Vec<serde_json::Value>,
}

/// Unverified issuer read from a token's payload, used only to choose which
/// allowlisted JWKS to fetch. Never an identity.
fn peek_issuer(token: &str) -> Result<String, EvidenceError> {
    let payload = token.split('.').nth(1).ok_or(EvidenceError::Malformed)?;
    let bytes = URL_SAFE_NO_PAD
        .decode(payload)
        .map_err(|_| EvidenceError::Malformed)?;
    let claims: VerifiedEvidence =
        serde_json::from_slice(&bytes).map_err(|_| EvidenceError::Malformed)?;
    if claims.iss.is_empty() || claims.iss.len() > 2048 {
        return Err(EvidenceError::Malformed);
    }
    Ok(claims.iss)
}

/// One issuer's JWKS endpoint, as the operator configured it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IssuerKeys {
    pub issuer: String,
    pub jwks_url: url::Url,
}

/// Parse `OPENSESAME_NATS_CALLOUT_ISSUER_JWKS`: `issuer=url` pairs separated
/// by commas. An entry that is not a bounded https (or loopback http) URL is
/// refused — a misconfigured issuer must not silently become "no evidence
/// required".
///
/// # Errors
///
/// The offending entry, for the operator log.
pub fn parse_issuer_jwks(spec: &str, allow_loopback_http: bool) -> Result<Vec<IssuerKeys>, String> {
    let mut out = Vec::new();
    for entry in spec.split(',').map(str::trim).filter(|e| !e.is_empty()) {
        let (issuer, raw) = entry.split_once('=').ok_or_else(|| entry.to_owned())?;
        let issuer = issuer.trim().to_owned();
        let url = url::Url::parse(raw.trim()).map_err(|_| entry.to_owned())?;
        let loopback = url.host_str().is_some_and(|h| {
            h == "localhost"
                || h.trim_matches(['[', ']'])
                    .parse::<IpAddr>()
                    .is_ok_and(|ip| ip.is_loopback())
        });
        if issuer.is_empty()
            || issuer.len() > 2048
            || url.as_str().len() > 2048
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
            || url.host_str().is_none_or(|h| h.ends_with('.'))
            || !(url.scheme() == "https"
                || (allow_loopback_http && loopback && url.scheme() == "http"))
        {
            return Err(entry.to_owned());
        }
        out.push(IssuerKeys {
            issuer,
            jwks_url: url,
        });
    }
    Ok(out)
}

struct Cached {
    keys: BTreeMap<String, DecodingKey>,
    fetched_at: Instant,
}

/// Verifies callout tokens against operator-configured issuer JWKS.
#[derive(Clone)]
pub struct CalloutEvidenceVerifier {
    issuers: Arc<Vec<IssuerKeys>>,
    audience: Option<String>,
    allow_private_endpoint: bool,
    cache: Arc<Mutex<BTreeMap<String, Cached>>>,
}

impl std::fmt::Debug for CalloutEvidenceVerifier {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CalloutEvidenceVerifier")
            .field("issuers", &self.issuers.len())
            .field("audience", &self.audience)
            .finish_non_exhaustive()
    }
}

impl CalloutEvidenceVerifier {
    /// Build from parsed issuers.
    #[must_use]
    pub fn new(
        issuers: Vec<IssuerKeys>,
        audience: Option<String>,
        allow_private_endpoint: bool,
    ) -> Self {
        Self {
            issuers: Arc::new(issuers),
            audience,
            allow_private_endpoint,
            cache: Arc::new(Mutex::new(BTreeMap::new())),
        }
    }

    /// True when no issuer is configured, so no token can ever verify.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.issuers.is_empty()
    }

    /// Seed the cache directly. Used by tests and by an operator who pins
    /// keys inline instead of fetching them.
    ///
    /// # Errors
    ///
    /// The JWKS document when a key is unusable.
    pub fn preload(&self, issuer: &str, jwks_json: &str) -> Result<(), EvidenceError> {
        let keys = parse_keys(jwks_json.as_bytes())?;
        if let Ok(mut cache) = self.cache.lock() {
            cache.insert(
                issuer.to_owned(),
                Cached {
                    keys,
                    fetched_at: Instant::now(),
                },
            );
        }
        Ok(())
    }

    /// Verify a token and return what it asserts.
    ///
    /// # Errors
    ///
    /// [`EvidenceError`] naming the first check that failed. Every one denies
    /// the callout; none of them fall back to a weaker credential.
    pub async fn verify(&self, token: &str, now: i64) -> Result<VerifiedEvidence, EvidenceError> {
        if token.is_empty() || token.len() > MAX_TOKEN_BYTES {
            return Err(EvidenceError::Malformed);
        }
        let issuer = peek_issuer(token)?;
        let configured = self
            .issuers
            .iter()
            .find(|entry| entry.issuer == issuer)
            .ok_or(EvidenceError::UnknownIssuer)?;
        let header = decode_header(token).map_err(|_| EvidenceError::Malformed)?;
        if !ALLOWED_ALGORITHMS.contains(&header.alg) {
            return Err(EvidenceError::Malformed);
        }
        let kid = header.kid.filter(|k| !k.is_empty() && k.len() <= 128);
        let keys = self.keys_for(configured).await?;
        let key = match &kid {
            Some(kid) => keys.get(kid).ok_or(EvidenceError::Invalid)?,
            // A key set with exactly one key needs no `kid`; more than one
            // without a `kid` is ambiguous and refused rather than guessed.
            None if keys.len() == 1 => keys.values().next().ok_or(EvidenceError::Invalid)?,
            None => return Err(EvidenceError::Invalid),
        };
        let mut policy = Validation::new(header.alg);
        policy.set_issuer(&[&issuer]);
        match &self.audience {
            Some(audience) => policy.set_audience(&[audience]),
            None => policy.validate_aud = false,
        }
        policy.leeway = 0;
        policy.validate_exp = false;
        policy.validate_nbf = false;
        policy.required_spec_claims = ["iss", "sub", "exp"]
            .into_iter()
            .map(str::to_owned)
            .collect();
        let claims = decode::<VerifiedEvidence>(token, key, &policy)
            .map_err(|_| EvidenceError::Invalid)?
            .claims;
        if claims.iss != issuer
            || claims.sub.is_empty()
            || claims.sub.len() > 1024
            || claims.exp <= now
        {
            return Err(EvidenceError::Invalid);
        }
        Ok(claims)
    }

    async fn keys_for(
        &self,
        issuer: &IssuerKeys,
    ) -> Result<BTreeMap<String, DecodingKey>, EvidenceError> {
        if let Ok(cache) = self.cache.lock() {
            if let Some(entry) = cache.get(&issuer.issuer) {
                if entry.fetched_at.elapsed() < CACHE_TTL {
                    return Ok(entry.keys.clone());
                }
            }
        }
        let body = fetch(&issuer.jwks_url, self.allow_private_endpoint).await?;
        let keys = parse_keys(&body)?;
        if let Ok(mut cache) = self.cache.lock() {
            cache.insert(
                issuer.issuer.clone(),
                Cached {
                    keys: keys.clone(),
                    fetched_at: Instant::now(),
                },
            );
        }
        Ok(keys)
    }
}

fn parse_keys(body: &[u8]) -> Result<BTreeMap<String, DecodingKey>, EvidenceError> {
    if body.len() > MAX_JWKS_BYTES {
        return Err(EvidenceError::Invalid);
    }
    let set: KeySet = serde_json::from_slice(body).map_err(|_| EvidenceError::Invalid)?;
    if set.keys.is_empty() || set.keys.len() > MAX_KEYS {
        return Err(EvidenceError::Invalid);
    }
    let mut out = BTreeMap::new();
    for (index, value) in set.keys.into_iter().enumerate() {
        // A JWKS is public material: a private parameter means the operator
        // pasted the wrong document, and we refuse rather than use it.
        if ["d", "p", "q", "dp", "dq", "qi", "oth", "k", "x5u", "jku"]
            .iter()
            .any(|name| value.get(name).is_some())
            || value.get("use").is_some_and(|usage| usage != "sig")
        {
            return Err(EvidenceError::Invalid);
        }
        let kid = value
            .get("kid")
            .and_then(serde_json::Value::as_str)
            .filter(|kid| !kid.is_empty() && kid.len() <= 128)
            .map_or_else(|| format!("#{index}"), str::to_owned);
        let jwk: Jwk = serde_json::from_value(value).map_err(|_| EvidenceError::Invalid)?;
        let key = DecodingKey::from_jwk(&jwk).map_err(|_| EvidenceError::Invalid)?;
        if out.insert(kid, key).is_some() {
            return Err(EvidenceError::Invalid);
        }
    }
    Ok(out)
}

/// Fetch a JWKS through the Host's egress fences.
async fn fetch(url: &url::Url, allow_private: bool) -> Result<Vec<u8>, EvidenceError> {
    let host = url
        .host_str()
        .ok_or(EvidenceError::IssuerUnreachable)?
        .trim_matches(['[', ']']);
    let port = url
        .port_or_known_default()
        .ok_or(EvidenceError::IssuerUnreachable)?;
    if !allow_private && opensesame_connector_host::is_blocked_host(host) {
        return Err(EvidenceError::IssuerUnreachable);
    }
    let addresses: Vec<_> = tokio::time::timeout(
        Duration::from_secs(2),
        tokio::net::lookup_host((host, port)),
    )
    .await
    .map_err(|_| EvidenceError::IssuerUnreachable)?
    .map_err(|_| EvidenceError::IssuerUnreachable)?
    .take(17)
    .collect();
    if addresses.is_empty()
        || addresses.len() > 16
        || (url.scheme() == "http" && addresses.iter().any(|a| !a.ip().is_loopback()))
        || (!allow_private
            && addresses
                .iter()
                .any(|a| opensesame_connector_host::is_blocked_host(&a.ip().to_string())))
    {
        return Err(EvidenceError::IssuerUnreachable);
    }
    let http = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(2))
        .timeout(Duration::from_secs(5))
        .resolve_to_addrs(host, &addresses)
        .build()
        .map_err(|_| EvidenceError::IssuerUnreachable)?;
    let mut response = http
        .get(url.clone())
        .send()
        .await
        .map_err(|_| EvidenceError::IssuerUnreachable)?;
    if response.status() != reqwest::StatusCode::OK
        || response
            .content_length()
            .is_some_and(|len| len > MAX_JWKS_BYTES as u64)
    {
        return Err(EvidenceError::IssuerUnreachable);
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| EvidenceError::IssuerUnreachable)?
    {
        if chunk.len() > MAX_JWKS_BYTES - bytes.len() {
            return Err(EvidenceError::IssuerUnreachable);
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
