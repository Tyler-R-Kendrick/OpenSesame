//! Translation between this crate's domain types and the certificate
//! builder's parameters (ADR 0066 domain model).
//!
//! Kept private so the public API never leaks a builder type: callers hand in
//! [`SubjectDn`], [`SanEntry`], [`KeyUsage`] and friends, and never see
//! `rcgen`.
//!
//! Secrecy invariant: this module handles only names, usages and extension
//! URLs — all public certificate material.

use rcgen::{
    CertificateParams, CustomExtension, DistinguishedName, DnType, DnValue,
    ExtendedKeyUsagePurpose, Ia5String, KeyUsagePurpose, OtherNameValue, SanType,
};

use crate::error::PkiError;
use crate::types::{ExtendedKeyUsage, KeyUsage, SanEntry, SubjectDn};
use crate::x509;

/// `domainComponent`, OID 0.9.2342.19200300.100.1.25.
const DC_OID: [u64; 7] = [0, 9, 2342, 19_200_300, 100, 1, 25];

/// `id-pe-authorityInfoAccess`, OID 1.3.6.1.5.5.7.1.1.
const AIA_OID: [u64; 9] = [1, 3, 6, 1, 5, 5, 7, 1, 1];

/// `id-ad-ocsp`, OID 1.3.6.1.5.5.7.48.1, encoded as DER content octets.
const ID_AD_OCSP_DER: [u8; 8] = [0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x30, 0x01];

/// Largest number of URLs accepted in one CDP or AIA extension.
pub(crate) const MAX_DISTRIBUTION_URLS: usize = 8;

/// Writes `subject` into `params`' distinguished name.
///
/// # Errors
/// Returns [`PkiError::InvalidName`] when the subject is empty or an attribute
/// value is blank, and [`PkiError::NotYetSupported`] when the subject carries
/// more than one `domainComponent`: the certificate builder keys a
/// distinguished name by attribute *type*, so it cannot emit a repeated
/// attribute. Multi-component `dc` values parse and evaluate against policy
/// correctly; only issuance is affected.
pub(crate) fn apply_subject(
    params: &mut CertificateParams,
    subject: &SubjectDn,
) -> Result<(), PkiError> {
    if subject.is_empty() {
        return Err(PkiError::InvalidName);
    }
    if subject.dc.len() > 1 {
        return Err(PkiError::NotYetSupported(
            "issuing a subject with more than one domainComponent",
        ));
    }
    let mut name = DistinguishedName::new();
    for (kind, value) in [
        (DnType::CommonName, subject.cn.as_ref()),
        (DnType::OrganizationName, subject.o.as_ref()),
        (DnType::OrganizationalUnitName, subject.ou.as_ref()),
        (DnType::CountryName, subject.c.as_ref()),
        (DnType::StateOrProvinceName, subject.st.as_ref()),
        (DnType::LocalityName, subject.l.as_ref()),
    ] {
        if let Some(value) = value {
            if value.trim().is_empty() || value.contains(['\0', '\n']) {
                return Err(PkiError::InvalidName);
            }
            name.push(kind, DnValue::Utf8String(value.clone()));
        }
    }
    if let Some(component) = subject.dc.first() {
        if component.trim().is_empty() || component.contains(['\0', '\n']) {
            return Err(PkiError::InvalidName);
        }
        name.push(
            DnType::CustomDnType(DC_OID.to_vec()),
            DnValue::Ia5String(
                Ia5String::try_from(component.clone()).map_err(|_| PkiError::InvalidName)?,
            ),
        );
    }
    params.distinguished_name = name;
    Ok(())
}

/// Converts one [`SanEntry`] into the builder's subject alternative name.
///
/// # Errors
/// Returns [`PkiError::InvalidName`] when the value is empty or cannot be
/// encoded as an IA5 string.
pub(crate) fn san_to_rcgen(entry: &SanEntry) -> Result<SanType, PkiError> {
    let ia5 = |value: &String| -> Result<Ia5String, PkiError> {
        if value.trim().is_empty() || value.contains(['\0', '\n']) {
            return Err(PkiError::InvalidName);
        }
        Ia5String::try_from(value.clone()).map_err(|_| PkiError::InvalidName)
    };
    Ok(match entry {
        SanEntry::Dns(value) => SanType::DnsName(ia5(value)?),
        SanEntry::Email(value) => SanType::Rfc822Name(ia5(value)?),
        SanEntry::Uri(value) => SanType::URI(ia5(value)?),
        SanEntry::Ip(address) => SanType::IpAddress(*address),
        SanEntry::Upn(value) => {
            if value.trim().is_empty() || value.contains(['\0', '\n']) {
                return Err(PkiError::InvalidName);
            }
            SanType::OtherName((
                x509::UPN_OID.to_vec(),
                OtherNameValue::Utf8String(value.clone()),
            ))
        }
    })
}

