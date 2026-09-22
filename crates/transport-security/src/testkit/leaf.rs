//! Leaf specifications and issued leaves.

use std::path::{Path, PathBuf};

use chrono::{DateTime, Duration, Utc};
use rcgen::{
    CertificateParams, CustomExtension, DnType, ExtendedKeyUsagePurpose, IsCa, KeyPair,
    KeyUsagePurpose, SanType,
};
use secrecy::{ExposeSecret, SecretBox};
use sha2::{Digest, Sha256};

use crate::identity::TlsIdentity;
use crate::SecretBytes;

/// Which key to generate for a leaf.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeyAlgorithm {
    EcdsaP256,
    EcdsaP384,
    Ed25519,
    Rsa2048,
}

/// One subject alternative name.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SanEntry {
    Dns(String),
    Uri(String),
    Email(String),
    Ip(std::net::IpAddr),
}

/// Everything a test can ask of a leaf.
#[derive(Clone, Debug)]
#[allow(clippy::struct_excessive_bools)] // each bool is one independent knob a negative fixture turns
pub struct LeafSpec {
    pub common_name: String,
    pub not_before: DateTime<Utc>,
    pub not_after: DateTime<Utc>,
    pub server_auth: bool,
    pub client_auth: bool,
    /// Emit no EKU extension at all (RFC 5280: any purpose).
    pub omit_eku: bool,
    pub key_usages: Vec<KeyUsagePurpose>,
    pub sans: Vec<SanEntry>,
    pub is_ca: bool,
    /// Add a critical extension with a private OID no verifier understands.
    pub unknown_critical_extension: bool,
    pub key: KeyAlgorithm,
}

impl Default for LeafSpec {
    fn default() -> Self {
        let now = Utc::now();
        Self {
            common_name: "leaf".to_owned(),
            not_before: now - Duration::minutes(5),
            not_after: now + Duration::hours(1),
            server_auth: false,
            client_auth: false,
            omit_eku: false,
            key_usages: vec![KeyUsagePurpose::DigitalSignature],
            sans: Vec::new(),
            is_ca: false,
            unknown_critical_extension: false,
            key: KeyAlgorithm::EcdsaP256,
        }
    }
}

impl LeafSpec {
    /// A server leaf for `dns`.
    #[must_use]
    pub fn server(dns: &str) -> Self {
        Self {
            common_name: dns.to_owned(),
            server_auth: true,
            sans: vec![SanEntry::Dns(dns.to_owned())],
            ..Self::default()
        }
    }

    /// A client-only leaf with the given SANs.
    #[must_use]
    pub fn client(sans: Vec<SanEntry>) -> Self {
        Self {
            common_name: "client".to_owned(),
            client_auth: true,
            sans,
            ..Self::default()
        }
    }

    /// A SPIFFE X.509-SVID: one URI SAN, both EKUs, `digitalSignature`.
    #[must_use]
    pub fn spiffe(spiffe_id: &str) -> Self {
        Self {
            common_name: "svid".to_owned(),
            server_auth: true,
            client_auth: true,
            sans: vec![SanEntry::Uri(spiffe_id.to_owned())],
            ..Self::default()
        }
    }

    #[must_use]
    pub fn valid_between(mut self, not_before: DateTime<Utc>, not_after: DateTime<Utc>) -> Self {
        self.not_before = not_before;
        self.not_after = not_after;
        self
    }

    #[must_use]
    pub fn with_key(mut self, key: KeyAlgorithm) -> Self {
        self.key = key;
        self
    }

