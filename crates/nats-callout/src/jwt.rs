//! `ed25519-nkey` JWTs: verify a server-signed `authorization_request`, and
//! the encoder [`crate::response`] signs with.
//!
//! This is not a JOSE library and does not want to be one: the algorithm is
//! fixed to what nats-server emits, the key kinds are fixed to what the
//! protocol assigns (server signs, user is the subject, account is the
//! audience), and the signature primitive is `nkeys`.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use serde::{Deserialize, Serialize};

use crate::error::{malformed, CalloutError};
use crate::model::{AuthorizationRequestClaims, CLAIMS_VERSION, REQUEST_TYPE};
use crate::MAX_REQUEST_BYTES;

/// The only algorithm nats-server signs with.
pub const ALG: &str = "ed25519-nkey";
/// The only `typ`.
pub const TYP: &str = "JWT";
/// The fixed `aud` nats-server puts on every `authorization_request`
/// (`server/auth_callout.go`: `AuthRequestSubject`). It is a protocol
/// constant, not the callout account: the account key is the request's
/// `sub`.
pub const REQUEST_AUDIENCE: &str = "nats-authorization-request";
/// A request older than this (by `iat`) is refused even if it has no `exp`.
pub const REQUEST_WINDOW_SECS: i64 = 120;
/// Clock skew tolerated on `iat`, `nbf` and `exp`.
pub const SKEW_SECS: i64 = 30;

#[derive(Debug, Serialize, Deserialize)]
struct Header {
    #[serde(default)]
    typ: String,
    #[serde(default)]
    alg: String,
}

/// What the verifier has been told to expect.
#[derive(Clone, Debug, Default)]
pub struct Expectations {
    /// Public server nkeys (`N…`) allowed to sign requests. Empty means any
    /// well-formed server key — acceptable only where the caller already
    /// knows the request came in on an authenticated NATS connection (the
    /// bridge); the Host always pins a list.
    pub server_public_keys: Vec<String>,
    /// The callout issuer this deployment configured, which nats-server
    /// puts in the request's `sub`: the account public key (`A…`) in config
    /// mode, the account *name* in operator mode. `None` accepts any — only
    /// acceptable where the caller already knows the request arrived on an
    /// authenticated NATS connection into that account (the bridge); the
    /// Host always pins it.
    pub callout_subject: Option<String>,
    /// Verification instant (unix seconds).
    pub now: i64,
}

impl Expectations {
    /// Expectations at the current wall clock.
    #[must_use]
    pub fn at_now() -> Self {
        Self {
            now: chrono::Utc::now().timestamp(),
            ..Self::default()
        }
    }
}

/// A request whose signature, window, audience and key kinds have been
/// checked. The raw token is kept so the Host can re-verify it.
#[derive(Clone, Debug)]
pub struct VerifiedRequest {
    pub claims: AuthorizationRequestClaims,
    /// The server key that signed it (`iss`).
    pub server_public_key: String,
    raw: String,
}

impl VerifiedRequest {
    /// The exact token that was verified.
    #[must_use]
    pub fn raw(&self) -> &str {
        &self.raw
    }

    /// The one-time user nkey the server minted for this CONNECT.
    #[must_use]
    pub fn user_nkey(&self) -> &str {
        &self.claims.nats.user_nkey
    }
}

/// Split, decode and check a compact JWT's header. Returns
/// `(signing_input, payload_bytes, signature)`.
fn split(token: &str) -> Result<(&str, Vec<u8>, Vec<u8>), CalloutError> {
    if token.len() > MAX_REQUEST_BYTES {
        return Err(malformed("token exceeds the request bound"));
    }
    let mut parts = token.split('.');
    let (Some(h), Some(p), Some(s), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err(malformed("token is not three dot-separated segments"));
    };
    let header_bytes = URL_SAFE_NO_PAD
        .decode(h)
        .map_err(|_| malformed("header is not base64url"))?;
    let header: Header =
        serde_json::from_slice(&header_bytes).map_err(|_| malformed("header is not JSON"))?;
    if !header.typ.eq_ignore_ascii_case(TYP) || header.alg != ALG {
        return Err(CalloutError::UnsupportedAlgorithm);
    }
    let payload = URL_SAFE_NO_PAD
        .decode(p)
        .map_err(|_| malformed("payload is not base64url"))?;
    let signature = URL_SAFE_NO_PAD
        .decode(s)
        .map_err(|_| malformed("signature is not base64url"))?;
    let signing_len = h.len() + 1 + p.len();
    Ok((&token[..signing_len], payload, signature))
}

fn check_window(claims: &AuthorizationRequestClaims, now: i64) -> Result<(), CalloutError> {
    if claims.iat == 0 || claims.iat > now + SKEW_SECS {
        return Err(CalloutError::OutsideWindow);
    }
    if now - claims.iat > REQUEST_WINDOW_SECS + SKEW_SECS {
        return Err(CalloutError::OutsideWindow);
    }
    if claims.nbf.is_some_and(|nbf| nbf > now + SKEW_SECS) {
        return Err(CalloutError::OutsideWindow);
    }
    if claims.exp.is_some_and(|exp| exp + SKEW_SECS <= now) {
        return Err(CalloutError::OutsideWindow);
    }
    Ok(())
}