/// Maps a domain key usage onto the builder's enum.
pub(crate) const fn key_usage_to_rcgen(usage: KeyUsage) -> KeyUsagePurpose {
    match usage {
        KeyUsage::DigitalSignature => KeyUsagePurpose::DigitalSignature,
        KeyUsage::NonRepudiation => KeyUsagePurpose::ContentCommitment,
        KeyUsage::KeyEncipherment => KeyUsagePurpose::KeyEncipherment,
        KeyUsage::DataEncipherment => KeyUsagePurpose::DataEncipherment,
        KeyUsage::KeyAgreement => KeyUsagePurpose::KeyAgreement,
        KeyUsage::KeyCertSign => KeyUsagePurpose::KeyCertSign,
        KeyUsage::CrlSign => KeyUsagePurpose::CrlSign,
        KeyUsage::EncipherOnly => KeyUsagePurpose::EncipherOnly,
        KeyUsage::DecipherOnly => KeyUsagePurpose::DecipherOnly,
    }
}

/// Maps a domain extended key usage onto the builder's enum.
pub(crate) fn ext_key_usage_to_rcgen(usage: ExtendedKeyUsage) -> ExtendedKeyUsagePurpose {
    match usage {
        ExtendedKeyUsage::ServerAuth => ExtendedKeyUsagePurpose::ServerAuth,
        ExtendedKeyUsage::ClientAuth => ExtendedKeyUsagePurpose::ClientAuth,
        ExtendedKeyUsage::CodeSigning => ExtendedKeyUsagePurpose::CodeSigning,
        ExtendedKeyUsage::EmailProtection => ExtendedKeyUsagePurpose::EmailProtection,
        ExtendedKeyUsage::OcspSigning => ExtendedKeyUsagePurpose::OcspSigning,
        ExtendedKeyUsage::TimeStamping => ExtendedKeyUsagePurpose::TimeStamping,
        ExtendedKeyUsage::Any => ExtendedKeyUsagePurpose::Any,
    }
}

/// Builds the RFC 5280 §4.2.2.1 authority information access extension with
/// one `id-ad-ocsp` access description per URL.
///
/// `rcgen` 0.13 has no first-class AIA builder — it models CRL distribution
/// points but not AIA — so the extension body is assembled here as DER:
///
/// ```text
/// AuthorityInfoAccessSyntax ::= SEQUENCE OF AccessDescription
/// AccessDescription ::= SEQUENCE { accessMethod OBJECT IDENTIFIER,
///                                  accessLocation GeneralName }
/// ```
///
/// with `accessLocation` written as the `uniformResourceIdentifier [6]`
/// choice. The extension is non-critical, as RFC 5280 §4.2.2.1 requires.
///
/// # Errors
/// Returns [`PkiError::TooLarge`] when more than
/// [`MAX_DISTRIBUTION_URLS`] URLs are supplied and
/// [`PkiError::InvalidName`] when a URL is empty or not ASCII.
pub(crate) fn authority_info_access(ocsp_urls: &[String]) -> Result<CustomExtension, PkiError> {
    if ocsp_urls.len() > MAX_DISTRIBUTION_URLS {
        return Err(PkiError::TooLarge);
    }
    let mut descriptions = Vec::new();
    for url in ocsp_urls {
        if url.trim().is_empty() || !url.is_ascii() {
            return Err(PkiError::InvalidName);
        }
        let mut body = x509::write_tlv(0x06, &ID_AD_OCSP_DER);
        body.extend_from_slice(&x509::write_tlv(0x86, url.as_bytes()));
        descriptions.extend_from_slice(&x509::write_tlv(0x30, &body));
    }
    let mut extension = CustomExtension::from_oid_content(&AIA_OID, x509::write_tlv(0x30, &descriptions));
    extension.set_criticality(false);
    Ok(extension)
}

