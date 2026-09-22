//! The leaf *shape* a transport purpose implies, the policy that bounds it,
//! and the minting that produces it (LIFE-ISSUANCE).
//!
//! Split out of [`super::issuance`] so each file stays inside the 400-line
//! budget; the two are one unit and the module docs there describe the rules
//! this file enforces.

use std::time::Duration;

use opensesame_domain::transport::{PeerIdentitySelector, TransportError};
use opensesame_pki_core::policy::{self, PolicyCandidate, PolicyViolation};
use opensesame_pki_core::{
    BasicConstraints, ExtendedKeyUsage, KeyAlgorithm, KeyUsage, PolicyPreset, SanEntry,
    SignatureAlgorithm, SubjectDn,
};
use rcgen::{
    CertificateParams, DistinguishedName, DnType, ExtendedKeyUsagePurpose, Ia5String, KeyPair,
    KeyUsagePurpose, SanType, SerialNumber, PKCS_ECDSA_P256_SHA256,
};
use sha2::{Digest, Sha256};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};

use crate::dev_pki::{DevCa, IssuedCert};
use crate::managed_certs_tls::TransportPurpose;
use crate::transport_lifecycle::issuance::MAX_VALIDITY_SECONDS;

/// The leaf shape a purpose and selector imply.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LeafShape {
    pub purpose: TransportPurpose,
    pub selector: PeerIdentitySelector,
    pub server_auth: bool,
    pub client_auth: bool,
}

impl LeafShape {
    /// Derive the shape, refusing every selector kind but DNS and SPIFFE.
    ///
    /// # Errors
    ///
    /// `MalformedConfiguration` for a malformed or unsupported selector.
    pub fn derive(
        purpose: TransportPurpose,
        selector: PeerIdentitySelector,
    ) -> Result<Self, TransportError> {
        selector.validate()?;
        let spiffe = match &selector {
            PeerIdentitySelector::SpiffeId(_) => true,
            PeerIdentitySelector::DnsName(_) => false,
            PeerIdentitySelector::UriSan(_) | PeerIdentitySelector::LeafThumbprintSha256(_) => {
                return Err(TransportError::malformed(
                    "transport issuance takes a dns_name or spiffe_id selector",
                ))
            }
        };
        Ok(Self {
            purpose,
            selector,
            // A SPIFFE X.509-SVID carries both EKUs; a private-PKI listener
            // needs both to serve and to probe; a client gets clientAuth only.
            server_auth: spiffe || purpose.is_listener(),
            client_auth: true,
        })
    }

    fn preset(&self) -> PolicyPreset {
        match (&self.selector, self.purpose.is_listener()) {
            (PeerIdentitySelector::SpiffeId(_), _) => PolicyPreset::Device,
            (_, true) => PolicyPreset::DualPurposeServer,
            (_, false) => PolicyPreset::TlsClient,
        }
    }

    fn ekus(&self) -> Vec<ExtendedKeyUsage> {
        let mut out = Vec::new();
        if self.server_auth {
            out.push(ExtendedKeyUsage::ServerAuth);
        }
        if self.client_auth {
            out.push(ExtendedKeyUsage::ClientAuth);
        }
        out
    }

    fn common_name(&self) -> String {
        match &self.selector {
            PeerIdentitySelector::DnsName(name) => name.clone(),
            other => format!("workload-{}", &short_digest(other.value())[..16]),
        }
    }

    /// Check the shape and lifetime against the matching policy preset.
    ///
    /// # Errors
    ///
    /// Every violation the preset produced.
    pub fn check_policy(&self, validity_seconds: u64) -> Result<(), Vec<PolicyViolation>> {
        let sans = match &self.selector {
            PeerIdentitySelector::DnsName(name) => vec![SanEntry::Dns(name.clone())],
            other => vec![SanEntry::Uri(other.value().to_owned())],
        };
        let candidate = PolicyCandidate {
            subject: SubjectDn::common_name(self.common_name()),
            sans,
            key_algorithm: Some(KeyAlgorithm::EcdsaP256),
            signature_algorithm: Some(SignatureAlgorithm::Sha256Ecdsa),
            key_usages: vec![KeyUsage::DigitalSignature],
            ext_key_usages: self.ekus(),
            basic_constraints: Some(BasicConstraints {
                ca: false,
                max_path_len: None,
            }),
            ttl_seconds: Some(validity_seconds),
        };
        policy::evaluate_with_max_validity(
            &policy::preset(self.preset()),
            Some(MAX_VALIDITY_SECONDS),
            &candidate,
        )
    }
}

