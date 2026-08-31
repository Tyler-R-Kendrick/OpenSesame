//! Dev-certificate issuance (Infisical-style private CA, localhost TLS).
//!
//! The Host holds a long-lived ECDSA P-256 root CA. Operators and owner/admin
//! sessions issue short-lived leaf certificates for local development. Leaf
//! private keys are returned once and never stored on the Host.

use std::net::IpAddr;
use std::time::Duration as StdDuration;

use rcgen::{
    BasicConstraints, CertificateParams, DistinguishedName, DnType, ExtendedKeyUsagePurpose, IsCa,
    KeyPair, KeyUsagePurpose, SanType, SerialNumber, PKCS_ECDSA_P256_SHA256,
};
use serde::{Deserialize, Serialize};
use time::{format_description::well_known::Rfc3339, Duration, OffsetDateTime};
use x509_parser::{pem::parse_x509_pem, prelude::parse_x509_certificate};

pub const DEV_CA_CN: &str = "OpenSesame Dev CA";
pub const MAX_TTL: StdDuration = StdDuration::from_secs(90 * 24 * 3600);
pub const DEFAULT_TTL: StdDuration = StdDuration::from_secs(24 * 3600);

#[derive(Clone, Serialize, Deserialize)]
pub struct DevCa {
    pub cert_pem: String,
    pub key_pem: String,
}

impl std::fmt::Debug for DevCa {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("DevCa")
            .field("cert_pem", &"[PUBLIC CERTIFICATE]")
            .field("key_pem", &"[REDACTED]")
            .finish()
    }
}

#[derive(Clone, Debug)]
pub struct IssueRequest {
    pub common_name: String,
    pub dns_names: Vec<String>,
    pub ip_addrs: Vec<IpAddr>,
    pub ttl: StdDuration,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct IssuedCert {
    pub certificate: String,
    pub private_key: String,
    pub ca_certificate: String,
    pub serial: String,
    pub common_name: String,
    pub dns_names: Vec<String>,
    pub not_before: String,
    pub not_after: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct IssuedRecord {
    pub serial: String,
    pub common_name: String,
    pub dns_names: Vec<String>,
    pub not_before: String,
    pub not_after: String,
    pub issued_at: String,
}

pub fn generate_dev_ca() -> Result<DevCa, String> {
    let mut params =
        CertificateParams::new(Vec::<String>::new()).map_err(|error| error.to_string())?;
    params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    params.distinguished_name = DistinguishedName::new();
    params
        .distinguished_name
        .push(DnType::CommonName, DEV_CA_CN);
    params
        .distinguished_name
        .push(DnType::OrganizationName, "OpenSesame");
    params.key_usages = vec![
        KeyUsagePurpose::DigitalSignature,
        KeyUsagePurpose::KeyCertSign,
        KeyUsagePurpose::CrlSign,
    ];
    params.not_before = OffsetDateTime::now_utc() - Duration::minutes(1);
    params.not_after = OffsetDateTime::now_utc() + Duration::days(3650);
    let key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).map_err(|e| e.to_string())?;
    let cert = params.self_signed(&key).map_err(|e| e.to_string())?;
    Ok(DevCa {
        cert_pem: cert.pem(),
        key_pem: key.serialize_pem(),
    })
}

pub fn validate_ca(ca: &DevCa) -> Result<(), String> {
    let key = KeyPair::from_pem(&ca.key_pem).map_err(|_| "invalid CA private key")?;
    let (remaining, pem) =
        parse_x509_pem(ca.cert_pem.as_bytes()).map_err(|_| "invalid CA certificate")?;
    if !remaining.iter().all(u8::is_ascii_whitespace) {
        return Err("invalid CA certificate".into());
    }
    let (_, certificate) =
        parse_x509_certificate(&pem.contents).map_err(|_| "invalid CA certificate")?;
    let is_ca = certificate
        .basic_constraints()
        .map_err(|_| "invalid CA constraints")?
        .is_some_and(|constraint| constraint.value.ca);
    let can_sign = certificate
        .key_usage()
        .map_err(|_| "invalid CA key usage")?
        .is_some_and(|usage| usage.value.key_cert_sign());
    if !is_ca
        || !can_sign
        || certificate.public_key().raw != key.public_key_der()
        || certificate.verify_signature(None).is_err()
    {
        return Err("CA certificate and private key do not form a signing authority".into());
    }
    Ok(())
}

pub fn issue_leaf(ca: &DevCa, request: &IssueRequest) -> Result<IssuedCert, String> {
    validate_ca(ca)?;
    let cn = request.common_name.trim();
    if cn.is_empty() {
        return Err("common_name is required".into());
    }
    if cn.contains('\0') || cn.contains('\n') {
        return Err("common_name is not a valid DNS name".into());
    }
    let ttl = if request.ttl.is_zero() {
        DEFAULT_TTL
    } else {
        request.ttl.min(MAX_TTL)
    };

    let mut dns: Vec<String> = request
        .dns_names
        .iter()
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
        .collect();
    if !dns.iter().any(|name| name == cn) {
        dns.insert(0, cn.to_string());
    }

    let ca_key = KeyPair::from_pem(&ca.key_pem).map_err(|e| e.to_string())?;
    let ca_params = CertificateParams::from_ca_cert_pem(&ca.cert_pem).map_err(|e| e.to_string())?;
    let issuer_cert = ca_params.self_signed(&ca_key).map_err(|e| e.to_string())?;

    let mut params = CertificateParams::new(dns.clone()).map_err(|e| e.to_string())?;
    params.distinguished_name = DistinguishedName::new();
    params.distinguished_name.push(DnType::CommonName, cn);
    params.key_usages = vec![KeyUsagePurpose::DigitalSignature];
    params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
    params.serial_number = Some(SerialNumber::from_slice(
        &uuid::Uuid::new_v4().as_bytes()[..],
    ));
    let not_before = OffsetDateTime::now_utc() - Duration::minutes(1);
    let not_after = OffsetDateTime::now_utc()
        + Duration::seconds(i64::try_from(ttl.as_secs()).unwrap_or(i64::MAX));
    params.not_before = not_before;
    params.not_after = not_after;
    for ip in &request.ip_addrs {
        params.subject_alt_names.push(SanType::IpAddress(*ip));
    }
    let serial = params
        .serial_number
        .as_ref()
        .map(|number| hex::encode(number.to_bytes()))
        .unwrap_or_default();
    let leaf_key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).map_err(|e| e.to_string())?;
    let cert = params
        .signed_by(&leaf_key, &issuer_cert, &ca_key)
        .map_err(|e| e.to_string())?;

