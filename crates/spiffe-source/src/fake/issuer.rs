//! A disposable SPIFFE trust domain for tests: one self-signed CA that issues
//! X509-SVIDs and, on request, deliberately non-conforming leaves. Everything
//! is generated in memory at test time; nothing is ever written or committed.

use std::time::Duration;

use chrono::{DateTime, Utc};
use rcgen::{
    BasicConstraints, CertificateParams, CustomExtension, DistinguishedName, DnType,
    ExtendedKeyUsagePurpose, IsCa, Issuer, KeyPair, KeyUsagePurpose, SanType,
};
use secrecy::{ExposeSecret as _, SecretBox};
use sha2::{Digest as _, Sha256};

use super::pb;

/// Which extended key usages a leaf carries.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Eku {
    /// No EKU extension at all (allowed by the standard).
    Absent,
    /// `serverAuth` + `clientAuth` (the conforming dual form).
    Dual,
    /// `clientAuth` only.
    ClientOnly,
    /// `serverAuth` only.
    ServerOnly,
    /// `codeSigning` only: a signing purpose, never a caller.
    CodeSigningOnly,
}

/// Everything about a leaf a test may want to bend.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SvidSpec {
    /// URI SANs, in order. A conforming SVID has exactly one.
    pub uri_sans: Vec<String>,
    /// DNS SANs (allowed beside the URI SAN; alone they make a non-SVID).
    pub dns_sans: Vec<String>,
    /// Issue a CA leaf.
    pub is_ca: bool,
    /// Key usage bits. Empty means "omit the extension".
    pub key_usages: Vec<KeyUsagePurpose>,
    /// Extended key usage shape.
    pub eku: Eku,
    /// Add an unknown extension marked critical.
    pub unknown_critical_extension: bool,
    /// Add a non-critical key usage as a custom extension instead of the
    /// real one (rcgen always writes the real one critical).
    pub non_critical_key_usage: bool,
    /// Validity start.
    pub not_before: DateTime<Utc>,
    /// Validity end.
    pub not_after: DateTime<Utc>,
}

impl SvidSpec {
    /// A conforming leaf for `spiffe_id` valid from now for `ttl`.
    #[must_use]
    pub fn conforming(spiffe_id: &str, ttl: Duration) -> Self {
        let now = Utc::now();
        Self {
            uri_sans: vec![spiffe_id.to_owned()],
            dns_sans: Vec::new(),
            is_ca: false,
            key_usages: vec![KeyUsagePurpose::DigitalSignature],
            eku: Eku::Dual,
            unknown_critical_extension: false,
            non_critical_key_usage: false,
            not_before: now - chrono::Duration::minutes(1),
            not_after: now + chrono::Duration::from_std(ttl).unwrap_or(chrono::Duration::hours(1)),
        }
    }
}

/// An issued leaf plus the material the Workload API would deliver with it.
pub struct IssuedSvid {
    /// The first URI SAN (or empty when the spec had none).
    pub spiffe_id: String,
    /// DER chain, leaf first, then the issuing CA.
    pub chain_der: Vec<Vec<u8>>,
    /// PKCS#8 DER private key.
    pub key_pkcs8_der: SecretBox<Vec<u8>>,
    /// Validity end.
    pub not_after: DateTime<Utc>,
    /// SHA-256 of the leaf DER, lowercase hex.
    pub leaf_thumbprint_sha256: String,
}

impl std::fmt::Debug for IssuedSvid {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("IssuedSvid")
            .field("spiffe_id", &self.spiffe_id)
            .field("leaf_thumbprint_sha256", &self.leaf_thumbprint_sha256)
            .finish_non_exhaustive()
    }
}

impl IssuedSvid {
    /// Leaf DER.
    #[must_use]
    pub fn leaf_der(&self) -> &[u8] {
        self.chain_der.first().map_or(&[], Vec::as_slice)
    }

    /// The Workload API message for this SVID with the given bundle.
    #[must_use]
    pub fn to_proto(&self, bundle_der: &[u8], hint: &str) -> pb::X509svid {
        pb::X509svid {
            spiffe_id: self.spiffe_id.clone(),
            x509_svid: self.chain_der.concat(),
            x509_svid_key: self.key_pkcs8_der.expose_secret().clone(),
            bundle: bundle_der.to_vec(),
            hint: hint.to_owned(),
        }
    }
}

/// A trust domain with one CA.
pub struct FakeTrustDomain {
    name: String,
    ca_params: CertificateParams,
    ca_key: KeyPair,
    ca_der: Vec<u8>,
}

impl std::fmt::Debug for FakeTrustDomain {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FakeTrustDomain")
            .field("name", &self.name)
            .finish_non_exhaustive()
    }
}