/// Verify a server-signed `authorization_request`.
///
/// Order: shape and algorithm → issuer is a server nkey (and pinned when a
/// list is configured) → signature → claim type/version → the issuer is the
/// server the claims name → `aud` is the protocol constant → `sub` is this
/// deployment's callout issuer → `nats.user_nkey` is a public user key →
/// time window.
///
/// The field names matter and are easy to get backwards: nats-server signs
/// with its own key, addresses the request to the fixed string
/// [`REQUEST_AUDIENCE`], puts the *callout issuer* in `sub`, and carries the
/// one-time user key in `nats.user_nkey` — verified against nats-server
/// 2.11 (`server/auth_callout.go`) and ADR-26.
///
/// # Errors
///
/// A [`CalloutError`] naming the first check that failed; every one is a
/// deny.
pub fn decode_request(token: &str, expect: &Expectations) -> Result<VerifiedRequest, CalloutError> {
    let (signing_input, payload, signature) = split(token)?;
    let claims: AuthorizationRequestClaims =
        serde_json::from_slice(&payload).map_err(|_| malformed("claims are not JSON"))?;
    let issuer = claims.iss.as_str();
    if !issuer.starts_with('N') {
        return Err(CalloutError::IssuerNotServer);
    }
    if !expect.server_public_keys.is_empty()
        && !expect.server_public_keys.iter().any(|k| k == issuer)
    {
        return Err(CalloutError::ServerUnknown);
    }
    let server =
        nkeys::KeyPair::from_public_key(issuer).map_err(|_| CalloutError::IssuerNotServer)?;
    if server.key_pair_type() != nkeys::KeyPairType::Server {
        return Err(CalloutError::IssuerNotServer);
    }
    server
        .verify(signing_input.as_bytes(), &signature)
        .map_err(|_| CalloutError::BadSignature)?;
    if claims.nats.kind != REQUEST_TYPE || claims.nats.version != CLAIMS_VERSION {
        return Err(malformed("claims are not an authorization_request v2"));
    }
    if claims.nats.server_id.id != issuer {
        return Err(CalloutError::ServerIdMismatch);
    }
    if claims.aud != REQUEST_AUDIENCE {
        return Err(CalloutError::AudienceMismatch);
    }
    if claims.sub.is_empty()
        || expect
            .callout_subject
            .as_ref()
            .is_some_and(|expected| expected != &claims.sub)
    {
        return Err(CalloutError::SubjectNotCallout);
    }
    let user_nkey = claims.nats.user_nkey.as_str();
    if !user_nkey.starts_with('U') || nkeys::KeyPair::from_public_key(user_nkey).is_err() {
        return Err(CalloutError::UserNkeyInvalid);
    }
    check_window(&claims, expect.now)?;
    Ok(VerifiedRequest {
        server_public_key: issuer.to_owned(),
        claims,
        raw: token.to_owned(),
    })
}

/// Encode and sign claims as an `ed25519-nkey` JWT with `signer`'s seed.
///
/// # Errors
///
/// `SigningFailed` when the key pair has no seed or serialization fails.
pub fn encode<T: Serialize>(claims: &T, signer: &nkeys::KeyPair) -> Result<String, CalloutError> {
    let header = URL_SAFE_NO_PAD.encode(
        serde_json::to_vec(&Header {
            typ: TYP.into(),
            alg: ALG.into(),
        })
        .map_err(|_| CalloutError::SigningFailed)?,
    );
    let payload = URL_SAFE_NO_PAD
        .encode(serde_json::to_vec(claims).map_err(|_| CalloutError::SigningFailed)?);
    let signing_input = format!("{header}.{payload}");
    let signature = signer
        .sign(signing_input.as_bytes())
        .map_err(|_| CalloutError::SigningFailed)?;
    Ok(format!(
        "{signing_input}.{}",
        URL_SAFE_NO_PAD.encode(signature)
    ))
}

/// Decode the claims of any compact JWT *without* verifying it. Used only to
/// read our own freshly encoded tokens in tests and to build the `jti`.
///
/// # Errors
///
/// `MalformedRequest` when the token does not split or parse.
pub fn peek_claims<T: for<'de> Deserialize<'de>>(token: &str) -> Result<T, CalloutError> {
    let (_, payload, _) = split(token)?;
    serde_json::from_slice(&payload).map_err(|_| malformed("claims are not JSON"))
}

/// jwt v2 `jti`: base32 (RFC 4648, no padding) of SHA-256 over the claims
/// serialized with an empty `jti`. Servers do not verify it, but every jwt
/// library computes it and operators diff tokens by it.
#[must_use]
pub fn jti_for(claims_json: &[u8]) -> String {
    use sha2::Digest as _;
    base32_no_pad(&sha2::Sha256::digest(claims_json))
}

fn base32_no_pad(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let mut out = String::with_capacity(bytes.len().div_ceil(5) * 8);
    let mut buffer: u32 = 0;
    let mut bits = 0u32;
    for &byte in bytes {
        buffer = (buffer << 8) | u32::from(byte);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            let index = (buffer >> bits) & 0x1f;
            out.push(char::from(ALPHABET[index as usize]));
        }
        buffer &= (1 << bits) - 1;
    }
    if bits > 0 {
        let index = (buffer << (5 - bits)) & 0x1f;
        out.push(char::from(ALPHABET[index as usize]));
    }
    out
}

#[cfg(test)]
#[path = "jwt_tests.rs"]
mod tests;
