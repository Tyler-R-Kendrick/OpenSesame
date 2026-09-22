//! Reading one end-entity certificate after it has been verified.
//!
//! This is the only place `x509-parser` is used, and it is used for facts
//! only: validity, basic constraints, key usage, EKU, and the subject
//! alternative names that become [`PeerIdentitySelector`]s. It never decides
//! whether a certificate is *trusted* — that is `rustls-webpki`'s job.

use chrono::{DateTime, Utc};
use opensesame_domain::transport::{PeerIdentitySelector, TransportError};
use rustls_pki_types::CertificateDer;
use sha2::{Digest, Sha256};
use x509_parser::prelude::{FromDer, GeneralName, ParsedExtension, X509Certificate};

use crate::error::malformed;

/// Key-usage facts a profile decision needs. All derived from the
/// certificate; nothing is inferred.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
#[allow(clippy::struct_excessive_bools)] // one flag per X.509 usage bit, read straight off the certificate
pub struct LeafUsage {
    /// The EKU extension is present (absent means "any purpose" in RFC 5280).
    pub eku_present: bool,
    /// `anyExtendedKeyUsage`.
    pub any: bool,
    /// `id-kp-serverAuth`.
    pub server_auth: bool,
    /// `id-kp-clientAuth`.
    pub client_auth: bool,
    /// The KU extension is present.
    pub ku_present: bool,
    /// `digitalSignature` (what a TLS 1.3 certificate signs with).
    pub digital_signature: bool,
    /// `keyCertSign` — a CA bit; never acceptable on an authentication leaf.
    pub key_cert_sign: bool,
}

impl LeafUsage {
    /// May this leaf authenticate a TLS *server*?
    #[must_use]
    pub const fn permits_server_auth(&self) -> bool {
        !self.eku_present || self.any || self.server_auth
    }

    /// May this leaf authenticate a TLS *client*?
    #[must_use]
    pub const fn permits_client_auth(&self) -> bool {
        !self.eku_present || self.any || self.client_auth
    }
}

/// The verified-leaf facts every other module shares.
#[derive(Clone, Debug)]
pub struct ParsedLeaf {
    /// SHA-256 of the DER, lowercase hex.
    pub thumbprint_sha256: String,
    pub not_before: DateTime<Utc>,
    pub not_after: DateTime<Utc>,
    /// `basicConstraints.cA`.
    pub is_ca: bool,
    pub usage: LeafUsage,
    /// DNS SANs, lowercased, in certificate order (wildcards included here;
    /// they are excluded from `selectors`).
    pub dns_names: Vec<String>,
    /// Every URI SAN exactly as encoded, including `spiffe://` ones.
    pub uri_sans: Vec<String>,
    /// The SPIFFE ID when the certificate carries exactly one `spiffe://`
    /// URI SAN that is well-formed; `None` otherwise (zero, or more than one).
    pub spiffe_id: Option<String>,
    /// Validated exact-match selectors: SPIFFE ID, DNS names, non-SPIFFE
    /// URI SANs, and the thumbprint — always at least the thumbprint.
    pub selectors: Vec<PeerIdentitySelector>,
    /// The `SubjectPublicKeyInfo` DER, for key-possession checks.
    pub spki_der: Vec<u8>,
    /// OIDs of critical extensions this crate does not understand. A leaf
    /// with any is refused as an identity; a peer with any is refused by
    /// `webpki` during path validation.
    pub unsupported_critical_extensions: Vec<String>,
}