    Ok(IssuedCert {
        certificate: cert.pem(),
        private_key: leaf_key.serialize_pem(),
        ca_certificate: ca.cert_pem.clone(),
        serial,
        common_name: cn.to_string(),
        dns_names: dns,
        not_before: rfc3339(not_before)?,
        not_after: rfc3339(not_after)?,
    })
}

/// Certificate validity as RFC 3339.
///
/// `OffsetDateTime`'s `Display` is *not* RFC 3339 — it renders
/// `2026-08-31 0:00:00.0 +00:00:00`, with a space instead of `T` and a
/// seconds-bearing offset. Storing that shape had two consequences that only
/// surface far from here: `SQLite`'s `julianday()` returns NULL for it, so
/// `list_certificates_expiring_before` silently matched nothing, and the
/// lifecycle scanner's RFC 3339 parse dropped the subject. Between them, an
/// expiring certificate produced no signal at all.
///
/// # Errors
///
/// Returns an error when the instant falls outside the years RFC 3339 can
/// spell, which no clock reading reaches.
fn rfc3339(at: OffsetDateTime) -> Result<String, String> {
    at.format(&Rfc3339)
        .map_err(|error| format!("timestamp is not representable as RFC 3339: {error}"))
}

/// # Errors
///
/// Returns an error when the current instant cannot be spelled as RFC 3339.
pub fn to_record(issued: &IssuedCert) -> Result<IssuedRecord, String> {
    Ok(IssuedRecord {
        serial: issued.serial.clone(),
        common_name: issued.common_name.clone(),
        dns_names: issued.dns_names.clone(),
        not_before: issued.not_before.clone(),
        not_after: issued.not_after.clone(),
        issued_at: rfc3339(OffsetDateTime::now_utc())?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{IpAddr, Ipv4Addr};

    #[test]
    fn issues_a_localhost_leaf_signed_by_the_dev_ca() {
        let ca = generate_dev_ca().expect("ca");
        assert!(ca.cert_pem.contains("BEGIN CERTIFICATE"));
        assert!(
            ca.key_pem.contains("BEGIN PRIVATE KEY") || ca.key_pem.contains("BEGIN EC PRIVATE KEY")
        );
        let issued = issue_leaf(
            &ca,
            &IssueRequest {
                common_name: "localhost".into(),
                dns_names: vec!["localhost".into(), "*.local".into()],
                ip_addrs: vec![IpAddr::V4(Ipv4Addr::LOCALHOST)],
                ttl: StdDuration::from_secs(3600),
            },
        )
        .expect("leaf");
        assert!(issued.certificate.contains("BEGIN CERTIFICATE"));
        assert!(issued.private_key.contains("BEGIN"));
        assert_eq!(issued.ca_certificate, ca.cert_pem);
        assert_eq!(issued.common_name, "localhost");
        assert!(issued.dns_names.contains(&"localhost".to_string()));
        assert!(!issued.serial.is_empty());
    }

    #[test]
    fn rejects_a_blank_common_name() {
        let ca = generate_dev_ca().unwrap();
        let error = issue_leaf(
            &ca,
            &IssueRequest {
                common_name: "  ".into(),
                dns_names: vec![],
                ip_addrs: vec![],
                ttl: StdDuration::from_secs(1),
            },
        )
        .unwrap_err();
        assert!(error.contains("common_name"));
    }

    #[test]
    fn adversarial_rejects_a_substituted_ca_private_key() {
        let mut ca = generate_dev_ca().unwrap();
        ca.key_pem = generate_dev_ca().unwrap().key_pem;
        assert!(validate_ca(&ca).is_err());
        assert!(issue_leaf(
            &ca,
            &IssueRequest {
                common_name: "localhost".into(),
                dns_names: vec!["localhost".into()],
                ip_addrs: vec![],
                ttl: DEFAULT_TTL,
            }
        )
        .is_err());
    }
}
