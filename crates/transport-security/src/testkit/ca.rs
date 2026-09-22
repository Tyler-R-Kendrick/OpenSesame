//! Disposable certificate authorities.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use chrono::{Duration, Utc};
use opensesame_domain::transport::PeerIdentitySelector;
use rcgen::{
    CertificateParams, CertificateRevocationListParams, DnType, Issuer, KeyPair, KeyUsagePurpose,
    RevokedCertParams, SerialNumber,
};

use super::leaf::{IssuedLeaf, LeafSpec, SanEntry};

static SERIAL: AtomicU64 = AtomicU64::new(0x1000);

fn next_serial() -> SerialNumber {
    SerialNumber::from(SERIAL.fetch_add(1, Ordering::SeqCst).to_be_bytes().to_vec())
}

/// A root or intermediate CA that lives only for the test.
pub struct DisposableCa {
    name: String,
    key: KeyPair,
    params: CertificateParams,
    cert_pem: String,
    cert_der: Vec<u8>,
    /// This CA's own certificate plus its ancestors (root last).
    parents_pem: String,
    /// Root of this CA's hierarchy.
    root_pem: Arc<String>,
}

impl std::fmt::Debug for DisposableCa {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DisposableCa")
            .field("name", &self.name)
            .finish_non_exhaustive()
    }
}

fn ca_params(name: &str) -> CertificateParams {
    let mut params = CertificateParams::default();
    params
        .distinguished_name
        .push(DnType::CommonName, name.to_owned());
    params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
    params.key_usages = vec![
        KeyUsagePurpose::KeyCertSign,
        KeyUsagePurpose::CrlSign,
        KeyUsagePurpose::DigitalSignature,
    ];
    params.not_before = super::to_offset(Utc::now() - Duration::hours(1));
    params.not_after = super::to_offset(Utc::now() + Duration::days(30));
    params.serial_number = Some(next_serial());
    params.use_authority_key_identifier_extension = true;
    params
}