/// Validates a CRL distribution point URL list.
///
/// # Errors
/// Returns [`PkiError::TooLarge`] when more than [`MAX_DISTRIBUTION_URLS`]
/// URLs are supplied and [`PkiError::InvalidName`] when one is empty or not
/// ASCII.
pub(crate) fn check_distribution_urls(urls: &[String]) -> Result<(), PkiError> {
    if urls.len() > MAX_DISTRIBUTION_URLS {
        return Err(PkiError::TooLarge);
    }
    if urls
        .iter()
        .any(|url| url.trim().is_empty() || !url.is_ascii())
    {
        return Err(PkiError::InvalidName);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_empty_subject_is_refused() {
        let mut params = CertificateParams::default();
        assert_eq!(
            apply_subject(&mut params, &SubjectDn::default()).unwrap_err(),
            PkiError::InvalidName
        );
    }

    #[test]
    fn a_multi_component_domain_component_subject_reports_the_builder_limit() {
        let mut params = CertificateParams::default();
        let subject = SubjectDn {
            cn: Some("x".into()),
            dc: vec!["example".into(), "com".into()],
            ..SubjectDn::default()
        };
        assert!(matches!(
            apply_subject(&mut params, &subject).unwrap_err(),
            PkiError::NotYetSupported(_)
        ));
    }

    #[test]
    fn injection_characters_in_subject_attributes_are_refused() {
        for subject in [
            SubjectDn::common_name("with\nnewline"),
            SubjectDn::common_name("with\u{0}null"),
            SubjectDn::common_name("   "),
        ] {
            let mut params = CertificateParams::default();
            assert_eq!(
                apply_subject(&mut params, &subject).unwrap_err(),
                PkiError::InvalidName
            );
        }
    }

    #[test]
    fn non_ascii_names_are_refused_where_ia5_is_required() {
        assert!(san_to_rcgen(&SanEntry::Dns("héllo.example.com".into())).is_err());
        assert!(san_to_rcgen(&SanEntry::Dns("ok.example.com".into())).is_ok());
        assert!(san_to_rcgen(&SanEntry::Upn(String::new())).is_err());
        assert!(san_to_rcgen(&SanEntry::Uri("https://example.com".into())).is_ok());
        assert!(san_to_rcgen(&SanEntry::Email("a@example.com".into())).is_ok());
        assert!(san_to_rcgen(&SanEntry::Ip("::1".parse().unwrap())).is_ok());
    }

    #[test]
    fn the_aia_extension_encodes_one_access_description_per_url() {
        let extension =
            authority_info_access(&["http://ocsp.example.com".into(), "http://o2.test".into()])
                .unwrap();
        assert!(!extension.criticality());
        assert_eq!(
            extension.oid_components().collect::<Vec<_>>(),
            AIA_OID.to_vec()
        );
        let (tag, body, rest) = x509::read_tlv(extension.content()).unwrap();
        assert_eq!(tag, 0x30);
        assert!(rest.is_empty());
        let (first_tag, first, remainder) = x509::read_tlv(body).unwrap();
        assert_eq!(first_tag, 0x30);
        let (oid_tag, oid, after_oid) = x509::read_tlv(first).unwrap();
        assert_eq!(oid_tag, 0x06);
        assert_eq!(oid, ID_AD_OCSP_DER);
        let (uri_tag, uri, _) = x509::read_tlv(after_oid).unwrap();
        assert_eq!(uri_tag, 0x86);
        assert_eq!(uri, b"http://ocsp.example.com");
        assert!(!remainder.is_empty());
    }

    #[test]
    fn distribution_url_lists_are_bounded_and_ascii_only() {
        assert!(check_distribution_urls(&["http://crl.example.com".into()]).is_ok());
        assert_eq!(
            check_distribution_urls(&["http://é.example.com".into()]).unwrap_err(),
            PkiError::InvalidName
        );
        let many: Vec<String> = (0..MAX_DISTRIBUTION_URLS + 1)
            .map(|index| format!("http://crl{index}.example.com"))
            .collect();
        assert_eq!(
            check_distribution_urls(&many).unwrap_err(),
            PkiError::TooLarge
        );
        assert_eq!(
            authority_info_access(&many).unwrap_err(),
            PkiError::TooLarge
        );
    }

    #[test]
    fn usage_mappings_cover_every_variant() {
        for usage in KeyUsage::ALL {
            let _ = key_usage_to_rcgen(*usage);
        }
        for usage in ExtendedKeyUsage::ALL {
            let _ = ext_key_usage_to_rcgen(*usage);
        }
    }
}