    pub(crate) fn generate_key(&self) -> KeyPair {
        match self.key {
            KeyAlgorithm::EcdsaP256 => KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256),
            KeyAlgorithm::EcdsaP384 => KeyPair::generate_for(&rcgen::PKCS_ECDSA_P384_SHA384),
            KeyAlgorithm::Ed25519 => KeyPair::generate_for(&rcgen::PKCS_ED25519),
            KeyAlgorithm::Rsa2048 => {
                KeyPair::generate_rsa_for(&rcgen::PKCS_RSA_SHA256, rcgen::RsaKeySize::_2048)
            }
        }
        .expect("key generation")
    }

    pub(crate) fn params(&self) -> CertificateParams {
        let mut params = CertificateParams::default();
        params
            .distinguished_name
            .push(DnType::CommonName, self.common_name.clone());
        params.not_before = super::to_offset(self.not_before);
        params.not_after = super::to_offset(self.not_after);
        params.is_ca = if self.is_ca {
            IsCa::Ca(rcgen::BasicConstraints::Unconstrained)
        } else {
            IsCa::ExplicitNoCa
        };
        params.key_usages.clone_from(&self.key_usages);
        if !self.omit_eku {
            if self.server_auth {
                params
                    .extended_key_usages
                    .push(ExtendedKeyUsagePurpose::ServerAuth);
            }
            if self.client_auth {
                params
                    .extended_key_usages
                    .push(ExtendedKeyUsagePurpose::ClientAuth);
            }
        }
        for san in &self.sans {
            params.subject_alt_names.push(match san {
                SanEntry::Dns(d) => SanType::DnsName(d.as_str().try_into().expect("ia5 dns")),
                SanEntry::Uri(u) => SanType::URI(u.as_str().try_into().expect("ia5 uri")),
                SanEntry::Email(e) => {
                    SanType::Rfc822Name(e.as_str().try_into().expect("ia5 email"))
                }
                SanEntry::Ip(ip) => SanType::IpAddress(*ip),
            });
        }
        if self.unknown_critical_extension {
            // DER NULL as the extension value; OID under the private arc.
            let mut ext =
                CustomExtension::from_oid_content(&[1, 3, 6, 1, 4, 1, 99_999, 7], vec![0x05, 0x00]);
            ext.set_criticality(true);
            params.custom_extensions.push(ext);
        }
        params.use_authority_key_identifier_extension = true;
        params
    }
}

/// A leaf certificate and its key.
pub struct IssuedLeaf {
    /// Leaf first, then every intermediate up to (not including) the root.
    pub cert_pem: Vec<u8>,
    /// The leaf alone.
    pub leaf_pem: Vec<u8>,
    pub key_pem: SecretBox<Vec<u8>>,
    /// SHA-256 of the leaf DER, lowercase hex.
    pub thumbprint: String,
    /// The DER serial, for CRLs.
    pub serial: Vec<u8>,
}

impl std::fmt::Debug for IssuedLeaf {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("IssuedLeaf")
            .field("thumbprint", &self.thumbprint)
            .field("key_pem", &"<redacted>")
            .finish_non_exhaustive()
    }
}

impl IssuedLeaf {
    pub(crate) fn new(
        leaf_der: &[u8],
        leaf_pem: String,
        intermediates_pem: &str,
        key: &KeyPair,
        serial: Vec<u8>,
    ) -> Self {
        let mut cert_pem = leaf_pem.clone().into_bytes();
        cert_pem.extend_from_slice(intermediates_pem.as_bytes());
        Self {
            cert_pem,
            leaf_pem: leaf_pem.into_bytes(),
            key_pem: SecretBox::new(Box::new(key.serialize_pem().into_bytes())),
            thumbprint: hex::encode(Sha256::digest(leaf_der)),
            serial,
        }
    }

    /// Load the leaf as a [`TlsIdentity`].
    ///
    /// # Panics
    ///
    /// When the identity is refused (an intentionally bad fixture).
    #[must_use]
    pub fn identity(&self) -> TlsIdentity {
        self.try_identity()
            .expect("issued leaf is a valid identity")
    }

    /// Load the leaf as a [`TlsIdentity`], keeping the refusal.
    ///
    /// # Errors
    ///
    /// As [`TlsIdentity::from_pem`].
    pub fn try_identity(
        &self,
    ) -> Result<TlsIdentity, opensesame_domain::transport::TransportError> {
        TlsIdentity::from_pem(&self.cert_pem, &self.key_pem)
    }

    /// The key as a [`SecretBytes`] copy.
    #[must_use]
    pub fn key_secret(&self) -> SecretBytes {
        SecretBox::new(Box::new(self.key_pem.expose_secret().clone()))
    }