fn short_digest(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}

fn rfc3339(at: OffsetDateTime) -> Result<String, String> {
    at.format(&Rfc3339).map_err(|error| error.to_string())
}

/// SHA-256 of the first certificate in `pem`, lowercase hex.
///
/// # Errors
///
/// A message when the PEM does not hold a certificate.
pub fn leaf_thumbprint(pem: &str) -> Result<String, String> {
    let (_, block) =
        x509_parser::pem::parse_x509_pem(pem.as_bytes()).map_err(|error| error.to_string())?;
    if block.label != "CERTIFICATE" {
        return Err("not a certificate PEM block".into());
    }
    Ok(hex::encode(Sha256::digest(&block.contents)))
}

/// Mint a leaf of `shape` under `ca`, valid for `ttl`.
///
/// # Errors
///
/// A message when the authority is unusable or signing fails.
pub fn mint_leaf(ca: &DevCa, shape: &LeafShape, ttl: Duration) -> Result<IssuedCert, String> {
    crate::dev_pki::validate_ca(ca)?;
    let ca_key = KeyPair::from_pem(&ca.key_pem).map_err(|e| e.to_string())?;
    let ca_params = CertificateParams::from_ca_cert_pem(&ca.cert_pem).map_err(|e| e.to_string())?;
    let issuer = ca_params.self_signed(&ca_key).map_err(|e| e.to_string())?;
    let common_name = shape.common_name();
    let dns_names: Vec<String> = match &shape.selector {
        PeerIdentitySelector::DnsName(name) => vec![name.clone()],
        _ => Vec::new(),
    };
    let mut params = CertificateParams::new(dns_names.clone()).map_err(|e| e.to_string())?;
    params.distinguished_name = DistinguishedName::new();
    params
        .distinguished_name
        .push(DnType::CommonName, common_name.clone());
    params.key_usages = vec![KeyUsagePurpose::DigitalSignature];
    params.extended_key_usages = Vec::new();
    if shape.server_auth {
        params
            .extended_key_usages
            .push(ExtendedKeyUsagePurpose::ServerAuth);
    }
    if shape.client_auth {
        params
            .extended_key_usages
            .push(ExtendedKeyUsagePurpose::ClientAuth);
    }
    if let PeerIdentitySelector::SpiffeId(id) = &shape.selector {
        let uri = Ia5String::try_from(id.as_str()).map_err(|e| e.to_string())?;
        params.subject_alt_names.push(SanType::URI(uri));
    }
    params.serial_number = Some(SerialNumber::from_slice(
        &uuid::Uuid::new_v4().as_bytes()[..],
    ));
    let not_before = OffsetDateTime::now_utc() - time::Duration::minutes(1);
    let not_after = OffsetDateTime::now_utc()
        + time::Duration::seconds(i64::try_from(ttl.as_secs()).unwrap_or(i64::MAX));
    params.not_before = not_before;
    params.not_after = not_after;
    let serial = params
        .serial_number
        .as_ref()
        .map(|number| hex::encode(number.to_bytes()))
        .unwrap_or_default();
    let leaf_key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).map_err(|e| e.to_string())?;
    let cert = params
        .signed_by(&leaf_key, &issuer, &ca_key)
        .map_err(|e| e.to_string())?;
    Ok(IssuedCert {
        certificate: cert.pem(),
        private_key: leaf_key.serialize_pem(),
        ca_certificate: ca.cert_pem.clone(),
        serial,
        common_name,
        dns_names,
        not_before: rfc3339(not_before)?,
        not_after: rfc3339(not_after)?,
    })
}
