//! Certificate-bound access tokens: the Host side of RFC 8705 §3
//! confirmation (`cnf` / `x5t#S256`).
//!
//! Identity mints the claim as `{"cnf": {"x5t#S256": b64url(sha256(leaf
//! DER))}}` — 43 unpadded base64url characters over the *certificate*, not
//! the key, so a re-issued certificate on the same key does not satisfy an
//! old token. This module is the verifier, and it is deliberately narrow:
//!
//! - a token with no `cnf` is unchanged; binding is opt-in per token;
//! - a `cnf` carrying only `jkt` is DPoP's profile and is left to DPoP —
//!   a certificate thumbprint is not a JWK thumbprint;
//! - a token with `x5t#S256` must be presented on a connection whose peer
//!   really authenticated, and the digest must be the *originating* client's
//!   behind a trusted ingress, never the ingress's own leaf (the ingress is
//!   a different identity, and binding to it would let any client of that
//!   ingress spend any bound token);
//! - anything else is [`TransportError::ProofMismatch`], including a token
//!   presented on the plain listener.

use axum::http::Extensions;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use opensesame_domain::transport::{TransportError, VerifiedPeer};
use opensesame_ingress_evidence::OriginatingPeerExtension;
use opensesame_transport_security::PeerExtension;
use serde::{Deserialize, Serialize};

/// An access token's confirmation claim. Both members are optional and they
/// are different profiles; nothing here conflates them.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Confirmation {
    /// RFC 8705 certificate thumbprint.
    #[serde(rename = "x5t#S256", default, skip_serializing_if = "Option::is_none")]
    pub x5t_s256: Option<String>,
    /// RFC 9449 DPoP JWK thumbprint. Untouched by this module.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub jkt: Option<String>,
}

impl Confirmation {
    /// True when this confirmation asks for certificate binding.
    #[must_use]
    pub fn binds_certificate(&self) -> bool {
        self.x5t_s256.is_some()
    }
}

/// Enforce a token's certificate binding against the request's transport
/// evidence.
///
/// # Errors
///
/// [`TransportError::ProofMismatch`] when the claim is present and the
/// connection's peer is absent, malformed, or a different certificate.
pub fn require_certificate_binding(
    confirmation: Option<&Confirmation>,
    extensions: &Extensions,
) -> Result<(), TransportError> {
    let Some(claimed) = confirmation.and_then(|c| c.x5t_s256.as_deref()) else {
        return Ok(());
    };
    let peer = bound_peer(extensions).ok_or(TransportError::ProofMismatch)?;
    let expected = thumbprint_hex(claimed).ok_or(TransportError::ProofMismatch)?;
    if expected == peer.leaf_thumbprint_sha256() {
        Ok(())
    } else {
        Err(TransportError::ProofMismatch)
    }
}

/// The certificate a bound token must have been issued to: the originating
/// client when an authenticated ingress forwarded one, the direct TLS peer
/// otherwise. Never the ingress leaf.
fn bound_peer(extensions: &Extensions) -> Option<&VerifiedPeer> {
    if let Some(OriginatingPeerExtension(originating)) =
        extensions.get::<OriginatingPeerExtension>()
    {
        return Some(originating.as_ref());
    }
    extensions
        .get::<PeerExtension>()
        .map(|PeerExtension(peer)| peer.as_ref())
}

/// `base64url(sha256(der))` → the 64-character lowercase hex spelling
/// `VerifiedPeer` uses. Refuses padding, a wrong length, and any digest that
/// is not exactly 32 bytes.
fn thumbprint_hex(claimed: &str) -> Option<String> {
    if claimed.len() != 43 {
        return None;
    }
    let digest = URL_SAFE_NO_PAD.decode(claimed).ok()?;
    if digest.len() != 32 {
        return None;
    }
    Some(hex::encode(digest))
}