    /// Write `cert.pem` / `key.pem` (key mode 0600) into `dir`.
    ///
    /// # Panics
    ///
    /// When the files cannot be written.
    #[must_use]
    pub fn write_to(&self, dir: &Path) -> (PathBuf, PathBuf) {
        let cert = dir.join("cert.pem");
        let key = dir.join("key.pem");
        std::fs::write(&cert, &self.cert_pem).expect("write cert");
        std::fs::write(&key, self.key_pem.expose_secret()).expect("write key");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&key, std::fs::Permissions::from_mode(0o600))
                .expect("chmod key");
        }
        (cert, key)
    }

    /// This certificate with `other`'s key: a mismatch fixture.
    #[must_use]
    pub fn with_other_key(&self, other: &IssuedLeaf) -> IssuedLeaf {
        IssuedLeaf {
            cert_pem: self.cert_pem.clone(),
            leaf_pem: self.leaf_pem.clone(),
            key_pem: SecretBox::new(Box::new(other.key_pem.expose_secret().clone())),
            thumbprint: self.thumbprint.clone(),
            serial: self.serial.clone(),
        }
    }

    /// This leaf with one byte of its signature flipped: a bad-signature
    /// fixture. The DER is re-encoded as PEM, so it still parses.
    #[must_use]
    pub fn with_corrupted_signature(&self) -> IssuedLeaf {
        let (leaf_der, rest) = split_leaf(&self.cert_pem);
        let mut der = leaf_der;
        let last = der.len() - 1;
        der[last] ^= 0x01;
        let leaf_pem = pem_encode("CERTIFICATE", &der);
        let mut cert_pem = leaf_pem.clone().into_bytes();
        cert_pem.extend_from_slice(&rest);
        IssuedLeaf {
            cert_pem,
            leaf_pem: leaf_pem.into_bytes(),
            key_pem: SecretBox::new(Box::new(self.key_pem.expose_secret().clone())),
            thumbprint: hex::encode(Sha256::digest(&der)),
            serial: self.serial.clone(),
        }
    }

    /// The leaf without its intermediates: a missing-intermediate fixture.
    #[must_use]
    pub fn without_intermediates(&self) -> IssuedLeaf {
        IssuedLeaf {
            cert_pem: self.leaf_pem.clone(),
            leaf_pem: self.leaf_pem.clone(),
            key_pem: SecretBox::new(Box::new(self.key_pem.expose_secret().clone())),
            thumbprint: self.thumbprint.clone(),
            serial: self.serial.clone(),
        }
    }
}

fn split_leaf(chain_pem: &[u8]) -> (Vec<u8>, Vec<u8>) {
    use rustls_pki_types::pem::PemObject;
    let mut iter = rustls_pki_types::CertificateDer::pem_slice_iter(chain_pem);
    let leaf = iter.next().expect("leaf").expect("leaf parses").to_vec();
    let rest: Vec<u8> = iter
        .flat_map(|c| {
            pem_encode("CERTIFICATE", c.expect("intermediate parses").as_ref()).into_bytes()
        })
        .collect();
    (leaf, rest)
}

pub(crate) fn pem_encode(label: &str, der: &[u8]) -> String {
    use base64_lines::encode_lines;
    format!(
        "-----BEGIN {label}-----\n{}-----END {label}-----\n",
        encode_lines(der)
    )
}

mod base64_lines {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    /// Append one character, breaking the line after 64 columns.
    fn push_wrapped(out: &mut String, column: &mut usize, c: u8) {
        out.push(char::from(c));
        *column += 1;
        if *column == 64 {
            out.push('\n');
            *column = 0;
        }
    }

    pub(super) fn encode_lines(bytes: &[u8]) -> String {
        let mut out = String::new();
        let mut column = 0;
        for chunk in bytes.chunks(3) {
            let b = [
                chunk[0],
                *chunk.get(1).unwrap_or(&0),
                *chunk.get(2).unwrap_or(&0),
            ];
            let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
            let quad = [
                TABLE[(n >> 18) as usize & 63],
                TABLE[(n >> 12) as usize & 63],
                if chunk.len() > 1 {
                    TABLE[(n >> 6) as usize & 63]
                } else {
                    b'='
                },
                if chunk.len() > 2 {
                    TABLE[n as usize & 63]
                } else {
                    b'='
                },
            ];
            for c in quad {
                push_wrapped(&mut out, &mut column, c);
            }
        }
        if column != 0 {
            out.push('\n');
        }
        out
    }
}
