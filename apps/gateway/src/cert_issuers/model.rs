use std::collections::BTreeSet;
use std::fmt;
use std::net::IpAddr;
use std::time::Duration;

use rcgen::{
    CertificateParams, DistinguishedName, DnType, ExtendedKeyUsagePurpose, KeyPair,
    KeyUsagePurpose, PKCS_ECDSA_P256_SHA256,
};
use serde::{Deserialize, Serialize};
use x509_parser::extensions::GeneralName;
use x509_parser::pem::parse_x509_pem;
use x509_parser::prelude::parse_x509_certificate;
use zeroize::Zeroizing;

pub const DEFAULT_TTL: Duration = Duration::from_secs(24 * 60 * 60);
pub const MAX_TTL: Duration = Duration::from_secs(90 * 24 * 60 * 60);
const MAX_DNS_NAMES: usize = 100;
const MAX_IP_ADDRS: usize = 16;
const MAX_CERTIFICATE_CHAIN_BYTES: usize = 256 * 1024;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum IssuerKind {
    OpenSesamePrivateCa,
    LetsEncrypt,
    LetsEncryptStaging,
    ZeroSsl,
    CloudflareOriginCa,
}

impl IssuerKind {
    pub const fn trust(self) -> TrustClass {
        match self {
            Self::OpenSesamePrivateCa => TrustClass::PrivateLocal,
            Self::LetsEncrypt | Self::ZeroSsl => TrustClass::PublicWeb,
            Self::LetsEncryptStaging => TrustClass::TestOnly,
            Self::CloudflareOriginCa => TrustClass::OriginOnly,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TrustClass {
    PrivateLocal,
    PublicWeb,
    TestOnly,
    OriginOnly,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ChallengeKind {
    Dns01,
    Http01,
    TlsAlpn01,
}

impl ChallengeKind {
    pub fn require_dns01(self) -> Result<(), IssuerError> {
        match self {
            Self::Dns01 => Ok(()),
            Self::Http01 | Self::TlsAlpn01 => Err(IssuerError::UnsupportedChallenge(self)),
        }
    }
}

#[derive(Clone, Debug)]
pub struct CertificateRequestInput {
    pub common_name: String,
    pub dns_names: Vec<String>,
    pub ip_addrs: Vec<IpAddr>,
    pub ttl: Option<Duration>,
}

impl CertificateRequestInput {
    #[cfg(test)]
    pub fn new(common_name: impl Into<String>) -> Self {
        Self {
            common_name: common_name.into(),
            dns_names: Vec::new(),
            ip_addrs: Vec::new(),
            ttl: None,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CertificateRequest {
    common_name: String,
    dns_names: Vec<String>,
    ip_addrs: Vec<IpAddr>,
    ttl: Duration,
}

impl TryFrom<CertificateRequestInput> for CertificateRequest {
    type Error = IssuerError;

    fn try_from(input: CertificateRequestInput) -> Result<Self, Self::Error> {
        if input.dns_names.len() > MAX_DNS_NAMES {
            return Err(IssuerError::TooManyDnsNames);
        }
        if input.ip_addrs.len() > MAX_IP_ADDRS {
            return Err(IssuerError::TooManyIpAddresses);
        }

        let common_name = normalize_dns_name(&input.common_name)?;
        let mut dns_names = BTreeSet::new();
        dns_names.insert(common_name.clone());
        for name in input.dns_names {
            dns_names.insert(normalize_dns_name(&name)?);
        }

        let ttl = input.ttl.unwrap_or(DEFAULT_TTL);
        if ttl.is_zero() || ttl > MAX_TTL {
            return Err(IssuerError::InvalidTtl);
        }

        let ip_addrs = input.ip_addrs.into_iter().collect::<BTreeSet<_>>();
        Ok(Self {
            common_name,
            dns_names: dns_names.into_iter().collect(),
            ip_addrs: ip_addrs.into_iter().collect(),
            ttl,
        })
    }
}

impl CertificateRequest {
    pub fn common_name(&self) -> &str {
        &self.common_name
    }

    pub fn dns_names(&self) -> &[String] {
        &self.dns_names
    }

    pub fn ip_addrs(&self) -> &[IpAddr] {
        &self.ip_addrs
    }

    pub const fn ttl(&self) -> Duration {
        self.ttl
    }

    pub fn require_public_dns(&self) -> Result<(), IssuerError> {
        if !self.ip_addrs.is_empty()
            || self.dns_names.iter().any(|name| {
                let bare = name.strip_prefix("*.").unwrap_or(name);
                bare == "localhost" || !bare.contains('.')
            })
        {
            return Err(IssuerError::PublicDnsRequired);
        }
        Ok(())
    }
}

fn normalize_dns_name(raw: &str) -> Result<String, IssuerError> {
    let name = raw.trim().to_ascii_lowercase();
    if name.is_empty() || name.len() > 253 || name.ends_with('.') || !name.is_ascii() {
        return Err(IssuerError::InvalidDnsName);
    }
    let bare = name.strip_prefix("*.").unwrap_or(&name);
    if bare.is_empty() || bare.contains('*') {
        return Err(IssuerError::InvalidDnsName);
    }
    for label in bare.split('.') {
        if label.is_empty()
            || label.len() > 63
            || label.starts_with('-')
            || label.ends_with('-')
            || !label
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        {
            return Err(IssuerError::InvalidDnsName);
        }
    }
    Ok(name)
}

pub struct GeneratedLeafRequest {
    pub(crate) key_pair: KeyPair,
    csr_der: Vec<u8>,
    csr_pem: String,
}

impl fmt::Debug for GeneratedLeafRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GeneratedLeafRequest")
            .field("csr_der_len", &self.csr_der.len())
            .field("private_key", &"[REDACTED]")
            .finish()
    }
}

impl GeneratedLeafRequest {
    pub fn generate(request: &CertificateRequest) -> Result<Self, IssuerError> {
        let key_pair = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256)
            .map_err(|_| IssuerError::KeyGeneration)?;
        let mut params = leaf_params(request)?;
        params.distinguished_name = DistinguishedName::new();
        params
            .distinguished_name
            .push(DnType::CommonName, request.common_name());
        let csr = params
            .serialize_request(&key_pair)
            .map_err(|_| IssuerError::CsrGeneration)?;
        let csr_der = csr.der().as_ref().to_vec();
        let csr_pem = csr.pem().map_err(|_| IssuerError::CsrGeneration)?;
        Ok(Self {
            key_pair,
            csr_der,
            csr_pem,
        })
    }

    pub fn csr_der(&self) -> &[u8] {
        &self.csr_der
    }

    pub fn csr_pem(&self) -> &str {
        &self.csr_pem
    }

    pub(crate) fn into_private_key(self) -> Zeroizing<String> {
        Zeroizing::new(self.key_pair.serialize_pem())
    }
}

pub(crate) fn leaf_params(request: &CertificateRequest) -> Result<CertificateParams, IssuerError> {
    let mut params = CertificateParams::new(request.dns_names.clone())
        .map_err(|_| IssuerError::InvalidDnsName)?;
    params.key_usages = vec![KeyUsagePurpose::DigitalSignature];
    params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
    for ip in request.ip_addrs() {
        params
            .subject_alt_names
            .push(rcgen::SanType::IpAddress(*ip));
    }
    Ok(params)
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CertificateBundle {
    pub certificate_chain_pem: String,
    pub issuer_certificate_pem: Option<String>,
    pub issuer: IssuerKind,
    pub trust: TrustClass,
    pub common_name: String,
    pub dns_names: Vec<String>,
}

pub struct IssuedCertificate {
    bundle: CertificateBundle,
    private_key_pem: Zeroizing<String>,
}

impl fmt::Debug for IssuedCertificate {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("IssuedCertificate")
            .field("issuer", &self.bundle.issuer)
            .field("trust", &self.bundle.trust)
            .field("common_name", &self.bundle.common_name)
            .field("private_key_pem", &"[REDACTED]")
            .finish()
    }
}

impl IssuedCertificate {
    pub(crate) fn new(bundle: CertificateBundle, private_key_pem: Zeroizing<String>) -> Self {
        Self {
            bundle,
            private_key_pem,
        }
    }

    #[cfg(test)]
    pub fn bundle(&self) -> &CertificateBundle {
        &self.bundle
    }

    /// Consumes the issuance result so leaf-key material can only be handed to
    /// the caller once by this boundary.
    pub fn into_delivery(self) -> (CertificateBundle, Zeroizing<String>) {
        (self.bundle, self.private_key_pem)
    }
}

pub(crate) fn normalize_external_certificate(
    chain_pem: String,
    leaf: GeneratedLeafRequest,
    request: &CertificateRequest,
    issuer: IssuerKind,
    require_issuer_in_chain: bool,
) -> Result<IssuedCertificate, IssuerError> {
    if chain_pem.len() > MAX_CERTIFICATE_CHAIN_BYTES {
        return Err(IssuerError::InvalidCertificateResponse);
    }
    let mut remaining = chain_pem.as_bytes();
    let mut certificates = Vec::new();
    while !remaining.iter().all(u8::is_ascii_whitespace) {
        if certificates.len() == 5 {
            return Err(IssuerError::InvalidCertificateResponse);
        }
        let (rest, pem) =
            parse_x509_pem(remaining).map_err(|_| IssuerError::InvalidCertificateResponse)?;
        certificates.push(pem.contents);
        remaining = rest;
    }
    if certificates.is_empty()
        || (require_issuer_in_chain && certificates.len() < 2)
        || (!require_issuer_in_chain && certificates.len() != 1)
    {
        return Err(IssuerError::InvalidCertificateResponse);
    }

    let (_, certificate) = parse_x509_certificate(&certificates[0])
        .map_err(|_| IssuerError::InvalidCertificateResponse)?;
    if certificate.public_key().raw != leaf.key_pair.public_key_der() {
        return Err(IssuerError::CertificateKeyMismatch);
    }
    if !certificate.validity().is_valid() {
        return Err(IssuerError::InvalidCertificateResponse);
    }

    let extension = certificate
        .subject_alternative_name()
        .map_err(|_| IssuerError::InvalidCertificateResponse)?
        .ok_or(IssuerError::CertificateNamesMismatch)?;
    let actual_names = extension
        .value
        .general_names
        .iter()
        .map(|name| match name {
            GeneralName::DNSName(name) => normalize_dns_name(name),
            _ => Err(IssuerError::CertificateNamesMismatch),
        })
        .collect::<Result<BTreeSet<_>, _>>()?;
    let expected_names = request.dns_names.iter().cloned().collect::<BTreeSet<_>>();
    if actual_names != expected_names || !request.ip_addrs.is_empty() {
        return Err(IssuerError::CertificateNamesMismatch);
    }

    for pair in certificates.windows(2) {
        let (_, child) = parse_x509_certificate(&pair[0])
            .map_err(|_| IssuerError::InvalidCertificateResponse)?;
        let (_, parent) = parse_x509_certificate(&pair[1])
            .map_err(|_| IssuerError::InvalidCertificateResponse)?;
        if !parent.validity().is_valid() {
            return Err(IssuerError::InvalidCertificateResponse);
        }
        child
            .verify_signature(Some(parent.public_key()))
            .map_err(|_| IssuerError::InvalidCertificateResponse)?;
    }

    let private_key_pem = leaf.into_private_key();
    Ok(IssuedCertificate::new(
        CertificateBundle {
            certificate_chain_pem: chain_pem,
            issuer_certificate_pem: None,
            issuer,
            trust: issuer.trust(),
            common_name: request.common_name.clone(),
            dns_names: request.dns_names.clone(),
        },
        private_key_pem,
    ))
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum IssuerError {
    #[error("certificate DNS name is invalid")]
    InvalidDnsName,
    #[error("certificate request contains too many DNS names")]
    TooManyDnsNames,
    #[error("certificate request contains too many IP addresses")]
    TooManyIpAddresses,
    #[error("certificate lifetime is invalid")]
    InvalidTtl,
    #[error("public issuers require public DNS names and do not accept IP SANs")]
    PublicDnsRequired,
    #[error("leaf-key generation failed")]
    KeyGeneration,
    #[error("certificate signing request generation failed")]
    CsrGeneration,
    #[error("certificate issuer returned an invalid certificate")]
    InvalidCertificateResponse,
    #[error("issued certificate does not match the generated leaf key")]
    CertificateKeyMismatch,
    #[error("issued certificate names differ from the approved request")]
    CertificateNamesMismatch,
    #[error("challenge type {0:?} is unsupported; DNS-01 is required")]
    UnsupportedChallenge(ChallengeKind),
    #[error("ACME external account binding is required")]
    ExternalAccountBindingRequired,
    #[error("ACME external account binding is not accepted for this issuer")]
    UnexpectedExternalAccountBinding,
    #[error("ACME account configuration is invalid")]
    InvalidAccountConfiguration,
    #[error("ACME operation failed during {0}")]
    Acme(&'static str),
    #[error("DNS-01 provider failed during {0}")]
    Dns01(&'static str),
    #[error("ACME order failed and DNS cleanup also failed")]
    AcmeAndDnsCleanup,
    #[error("Cloudflare Origin CA rejected the request")]
    CloudflareRejected,
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    proptest! {
        #[test]
        fn property_certificate_request_parser_is_bounded_and_never_panics(
            common_name in ".{0,512}",
            dns_names in proptest::collection::vec(".{0,300}", 0..120),
        ) {
            let result = CertificateRequest::try_from(CertificateRequestInput {
                common_name,
                dns_names,
                ip_addrs: Vec::new(),
                ttl: None,
            });
            if let Ok(request) = result {
                prop_assert!(request.dns_names().len() <= 100);
                prop_assert!(request.dns_names().iter().all(|name| name.len() <= 253));
            }
        }
    }

    #[test]
    fn atomic_request_validation_normalizes_and_deduplicates_names() {
        let request = CertificateRequest::try_from(CertificateRequestInput {
            common_name: " Example.COM ".into(),
            dns_names: vec!["api.example.com".into(), "EXAMPLE.com".into()],
            ip_addrs: vec![],
            ttl: None,
        })
        .unwrap();
        assert_eq!(request.common_name(), "example.com");
        assert_eq!(request.dns_names(), &["api.example.com", "example.com"]);
        assert_eq!(request.ttl(), DEFAULT_TTL);
    }

    #[test]
    fn adversarial_request_rejects_ambiguous_names_and_unsupported_challenges() {
        for name in [
            "",
            ".example.com",
            "example.com.",
            "a..example.com",
            "a_1.example.com",
            "*.*.example.com",
        ] {
            assert_eq!(
                CertificateRequest::try_from(CertificateRequestInput::new(name)).unwrap_err(),
                IssuerError::InvalidDnsName
            );
        }
        assert_eq!(
            ChallengeKind::Http01.require_dns01().unwrap_err(),
            IssuerError::UnsupportedChallenge(ChallengeKind::Http01)
        );
        assert_eq!(
            ChallengeKind::TlsAlpn01.require_dns01().unwrap_err(),
            IssuerError::UnsupportedChallenge(ChallengeKind::TlsAlpn01)
        );
    }

    #[test]
    fn adversarial_public_ca_rejects_local_and_ip_requests() {
        let local =
            CertificateRequest::try_from(CertificateRequestInput::new("localhost")).unwrap();
        assert_eq!(
            local.require_public_dns(),
            Err(IssuerError::PublicDnsRequired)
        );

        let mut input = CertificateRequestInput::new("example.com");
        input.ip_addrs.push("127.0.0.1".parse().unwrap());
        let request = CertificateRequest::try_from(input).unwrap();
        assert_eq!(
            request.require_public_dns(),
            Err(IssuerError::PublicDnsRequired)
        );
    }

    #[test]
    fn secrets_are_redacted_and_leaf_key_delivery_is_consuming() {
        let request =
            CertificateRequest::try_from(CertificateRequestInput::new("example.com")).unwrap();
        let leaf = GeneratedLeafRequest::generate(&request).unwrap();
        let debug = format!("{leaf:?}");
        assert!(debug.contains("[REDACTED]"));
        assert!(!debug.contains("BEGIN PRIVATE KEY"));
        assert!(leaf.csr_pem().contains("BEGIN CERTIFICATE REQUEST"));
        assert!(leaf.into_private_key().contains("BEGIN PRIVATE KEY"));
    }
}