impl FakeTrustDomain {
    /// A fresh CA for `name` (e.g. `example.test`). Calling this twice with
    /// the same name yields two unrelated CAs, which is how a test rotates a
    /// trust domain's bundle.
    ///
    /// # Panics
    /// Only on key generation failure in the crypto provider.
    #[must_use]
    pub fn new(name: &str) -> Self {
        let mut params = CertificateParams::default();
        params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        params.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign];
        params.subject_alt_names = vec![SanType::URI(
            format!("spiffe://{name}").try_into().expect("ia5"),
        )];
        let mut dn = DistinguishedName::new();
        dn.push(DnType::CommonName, format!("fake-ca-{name}"));
        params.distinguished_name = dn;
        let now = Utc::now();
        params.not_before = to_time(now - chrono::Duration::minutes(5));
        params.not_after = to_time(now + chrono::Duration::days(1));
        let ca_key = KeyPair::generate().expect("keypair");
        let ca_der = params
            .self_signed(&ca_key)
            .expect("self-sign")
            .der()
            .to_vec();
        Self {
            name: name.to_owned(),
            ca_params: params,
            ca_key,
            ca_der,
        }
    }

    /// Trust domain name.
    #[must_use]
    pub fn name(&self) -> &str {
        &self.name
    }

    /// The bundle as the Workload API ships it: concatenated DER CAs.
    #[must_use]
    pub fn bundle_der(&self) -> Vec<u8> {
        self.ca_der.clone()
    }

    /// The CA certificate DER.
    #[must_use]
    pub fn ca_der(&self) -> &[u8] {
        &self.ca_der
    }

    /// A conforming SVID for `spiffe_id` valid for `ttl`.
    #[must_use]
    pub fn issue_svid(&self, spiffe_id: &str, ttl: Duration) -> IssuedSvid {
        self.issue(&SvidSpec::conforming(spiffe_id, ttl))
    }

    /// Issue a leaf shaped exactly as `spec` says.
    ///
    /// # Panics
    /// Only when the spec cannot be encoded (a non-IA5 SAN).
    #[must_use]
    pub fn issue(&self, spec: &SvidSpec) -> IssuedSvid {
        let mut params = CertificateParams::default();
        params.subject_alt_names = spec
            .uri_sans
            .iter()
            .map(|u| SanType::URI(u.as_str().try_into().expect("ia5 uri")))
            .chain(
                spec.dns_sans
                    .iter()
                    .map(|d| SanType::DnsName(d.as_str().try_into().expect("ia5 dns"))),
            )
            .collect();
        params.is_ca = if spec.is_ca {
            IsCa::Ca(BasicConstraints::Unconstrained)
        } else {
            IsCa::ExplicitNoCa
        };
        params.key_usages.clone_from(&spec.key_usages);
        params.extended_key_usages = match spec.eku {
            Eku::Absent => Vec::new(),
            Eku::Dual => vec![
                ExtendedKeyUsagePurpose::ServerAuth,
                ExtendedKeyUsagePurpose::ClientAuth,
            ],
            Eku::ClientOnly => vec![ExtendedKeyUsagePurpose::ClientAuth],
            Eku::ServerOnly => vec![ExtendedKeyUsagePurpose::ServerAuth],
            Eku::CodeSigningOnly => vec![ExtendedKeyUsagePurpose::CodeSigning],
        };
        if spec.unknown_critical_extension {
            // 1.3.6.1.4.1.99999.1 with an OCTET STRING payload, marked critical.
            let mut ext = CustomExtension::from_oid_content(
                &[1, 3, 6, 1, 4, 1, 99999, 1],
                vec![0x04, 0x01, 0x00],
            );
            ext.set_criticality(true);
            params.custom_extensions.push(ext);
        }
        if spec.non_critical_key_usage {
            // KeyUsage BIT STRING with only digitalSignature, not critical.
            let ext =
                CustomExtension::from_oid_content(&[2, 5, 29, 15], vec![0x03, 0x02, 0x07, 0x80]);
            params.custom_extensions.push(ext);
        }
        let mut dn = DistinguishedName::new();
        dn.push(DnType::CommonName, "fake-svid");
        params.distinguished_name = dn;
        params.not_before = to_time(spec.not_before);
        params.not_after = to_time(spec.not_after);
        params.use_authority_key_identifier_extension = true;
        let key = KeyPair::generate().expect("keypair");
        let issuer = Issuer::from_params(&self.ca_params, &self.ca_key);
        let leaf = params.signed_by(&key, &issuer).expect("sign");
        let leaf_der = leaf.der().to_vec();
        IssuedSvid {
            spiffe_id: spec.uri_sans.first().cloned().unwrap_or_default(),
            leaf_thumbprint_sha256: hex::encode(Sha256::digest(&leaf_der)),
            chain_der: vec![leaf_der, self.ca_der.clone()],
            key_pkcs8_der: SecretBox::new(Box::new(key.serialize_der())),
            not_after: spec.not_after,
        }
    }
}

fn to_time(at: DateTime<Utc>) -> time::OffsetDateTime {
    time::OffsetDateTime::from_unix_timestamp(at.timestamp())
        .unwrap_or(time::OffsetDateTime::UNIX_EPOCH)
}
