//! [`TlsIdentity`]: the chain *we* present, plus a private key that has been
//! proven to sign for its leaf.
//!
//! Construction is the only way in, and construction refuses: a key that does
//! not match the leaf (proven by signing with the key and verifying with the
//! leaf's public key through the same provider rustls will use), a CA
//! certificate used as an identity, a leaf that is expired or not yet valid
//! at load, and a leaf carrying a critical extension nobody here understands.
//! The key lives inside the provider's signing object; the PEM bytes are
//! dropped as soon as they are parsed and `Debug` prints nothing of it.

use std::fmt;
use std::sync::Arc;

use chrono::{DateTime, Utc};
use opensesame_domain::transport::{PeerIdentitySelector, TransportError};
use rustls::crypto::CryptoProvider;
use rustls::sign::CertifiedKey;
use rustls_pki_types::pem::PemObject;
use rustls_pki_types::{CertificateDer, PrivateKeyDer, UnixTime};
use secrecy::ExposeSecret;

use crate::error::malformed;
use crate::leaf::{LeafUsage, ParsedLeaf};
use crate::trust::TrustBundle;
use crate::{provider, SecretBytes, MAX_CHAIN_DEPTH};

/// Which TLS role a chain is being validated for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChainUsage {
    ServerAuth,
    ClientAuth,
}

/// A certificate chain and the private key proven to match its leaf.
pub struct TlsIdentity {
    chain: Vec<CertificateDer<'static>>,
    certified: Arc<CertifiedKey>,
    leaf: ParsedLeaf,
}

impl TlsIdentity {
    /// Load an identity from a PEM chain (leaf first) and a PEM private key.
    ///
    /// # Errors
    ///
    /// - `MalformedConfiguration`: no certificate, more than
    ///   [`MAX_CHAIN_DEPTH`], a key that does not parse, a CA leaf, a leaf
    ///   not yet valid, or an unsupported critical extension.
    /// - `KeyPairMismatch`: the key does not sign for the leaf.
    /// - `EvidenceExpired`: the leaf is already expired.
    pub fn from_pem(cert_chain_pem: &[u8], key_pem: &SecretBytes) -> Result<Self, TransportError> {
        let chain = CertificateDer::pem_slice_iter(cert_chain_pem)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| malformed(format!("certificate PEM: {e}")))?;
        let key = PrivateKeyDer::from_pem_slice(key_pem.expose_secret())
            .map_err(|_| malformed("private key PEM: not a PKCS#8, PKCS#1 or SEC1 key"))?;
        Self::from_der(chain, key)
    }

    /// Load an identity from DER parts. The key is consumed and zeroized
    /// once the provider has parsed it.
    ///
    /// # Errors
    ///
    /// As [`Self::from_pem`].
    pub fn from_der(
        chain: Vec<CertificateDer<'static>>,
        key: PrivateKeyDer<'static>,
    ) -> Result<Self, TransportError> {
        let Some(leaf_der) = chain.first() else {
            return Err(malformed("identity chain is empty"));
        };
        if chain.len() > MAX_CHAIN_DEPTH {
            return Err(malformed(format!(
                "identity chain exceeds {MAX_CHAIN_DEPTH} certificates"
            )));
        }
        let leaf = ParsedLeaf::parse(leaf_der)?;
        check_leaf_shape(&leaf, Utc::now())?;
        let provider = provider();
        let signing_key = provider
            .key_provider
            .load_private_key(key)
            .map_err(|e| malformed(format!("private key: {e}")))?;
        prove_possession(&provider, signing_key.as_ref(), leaf_der, &leaf)?;
        let certified = CertifiedKey::new(chain.clone(), signing_key);
        certified
            .keys_match()
            .map_err(|_| TransportError::KeyPairMismatch)?;
        Ok(Self {
            chain,
            certified: Arc::new(certified),
            leaf,
        })
    }

    /// SHA-256 of the leaf DER, lowercase hex.
    #[must_use]
    pub fn leaf_thumbprint_sha256(&self) -> String {
        self.leaf.thumbprint_sha256.clone()
    }

    /// Validated exact-match selectors (SPIFFE ID, DNS names, URI SANs,
    /// thumbprint).
    #[must_use]
    pub fn selectors(&self) -> &[PeerIdentitySelector] {
        &self.leaf.selectors
    }

    #[must_use]
    pub fn not_before(&self) -> DateTime<Utc> {
        self.leaf.not_before
    }

    #[must_use]
    pub fn not_after(&self) -> DateTime<Utc> {
        self.leaf.not_after
    }

    /// The SPIFFE ID when the leaf carries exactly one well-formed one.
    #[must_use]
    pub fn spiffe_id(&self) -> Option<&str> {
        self.leaf.spiffe_id.as_deref()
    }

    /// DNS SANs, lowercased.
    #[must_use]
    pub fn dns_names(&self) -> &[String] {
        &self.leaf.dns_names
    }

    /// Every URI SAN, including SPIFFE ones.
    #[must_use]
    pub fn uri_sans(&self) -> &[String] {
        &self.leaf.uri_sans
    }

    #[must_use]
    pub fn usage(&self) -> LeafUsage {
        self.leaf.usage
    }

    /// The presented chain, leaf first.
    #[must_use]
    pub fn chain(&self) -> &[CertificateDer<'static>] {
        &self.chain
    }

    /// The parsed leaf facts.
    #[must_use]
    pub fn leaf(&self) -> &ParsedLeaf {
        &self.leaf
    }

    /// Is the leaf inside its validity window at `now`?
    #[must_use]
    pub fn is_valid_at(&self, now: DateTime<Utc>) -> bool {
        self.leaf.is_valid_at(now)
    }

    /// Validate this identity's chain against `trust` for `usage` at `now`,
    /// exactly as a peer running `rustls-webpki` would.
    ///
    /// # Errors
    ///
    /// The classified verification failure (`TrustUnknown`,
    /// `EvidenceExpired`, `EvidenceRevoked`, `PeerDisallowed`, ...).
    pub fn verify_chain(
        &self,
        trust: &TrustBundle,
        usage: ChainUsage,
        now: DateTime<Utc>,
    ) -> Result<(), TransportError> {
        let Some(leaf_der) = self.chain.first() else {
            return Err(malformed("identity chain is empty"));
        };
        let end_entity = webpki::EndEntityCert::try_from(leaf_der)
            .map_err(|e| crate::classify_tls_error(&crate::error::pki_error(e)))?;
        let provider = provider();
        let crls = trust.parsed_crls()?;
        let crl_refs: Vec<&webpki::CertRevocationList<'_>> = crls.iter().collect();
        let revocation = trust.revocation_options(&crl_refs);
        let eku = match usage {
            ChainUsage::ServerAuth => webpki::KeyUsage::server_auth(),
            ChainUsage::ClientAuth => webpki::KeyUsage::client_auth(),
        };
        let seconds = u64::try_from(now.timestamp()).unwrap_or_default();
        end_entity
            .verify_for_usage(
                provider.signature_verification_algorithms.all,
                &trust.roots().roots,
                &self.chain[1..],
                UnixTime::since_unix_epoch(std::time::Duration::from_secs(seconds)),
                eku,
                revocation,
                None,
            )
            .map(|_| ())
            .map_err(|e| crate::classify_tls_error(&crate::error::pki_error(e)))
    }

    /// The rustls certified key (chain + signer) for config builders.
    pub(crate) fn certified_key(&self) -> CertifiedKey {
        (*self.certified).clone()
    }
}