impl ParsedLeaf {
    /// Read the facts out of one DER certificate.
    ///
    /// # Errors
    ///
    /// `MalformedConfiguration` when the DER is not an X.509 v3 certificate
    /// or its validity, SAN, KU, EKU or basic-constraints extensions do not
    /// parse.
    pub fn parse(der: &CertificateDer<'_>) -> Result<Self, TransportError> {
        let (rest, cert) = X509Certificate::from_der(der.as_ref())
            .map_err(|e| malformed(format!("certificate DER: {e}")))?;
        if !rest.is_empty() {
            return Err(malformed("certificate DER has trailing bytes"));
        }
        let thumbprint_sha256 = hex::encode(Sha256::digest(der.as_ref()));
        let validity = cert.validity();
        let not_before = timestamp(validity.not_before.timestamp(), "notBefore")?;
        let not_after = timestamp(validity.not_after.timestamp(), "notAfter")?;
        let is_ca = cert
            .basic_constraints()
            .map_err(|e| malformed(format!("basicConstraints: {e}")))?
            .is_some_and(|bc| bc.value.ca);
        let usage = read_usage(&cert)?;
        let (dns_names, uri_sans) = read_sans(&cert)?;
        let spiffe_uris: Vec<&String> = uri_sans
            .iter()
            .filter(|u| u.starts_with("spiffe://"))
            .collect();
        let spiffe_id = match spiffe_uris.as_slice() {
            [only] => {
                let candidate = PeerIdentitySelector::SpiffeId((*only).clone());
                candidate.validate().ok().map(|()| (*only).clone())
            }
            _ => None,
        };
        let selectors = build_selectors(
            spiffe_id.as_deref(),
            &dns_names,
            &uri_sans,
            &thumbprint_sha256,
        );
        let unsupported_critical_extensions = cert
            .extensions()
            .iter()
            .filter(|ext| {
                ext.critical
                    && matches!(
                        ext.parsed_extension(),
                        ParsedExtension::UnsupportedExtension { .. }
                    )
            })
            .map(|ext| ext.oid.to_id_string())
            .collect();
        Ok(Self {
            thumbprint_sha256,
            not_before,
            not_after,
            is_ca,
            usage,
            dns_names,
            uri_sans,
            spiffe_id,
            selectors,
            spki_der: cert.public_key().raw.to_vec(),
            unsupported_critical_extensions,
        })
    }

    /// Whether `now` falls inside `[not_before, not_after]` (inclusive, as
    /// RFC 5280 §4.1.2.5 reads the interval).
    #[must_use]
    pub fn is_valid_at(&self, now: DateTime<Utc>) -> bool {
        self.not_before <= now && now <= self.not_after
    }
}

fn timestamp(seconds: i64, field: &str) -> Result<DateTime<Utc>, TransportError> {
    DateTime::<Utc>::from_timestamp(seconds, 0)
        .ok_or_else(|| malformed(format!("{field}: out of range")))
}

fn read_usage(cert: &X509Certificate<'_>) -> Result<LeafUsage, TransportError> {
    let mut usage = LeafUsage::default();
    if let Some(eku) = cert
        .extended_key_usage()
        .map_err(|e| malformed(format!("extendedKeyUsage: {e}")))?
    {
        usage.eku_present = true;
        usage.any = eku.value.any;
        usage.server_auth = eku.value.server_auth;
        usage.client_auth = eku.value.client_auth;
    }
    if let Some(ku) = cert
        .key_usage()
        .map_err(|e| malformed(format!("keyUsage: {e}")))?
    {
        usage.ku_present = true;
        usage.digital_signature = ku.value.digital_signature();
        usage.key_cert_sign = ku.value.key_cert_sign();
    }
    Ok(usage)
}

fn read_sans(cert: &X509Certificate<'_>) -> Result<(Vec<String>, Vec<String>), TransportError> {
    let mut dns = Vec::new();
    let mut uris = Vec::new();
    if let Some(san) = cert
        .subject_alternative_name()
        .map_err(|e| malformed(format!("subjectAltName: {e}")))?
    {
        for name in &san.value.general_names {
            match name {
                GeneralName::DNSName(d) => dns.push(d.to_ascii_lowercase()),
                GeneralName::URI(u) => uris.push((*u).to_owned()),
                _ => {}
            }
        }
    }
    Ok((dns, uris))
}

fn build_selectors(
    spiffe_id: Option<&str>,
    dns_names: &[String],
    uri_sans: &[String],
    thumbprint: &str,
) -> Vec<PeerIdentitySelector> {
    let mut out = Vec::new();
    if let Some(id) = spiffe_id {
        out.push(PeerIdentitySelector::SpiffeId(id.to_owned()));
    }
    for dns in dns_names {
        let candidate = PeerIdentitySelector::DnsName(dns.clone());
        if candidate.validate().is_ok() && !out.contains(&candidate) {
            out.push(candidate);
        }
    }
    for uri in uri_sans {
        if uri.starts_with("spiffe://") {
            continue;
        }
        let candidate = PeerIdentitySelector::UriSan(uri.clone());
        if candidate.validate().is_ok() && !out.contains(&candidate) {
            out.push(candidate);
        }
    }
    out.push(PeerIdentitySelector::LeafThumbprintSha256(
        thumbprint.to_owned(),
    ));
    out
}