impl DisposableCa {
    /// A self-signed root named `name`.
    ///
    /// # Panics
    ///
    /// When key generation or signing fails.
    #[must_use]
    pub fn new(name: &str) -> Self {
        let key = KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256).expect("ca key");
        let params = ca_params(name);
        let cert = params.self_signed(&key).expect("self-signed root");
        let cert_pem = cert.pem();
        Self {
            name: name.to_owned(),
            key,
            params,
            cert_der: cert.der().to_vec(),
            parents_pem: String::new(),
            root_pem: Arc::new(cert_pem.clone()),
            cert_pem,
        }
    }

    fn issuer(&self) -> Issuer<'_, &KeyPair> {
        Issuer::from_params(&self.params, &self.key)
    }

    /// An intermediate CA signed by this one.
    ///
    /// # Panics
    ///
    /// When key generation or signing fails.
    #[must_use]
    pub fn intermediate(&self, name: &str) -> DisposableCa {
        self.intermediate_with(
            name,
            Utc::now() - Duration::hours(1),
            Utc::now() + Duration::days(30),
            true,
        )
    }

    /// An intermediate with a chosen validity window, optionally *not*
    /// marked as a CA (`basicConstraints.cA = false`, still used to sign):
    /// the "invalid intermediate constraints" fixture.
    ///
    /// # Panics
    ///
    /// When key generation or signing fails.
    #[must_use]
    pub fn intermediate_with(
        &self,
        name: &str,
        not_before: chrono::DateTime<Utc>,
        not_after: chrono::DateTime<Utc>,
        is_ca: bool,
    ) -> DisposableCa {
        let key = KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256).expect("ca key");
        let mut params = ca_params(name);
        params.not_before = super::to_offset(not_before);
        params.not_after = super::to_offset(not_after);
        if !is_ca {
            params.is_ca = rcgen::IsCa::ExplicitNoCa;
        }
        let cert = params
            .signed_by(&key, &self.issuer())
            .expect("intermediate");
        let cert_pem = cert.pem();
        // What a leaf of the new CA presents besides itself: the new CA,
        // then every ancestor that is not the root.
        let mut parents_pem = String::new();
        if !self.is_root() {
            parents_pem.push_str(&self.cert_pem);
            parents_pem.push_str(&self.parents_pem);
        }
        DisposableCa {
            name: name.to_owned(),
            key,
            params,
            cert_der: cert.der().to_vec(),
            parents_pem,
            root_pem: Arc::clone(&self.root_pem),
            cert_pem,
        }
    }

    fn is_root(&self) -> bool {
        self.cert_pem == *self.root_pem
    }

    /// This CA's certificate, PEM.
    #[must_use]
    pub fn ca_pem(&self) -> Vec<u8> {
        self.cert_pem.clone().into_bytes()
    }

    /// This CA's certificate, DER.
    #[must_use]
    pub fn ca_der(&self) -> Vec<u8> {
        self.cert_der.clone()
    }

    /// The hierarchy's root certificate, PEM: what a peer puts in its
    /// trust bundle.
    #[must_use]
    pub fn root_pem(&self) -> Vec<u8> {
        self.root_pem.as_bytes().to_vec()
    }

    /// The intermediates a leaf of this CA presents (this CA and its
    /// non-root ancestors), PEM; empty for a root.
    #[must_use]
    pub fn chain_pem(&self) -> Vec<u8> {
        let mut out = String::new();
        if self.is_root() {
            return Vec::new();
        }
        out.push_str(&self.cert_pem);
        out.push_str(&self.parents_pem);
        out.into_bytes()
    }

    #[must_use]
    pub fn name(&self) -> &str {
        &self.name
    }

    /// Issue any leaf.
    ///
    /// # Panics
    ///
    /// When signing fails.
    #[must_use]
    pub fn issue_with(&self, spec: &LeafSpec) -> IssuedLeaf {
        let key = spec.generate_key();
        let mut params = spec.params();
        let serial = next_serial();
        params.serial_number = Some(serial.clone());
        let cert = params
            .signed_by(&key, &self.issuer())
            .expect("leaf signing");
        let intermediates = String::from_utf8(self.chain_pem()).expect("pem utf8");
        IssuedLeaf::new(
            cert.der(),
            cert.pem(),
            &intermediates,
            &key,
            serial.as_ref().to_vec(),
        )
    }

    /// A `serverAuth` leaf for `dns`.
    #[must_use]
    pub fn issue_server(&self, dns: &str) -> IssuedLeaf {
        self.issue_with(&LeafSpec::server(dns))
    }

    /// A `clientAuth` leaf carrying `selector` as its SAN (none for a
    /// thumbprint selector).
    ///
    /// # Panics
    ///
    /// When the selector is a thumbprint that is not a valid SAN.
    #[must_use]
    pub fn issue_client(&self, selector: PeerIdentitySelector) -> IssuedLeaf {
        let sans = match selector {
            PeerIdentitySelector::DnsName(d) => vec![SanEntry::Dns(d)],
            PeerIdentitySelector::SpiffeId(u) | PeerIdentitySelector::UriSan(u) => {
                vec![SanEntry::Uri(u)]
            }
            PeerIdentitySelector::LeafThumbprintSha256(_) => Vec::new(),
        };
        self.issue_with(&LeafSpec::client(sans))
    }

    /// A SPIFFE X.509-SVID for `spiffe_id`.
    #[must_use]
    pub fn issue_spiffe(&self, spiffe_id: &str) -> IssuedLeaf {
        self.issue_with(&LeafSpec::spiffe(spiffe_id))
    }

    /// A CRL signed by this CA revoking `leaves`.
    ///
    /// # Panics
    ///
    /// When signing fails.
    #[must_use]
    pub fn crl_pem(&self, leaves: &[&IssuedLeaf]) -> Vec<u8> {
        let now = Utc::now();
        let params = CertificateRevocationListParams {
            this_update: super::to_offset(now - Duration::minutes(1)),
            next_update: super::to_offset(now + Duration::days(1)),
            crl_number: next_serial(),
            issuing_distribution_point: None,
            revoked_certs: leaves
                .iter()
                .map(|leaf| RevokedCertParams {
                    serial_number: SerialNumber::from(leaf.serial.clone()),
                    revocation_time: super::to_offset(now - Duration::minutes(1)),
                    reason_code: Some(rcgen::RevocationReason::KeyCompromise),
                    invalidity_date: None,
                })
                .collect(),
            key_identifier_method: rcgen::KeyIdMethod::Sha256,
        };
        params
            .signed_by(&self.issuer())
            .expect("crl")
            .pem()
            .expect("crl pem")
            .into_bytes()
    }
}
