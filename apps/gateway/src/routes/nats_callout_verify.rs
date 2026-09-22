//! Everything the Host checks for itself about a callout, before any
//! identity is mapped.
//!
//! The bridge attests exactly one fact Host cannot see — *this arrived on my
//! authenticated NATS connection, on the protected `$SYS.REQ.USER.AUTH`
//! subject*. Its summary of the request is never trusted: the raw
//! server-signed JWT travels with it and is re-verified here against the
//! operator's pinned server nkeys, its digest recomputed, and its evidence
//! re-extracted. A body that disagrees with the signature it carries is a
//! deny, not a negotiation.

use opensesame_nats_callout::digest::{chain_entry_sha256, RequestDigest};
use opensesame_nats_callout::evidence::{extract, ExtractedEvidence};
use opensesame_nats_callout::host_client::HostDecisionRequest;
use opensesame_nats_callout::jwt::{decode_request, Expectations};
use opensesame_nats_callout::CalloutError;

/// The callout request as the Host has verified it for itself.
#[derive(Clone, Debug)]
pub struct VerifiedCallout {
    pub digest: RequestDigest,
    pub user_nkey: String,
    pub server_id: String,
    pub evidence: ExtractedEvidence,
}

/// An identity a verified certificate chain is bound to. Exact match only.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CertPeer {
    /// Lowercase hex SHA-256 over the leaf's DER.
    pub leaf_sha256: String,
    pub issuer: String,
    pub subject: String,
}

/// Parse `OPENSESAME_NATS_CALLOUT_CERT_PEERS`: comma-separated
/// `<leaf-sha256-hex>=<issuer>|<subject>`. Anything else is refused — a
/// malformed peer list must never widen into "any certificate".
///
/// # Errors
///
/// The offending entry.
pub fn parse_cert_peers(spec: &str) -> Result<Vec<CertPeer>, String> {
    let mut out = Vec::new();
    for entry in spec.split(',').map(str::trim).filter(|e| !e.is_empty()) {
        let (thumbprint, identity) = entry.split_once('=').ok_or_else(|| entry.to_owned())?;
        let (issuer, subject) = identity.split_once('|').ok_or_else(|| entry.to_owned())?;
        let thumbprint = thumbprint.trim().to_ascii_lowercase();
        if thumbprint.len() != 64
            || !thumbprint
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            || issuer.trim().is_empty()
            || subject.trim().is_empty()
        {
            return Err(entry.to_owned());
        }
        out.push(CertPeer {
            leaf_sha256: thumbprint,
            issuer: issuer.trim().to_owned(),
            subject: subject.trim().to_owned(),
        });
    }
    Ok(out)
}

/// Re-verify the bridge's request against the signature it carries.
///
/// # Errors
///
/// The first failing check. `server_unknown` when the signing server is not
/// one this deployment pinned (AT-CALLOUT-PROVENANCE); `request_mismatch`
/// when the posted summary — digest, user key, server id or evidence — is
/// not what the signed request actually says (AT-CALLOUT-REPORTEDTLS: a
/// body may not add a certificate chain the server never verified).
pub fn verify_request(
    body: &HostDecisionRequest,
    server_public_keys: &[String],
    callout_subject: Option<&str>,
    now: i64,
) -> Result<VerifiedCallout, CalloutError> {
    if server_public_keys.is_empty() {
        return Err(CalloutError::ServerUnknown);
    }
    let verified = decode_request(
        &body.raw_request_jwt,
        &Expectations {
            server_public_keys: server_public_keys.to_vec(),
            callout_subject: callout_subject.map(str::to_owned),
            now,
        },
    )?;
    let claims = &verified.claims;
    let digest = RequestDigest::compute(claims);
    let evidence = extract(claims);
    let posted = body.evidence.clone().unwrap_or_default();
    if digest.as_str() != body.request_digest
        || claims.nats.user_nkey != body.user_nkey
        || claims.nats.server_id.id != body.server.id
        || claims.nats.request_nonce != body.request_nonce
        || posted != evidence
    {
        return Err(CalloutError::EnvelopeMismatch);
    }
    Ok(VerifiedCallout {
        digest,
        user_nkey: claims.nats.user_nkey.clone(),
        server_id: claims.nats.server_id.id.clone(),
        evidence,
    })
}

/// What a verified chain contributes, once the operator has opted in.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CertIdentity {
    /// No chain was carried, or certificate identity is switched off.
    None,
    /// The chain's leaf is bound to this identity.
    Bound { issuer: String, subject: String },
}

/// Resolve the certificate-derived identity of a verified callout.
///
/// A chain is *only* consulted when `enabled` and the leaf's exact SHA-256
/// is on `peers`. `client_tls.certs` never reaches here: the evidence
/// extractor drops anything nats-server did not itself verify, so an
/// unverified certificate list cannot become an authenticated identity.
///
/// # Errors
///
/// `peer_not_bound` when a chain is present, certificate identity is on, and
/// the leaf is not bound.
pub fn cert_identity(
    verified: &VerifiedCallout,
    enabled: bool,
    peers: &[CertPeer],
) -> Result<CertIdentity, &'static str> {
    let Some(chain) = verified.evidence.tls_verified_chain.as_ref() else {
        return Ok(CertIdentity::None);
    };
    if !enabled {
        // Reported, never authority. The request may still be admitted on a
        // token; the chain simply is not identity here.
        return Ok(CertIdentity::None);
    }
    let leaf = chain.first().ok_or("peer_not_bound")?;
    let thumbprint = chain_entry_sha256(leaf);
    peers
        .iter()
        .find(|peer| peer.leaf_sha256 == thumbprint)
        .map_or(Err("peer_not_bound"), |peer| {
            Ok(CertIdentity::Bound {
                issuer: peer.issuer.clone(),
                subject: peer.subject.clone(),
            })
        })
}

/// Combine token-derived and certificate-derived identity.
///
/// When both are present they must name the same principal: a legitimate
/// certificate from one tenant plus another tenant's token is the central
/// credential-substitution failure and is refused rather than unioned.
///
/// # Errors
///
/// `identity_mismatch` when the two disagree.
pub fn reconcile(
    token: Option<(String, String)>,
    cert: &CertIdentity,
) -> Result<Option<(String, String)>, &'static str> {
    match (token, cert) {
        (Some(pair), CertIdentity::None) => Ok(Some(pair)),
        (None, CertIdentity::None) => Ok(None),
        (None, CertIdentity::Bound { issuer, subject }) => {
            Ok(Some((issuer.clone(), subject.clone())))
        }
        (Some((iss, sub)), CertIdentity::Bound { issuer, subject }) => {
            if &iss == issuer && &sub == subject {
                Ok(Some((iss, sub)))
            } else {
                Err("identity_mismatch")
            }
        }
    }
}

/// The `host_kv` key one decision is recorded under.
#[must_use]
pub fn replay_key(digest: &RequestDigest) -> String {
    format!("nats.callout.decision.{digest}")
}

#[cfg(test)]
#[path = "nats_callout_verify_tests.rs"]
mod tests;
