//! Origin-side re-validation of a forwarded chain.
//!
//! The result is honest about what it is: [`EvidenceSource::TrustedIngressAssertion`]
//! evidence whose `ingress()` is the proxy's own directly verified peer. The
//! chain check constrains which certificates the origin will accept — it must
//! chain to the originating-client bundle, be inside its window, permit
//! client authentication, and not be revoked — but the private-key proof
//! happened in the ingress's handshake, not here, and nothing can recreate it.

use chrono::{DateTime, Utc};
use opensesame_domain::transport::attest::AttestedPeer;
use opensesame_domain::transport::{EvidenceSource, TransportError, TransportPolicy, VerifiedPeer};
use opensesame_transport_security::{provider, ParsedLeaf, TrustBundle, MAX_CHAIN_DEPTH};
use rustls_pki_types::{CertificateDer, UnixTime};

use crate::chain::ForwardedChain;

/// Re-validates `chain` against `trust` for TLS client authentication and, if
/// it passes, builds the originating peer for this one request.
///
/// `ingress` must be the directly verified peer of the connection the request
/// arrived on: `DirectTls` evidence, `TrustedIngress` policy, on `listener_id`,
/// still usable at `now`. Its generation and TLS version are inherited; its
/// `usable_until` caps the result's.
///
/// # Errors
/// - `ForwardedEvidenceUnverified` — the ingress evidence is not a trusted-ingress
///   peer, the chain is deeper than [`MAX_CHAIN_DEPTH`], the leaf does not
///   permit client authentication, or webpki refuses the path for any reason
///   other than time or revocation.
/// - `ListenerPolicyMismatch` — the ingress peer is from another listener.
/// - `EvidenceExpired` — the ingress peer or the forwarded leaf is outside its window.
/// - `EvidenceRevoked` — a CRL in `trust` lists a chain certificate.
/// - `TrustUnknown` — the chain does not reach an anchor in `trust`.
pub fn verify_originating(
    chain: &ForwardedChain,
    trust: &TrustBundle,
    ingress: &VerifiedPeer,
    now: DateTime<Utc>,
    listener_id: &str,
) -> Result<VerifiedPeer, TransportError> {
    check_ingress(ingress, now, listener_id)?;
    if chain.intermediates_der().len() + 1 > MAX_CHAIN_DEPTH {
        return Err(TransportError::ForwardedEvidenceUnverified);
    }
    let leaf_der = CertificateDer::from(chain.leaf_der());
    let intermediates: Vec<CertificateDer<'_>> = chain
        .intermediates_der()
        .iter()
        .map(|der| CertificateDer::from(der.as_slice()))
        .collect();
    verify_path(&leaf_der, &intermediates, trust, now)?;

    let leaf =
        ParsedLeaf::parse(&leaf_der).map_err(|_| TransportError::ForwardedEvidenceUnverified)?;
    if leaf.is_ca
        || !leaf.usage.permits_client_auth()
        || !leaf.unsupported_critical_extensions.is_empty()
    {
        return Err(TransportError::ForwardedEvidenceUnverified);
    }
    if !leaf.is_valid_at(now) || now >= leaf.not_after {
        return Err(TransportError::EvidenceExpired);
    }
    let usable_until = ingress.usable_until().min(leaf.not_after);
    AttestedPeer {
        source: EvidenceSource::TrustedIngressAssertion,
        identities: leaf.selectors,
        leaf_thumbprint_sha256: leaf.thumbprint_sha256,
        not_before: leaf.not_before,
        not_after: leaf.not_after,
        trust_profile: trust.profile().clone(),
        trust_generation: trust.generation(),
        credential_generation: ingress.credential_generation(),
        listener: listener_id.to_owned(),
        policy: TransportPolicy::TrustedIngress,
        tls_version: ingress.tls_version(),
        authenticated_at: now,
        usable_until,
        ingress: Some(Box::new(attested_from(ingress))),
    }
    .into_verified()
}

fn check_ingress(
    ingress: &VerifiedPeer,
    now: DateTime<Utc>,
    listener_id: &str,
) -> Result<(), TransportError> {
    if ingress.source() != EvidenceSource::DirectTls || ingress.ingress().is_some() {
        return Err(TransportError::ForwardedEvidenceUnverified);
    }
    if ingress.policy() != TransportPolicy::TrustedIngress || ingress.listener() != listener_id {
        return Err(TransportError::ListenerPolicyMismatch);
    }
    if !ingress.is_usable_at(now) {
        return Err(TransportError::EvidenceExpired);
    }
    Ok(())
}

fn verify_path(
    leaf: &CertificateDer<'_>,
    intermediates: &[CertificateDer<'_>],
    trust: &TrustBundle,
    now: DateTime<Utc>,
) -> Result<(), TransportError> {
    let end_entity = webpki::EndEntityCert::try_from(leaf).map_err(|e| classify(&e))?;
    let crls = trust.parsed_crls()?;
    let crl_refs: Vec<&webpki::CertRevocationList<'_>> = crls.iter().collect();
    let revocation = trust.revocation_options(&crl_refs);
    let seconds = u64::try_from(now.timestamp()).map_err(|_| TransportError::EvidenceExpired)?;
    let roots = trust.roots();
    end_entity
        .verify_for_usage(
            provider().signature_verification_algorithms.all,
            &roots.roots,
            intermediates,
            UnixTime::since_unix_epoch(std::time::Duration::from_secs(seconds)),
            webpki::KeyUsage::client_auth(),
            revocation,
            None,
        )
        .map(|_| ())
        .map_err(|e| classify(&e))
}

/// Maps a webpki refusal onto the shared transport codes. Everything that is
/// not a time or revocation fact is reported as unverified forwarded evidence;
/// the underlying reason is logged by the caller, never returned to a peer.
fn classify(error: &webpki::Error) -> TransportError {
    use webpki::Error as E;
    match *error {
        E::CertExpired { .. } | E::CertNotValidYet { .. } | E::CrlExpired { .. } => {
            TransportError::EvidenceExpired
        }
        E::CertRevoked | E::UnknownRevocationStatus => TransportError::EvidenceRevoked,
        E::UnknownIssuer => TransportError::TrustUnknown,
        _ => TransportError::ForwardedEvidenceUnverified,
    }
}

/// The ingress's evidence, restated for `AttestedPeer::ingress` from the
/// verified peer's own accessors. Nothing is added or reinterpreted.
fn attested_from(peer: &VerifiedPeer) -> AttestedPeer {
    AttestedPeer {
        source: peer.source(),
        identities: peer.identities().to_vec(),
        leaf_thumbprint_sha256: peer.leaf_thumbprint_sha256().to_owned(),
        not_before: peer.not_before(),
        not_after: peer.not_after(),
        trust_profile: peer.trust_profile().clone(),
        trust_generation: peer.trust_generation(),
        credential_generation: peer.credential_generation(),
        listener: peer.listener().to_owned(),
        policy: peer.policy(),
        tls_version: peer.tls_version(),
        authenticated_at: peer.authenticated_at(),
        usable_until: peer.usable_until(),
        ingress: None,
    }
}