impl fmt::Debug for TlsIdentity {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("TlsIdentity")
            .field("leaf_thumbprint_sha256", &self.leaf.thumbprint_sha256)
            .field("chain_len", &self.chain.len())
            .field("not_before", &self.leaf.not_before)
            .field("not_after", &self.leaf.not_after)
            .field("selectors", &self.leaf.selectors)
            .field("key", &"<redacted>")
            .finish_non_exhaustive()
    }
}

fn check_leaf_shape(leaf: &ParsedLeaf, now: DateTime<Utc>) -> Result<(), TransportError> {
    if leaf.is_ca || leaf.usage.key_cert_sign {
        return Err(malformed("identity leaf is a CA certificate"));
    }
    if let Some(oid) = leaf.unsupported_critical_extensions.first() {
        return Err(malformed(format!(
            "identity leaf carries unsupported critical extension {oid}"
        )));
    }
    if now > leaf.not_after {
        return Err(TransportError::EvidenceExpired);
    }
    if now < leaf.not_before {
        return Err(malformed("identity leaf is not yet valid"));
    }
    Ok(())
}

/// Prove the key signs for the leaf: sign a fixed message with the key
/// through the provider, verify it with the leaf's public key through
/// `webpki`, and — when the provider can export it — compare the derived
/// SPKI byte for byte.
fn prove_possession(
    provider: &CryptoProvider,
    signing_key: &dyn rustls::sign::SigningKey,
    leaf_der: &CertificateDer<'_>,
    leaf: &ParsedLeaf,
) -> Result<(), TransportError> {
    const MESSAGE: &[u8] = b"opensesame-transport-security: key possession";
    if let Some(spki) = signing_key.public_key() {
        if spki.as_ref() != leaf.spki_der.as_slice() {
            return Err(TransportError::KeyPairMismatch);
        }
    }
    let end_entity = webpki::EndEntityCert::try_from(leaf_der)
        .map_err(|e| malformed(format!("identity leaf: {e}")))?;
    for (scheme, algorithms) in provider.signature_verification_algorithms.mapping {
        let Some(signer) = signing_key.choose_scheme(&[*scheme]) else {
            continue;
        };
        let signature = signer
            .sign(MESSAGE)
            .map_err(|e| malformed(format!("private key cannot sign: {e}")))?;
        let verified = algorithms.iter().any(|alg| {
            end_entity
                .verify_signature(*alg, MESSAGE, &signature)
                .is_ok()
        });
        return if verified {
            Ok(())
        } else {
            Err(TransportError::KeyPairMismatch)
        };
    }
    Err(malformed(
        "private key algorithm is not supported by the TLS provider",
    ))
}
