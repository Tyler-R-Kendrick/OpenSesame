//! Certificate revocation: CRL v2 (RFC 5280 §5) and OCSP (RFC 6960)
//! (ADR 0067 revocation).
//!
//! CRLs are built with the certificate builder's own CRL support and parsed
//! back with a bounded X.509 parser, so a distribution endpoint can round-trip
//! what it stores. OCSP has no first-class support in either crate, so the
//! request parser and the signed `BasicOCSPResponse` are assembled here from
//! `der` primitives — a real, signature-verifiable response, not a stub.
//!
//! Secrecy invariant: everything this module produces is published to
//! unauthenticated relying parties. It borrows a key only to sign, through
//! [`crate::signer::Signer`], and no type here carries private material.

use der::asn1::{BitString, GeneralizedTime, Int, ObjectIdentifier, OctetString};
use der::{Any, Decode as _, Encode as _, Enumerated, Sequence, Tag, TagNumber, Tagged as _};
use rcgen::{
    CertificateParams, CertificateRevocationListParams, RevocationReason, RevokedCertParams,
    SerialNumber,
};
use serde::{Deserialize, Serialize};
use spki::AlgorithmIdentifierOwned;
use time::OffsetDateTime;
use x509_parser::prelude::{parse_x509_certificate, parse_x509_crl};

use crate::error::PkiError;
use crate::keys::KeyPair;
use crate::signer::{self, SealedKeySigner, Signer as _};
use crate::types::SignatureAlgorithm;
use crate::x509;

/// Hard cap on a CRL or OCSP message this engine will parse.
const MAX_REVOCATION_BYTES: usize = 4 * 1024 * 1024;

/// Hard cap on entries in one generated CRL.
const MAX_REVOKED_ENTRIES: usize = 100_000;

/// `id-pkix-ocsp-basic`, the only OCSP response type this engine produces.
const ID_PKIX_OCSP_BASIC: ObjectIdentifier = ObjectIdentifier::new_unwrap("1.3.6.1.5.5.7.48.1.1");

/// One revoked certificate, as stored in `certificate_revocations`.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct RevokedEntry {
    /// The revoked certificate's serial, canonical lowercase hex.
    pub serial_hex: String,
    /// When the authority processed the revocation.
    #[serde(with = "time::serde::rfc3339")]
    pub revoked_at: OffsetDateTime,
    /// RFC 5280 §5.3.1 `CRLReason` code.
    pub reason_code: u8,
}

/// What [`parse_crl`] read back out of a CRL.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct CrlFacts {
    /// The monotonic `cRLNumber` extension value.
    pub crl_number: u64,
    /// `thisUpdate`.
    #[serde(with = "time::serde::rfc3339")]
    pub this_update: OffsetDateTime,
    /// `nextUpdate`, when present.
    #[serde(with = "time::serde::rfc3339::option")]
    pub next_update: Option<OffsetDateTime>,
    /// Revoked serials, canonical lowercase hex, in list order.
    pub serials: Vec<String>,
}

/// Builds a signed RFC 5280 CRL v2 over `entries`.
///
/// # Errors
/// Returns [`PkiError::TooLarge`] when more than 100 000 entries are supplied,
/// [`PkiError::InvalidValidity`] when `next_update` is not after
/// `this_update`, [`PkiError::NotACertificateAuthority`] or
/// [`PkiError::KeyMismatch`] when the issuer cannot sign, and
/// [`PkiError::CrlBuild`] when the list cannot be encoded.
pub fn build_crl(
    issuer_cert_pem: &str,
    issuer_key: &KeyPair,
    entries: &[RevokedEntry],
    crl_number: u64,
    this_update: OffsetDateTime,
    next_update: OffsetDateTime,
) -> Result<Vec<u8>, PkiError> {
    if entries.len() > MAX_REVOKED_ENTRIES {
        return Err(PkiError::TooLarge);
    }
    if next_update <= this_update {
        return Err(PkiError::InvalidValidity);
    }
    crate::ca::validate_ca(issuer_cert_pem, Some(issuer_key))?;

    let revoked_certs = entries
        .iter()
        .map(|entry| {
            let serial = hex::decode(&entry.serial_hex).map_err(|_| PkiError::CrlBuild)?;
            if serial.is_empty() {
                return Err(PkiError::CrlBuild);
            }
            Ok(RevokedCertParams {
                serial_number: SerialNumber::from_slice(&serial),
                revocation_time: entry.revoked_at,
                reason_code: Some(revocation_reason(entry.reason_code)?),
                invalidity_date: None,
            })
        })
        .collect::<Result<Vec<_>, PkiError>>()?;

    let issuer_params =
        CertificateParams::from_ca_cert_pem(issuer_cert_pem).map_err(|_| PkiError::InvalidPem)?;
    let key_identifier_method = issuer_params.key_identifier_method.clone();
    let issuer = issuer_params
        .self_signed(issuer_key.rcgen())
        .map_err(|_| PkiError::CrlBuild)?;

    let params = CertificateRevocationListParams {
        this_update,
        next_update,
        crl_number: SerialNumber::from_slice(&crl_number.to_be_bytes()),
        issuing_distribution_point: None,
        revoked_certs,
        key_identifier_method,
    };
    let crl = params
        .signed_by(&issuer, issuer_key.rcgen())
        .map_err(|_| PkiError::CrlBuild)?;
    Ok(crl.der().to_vec())
}

/// Maps an RFC 5280 `CRLReason` code onto the builder's enum.
///
/// # Errors
/// Returns [`PkiError::CrlBuild`] for code 7, which RFC 5280 leaves
/// unassigned, and for anything above 10.
fn revocation_reason(code: u8) -> Result<RevocationReason, PkiError> {
    Ok(match code {
        0 => RevocationReason::Unspecified,
        1 => RevocationReason::KeyCompromise,
        2 => RevocationReason::CaCompromise,
        3 => RevocationReason::AffiliationChanged,
        4 => RevocationReason::Superseded,
        5 => RevocationReason::CessationOfOperation,
        6 => RevocationReason::CertificateHold,
        8 => RevocationReason::RemoveFromCrl,
        9 => RevocationReason::PrivilegeWithdrawn,
        10 => RevocationReason::AaCompromise,
        _ => return Err(PkiError::CrlBuild),
    })
}

/// Wraps CRL DER in a PEM `X509 CRL` document.
pub fn crl_to_pem(der: &[u8]) -> String {
    x509::pem_encode(x509::LABEL_CRL, der)
}

/// Parses a CRL, reporting its number, window and revoked serials.
///
/// # Errors
/// Returns [`PkiError::TooLarge`] for an oversized document and
/// [`PkiError::CrlParse`] when the DER is malformed or carries no `cRLNumber`.
pub fn parse_crl(der: &[u8]) -> Result<CrlFacts, PkiError> {
    if der.len() > MAX_REVOCATION_BYTES {
        return Err(PkiError::TooLarge);
    }
    let (rest, crl) = parse_x509_crl(der).map_err(|_| PkiError::CrlParse)?;
    if !rest.is_empty() {
        return Err(PkiError::CrlParse);
    }
    let crl_number = crl
        .crl_number()
        .ok_or(PkiError::CrlParse)
        .and_then(|number| {
            let bytes = number.to_bytes_be();
            if bytes.len() > 8 {
                return Err(PkiError::CrlParse);
            }
            let mut buffer = [0u8; 8];
            buffer[8 - bytes.len()..].copy_from_slice(&bytes);
            Ok(u64::from_be_bytes(buffer))
        })?;
    let this_update = OffsetDateTime::from_unix_timestamp(crl.last_update().timestamp())
        .map_err(|_| PkiError::CrlParse)?;
    let next_update = crl
        .next_update()
        .map(|value| OffsetDateTime::from_unix_timestamp(value.timestamp()))
        .transpose()
        .map_err(|_| PkiError::CrlParse)?;
    let serials = crl
        .iter_revoked_certificates()
        .map(|revoked| x509::serial_hex(revoked.raw_serial()))
        .collect();
    Ok(CrlFacts {
        crl_number,
        this_update,
        next_update,
        serials,
    })
}

/// Verifies a CRL's signature against the issuer certificate that should have
/// produced it.
///
/// # Errors
/// Returns [`PkiError::TooLarge`], [`PkiError::CrlParse`] or
/// [`PkiError::InvalidPem`] for unusable input, and
/// [`PkiError::SignatureInvalid`] when the signature does not verify.
pub fn verify_crl(der: &[u8], issuer_cert_pem: &str) -> Result<(), PkiError> {
    if der.len() > MAX_REVOCATION_BYTES {
        return Err(PkiError::TooLarge);
    }
    let blocks = x509::parse_pem_blocks(issuer_cert_pem, x509::LABEL_CERTIFICATE, 1)?;
    let issuer_der = blocks.first().ok_or(PkiError::InvalidPem)?;
    let (_, issuer) = parse_x509_certificate(issuer_der).map_err(|_| PkiError::InvalidDer)?;
    let (_, crl) = parse_x509_crl(der).map_err(|_| PkiError::CrlParse)?;
    crl.verify_signature(issuer.public_key())
        .map_err(|_| PkiError::SignatureInvalid)
}

// ---------------------------------------------------------------------------
// OCSP (RFC 6960)
// ---------------------------------------------------------------------------

/// `CertID ::= SEQUENCE { hashAlgorithm, issuerNameHash, issuerKeyHash,
/// serialNumber }`.
#[derive(Clone, Debug, Eq, PartialEq, Sequence)]
struct CertId {
    hash_algorithm: AlgorithmIdentifierOwned,
    issuer_name_hash: OctetString,
    issuer_key_hash: OctetString,
    serial_number: Int,
}

/// `Request ::= SEQUENCE { reqCert CertID, singleRequestExtensions [0] }`.
#[derive(Clone, Debug, Eq, PartialEq, Sequence)]
struct SingleRequest {
    req_cert: CertId,
    #[asn1(context_specific = "0", tag_mode = "EXPLICIT", optional = "true")]
    single_request_extensions: Option<Any>,
}

/// `TBSRequest ::= SEQUENCE { version [0], requestorName [1], requestList,
/// requestExtensions [2] }`.
#[derive(Clone, Debug, Eq, PartialEq, Sequence)]
struct TbsRequest {
    #[asn1(context_specific = "0", tag_mode = "EXPLICIT", optional = "true")]
    version: Option<u8>,
    #[asn1(context_specific = "1", tag_mode = "EXPLICIT", optional = "true")]
    requestor_name: Option<Any>,
    request_list: Vec<SingleRequest>,
    #[asn1(context_specific = "2", tag_mode = "EXPLICIT", optional = "true")]
    request_extensions: Option<Any>,
}

/// `OCSPRequest ::= SEQUENCE { tbsRequest, optionalSignature [0] }`.
#[derive(Clone, Debug, Eq, PartialEq, Sequence)]
struct OcspRequestDer {
    tbs_request: TbsRequest,
    #[asn1(context_specific = "0", tag_mode = "EXPLICIT", optional = "true")]
    optional_signature: Option<Any>,
}

/// `SingleResponse ::= SEQUENCE { certID, certStatus, thisUpdate,
/// nextUpdate [0], singleExtensions [1] }`.
#[derive(Clone, Debug, Eq, PartialEq, Sequence)]
struct SingleResponse {
    cert_id: CertId,
    cert_status: Any,
    this_update: GeneralizedTime,
    #[asn1(context_specific = "0", tag_mode = "EXPLICIT", optional = "true")]
    next_update: Option<GeneralizedTime>,
    #[asn1(context_specific = "1", tag_mode = "EXPLICIT", optional = "true")]
    single_extensions: Option<Any>,
}

/// `ResponseData ::= SEQUENCE { version [0], responderID, producedAt,
/// responses, responseExtensions [1] }`.
#[derive(Clone, Debug, Eq, PartialEq, Sequence)]
struct ResponseData {
    #[asn1(context_specific = "0", tag_mode = "EXPLICIT", optional = "true")]
    version: Option<u8>,
    responder_id: Any,
    produced_at: GeneralizedTime,
    responses: Vec<SingleResponse>,
    #[asn1(context_specific = "1", tag_mode = "EXPLICIT", optional = "true")]
    response_extensions: Option<Any>,
}

/// `BasicOCSPResponse ::= SEQUENCE { tbsResponseData, signatureAlgorithm,
/// signature, certs [0] }`.
#[derive(Clone, Debug, Eq, PartialEq, Sequence)]
struct BasicOcspResponse {
    tbs_response_data: ResponseData,
    signature_algorithm: AlgorithmIdentifierOwned,
    signature: BitString,
    #[asn1(context_specific = "0", tag_mode = "EXPLICIT", optional = "true")]
    certs: Option<Vec<x509_cert::Certificate>>,
}

/// `ResponseBytes ::= SEQUENCE { responseType, response }`.
#[derive(Clone, Debug, Eq, PartialEq, Sequence)]
struct ResponseBytes {
    response_type: ObjectIdentifier,
    response: OctetString,
}

/// `OCSPResponseStatus ::= ENUMERATED`.
#[derive(Clone, Copy, Debug, Enumerated, Eq, PartialEq)]
#[asn1(type = "ENUMERATED")]
#[repr(u8)]
enum ResponseStatus {
    /// The request was answered.
    Successful = 0,
    /// The request could not be parsed.
    MalformedRequest = 1,
    /// The responder failed internally.
    InternalError = 2,
}

/// `OCSPResponse ::= SEQUENCE { responseStatus, responseBytes [0] }`.
#[derive(Clone, Debug, Eq, PartialEq, Sequence)]
struct OcspResponseDer {
    response_status: ResponseStatus,
    #[asn1(context_specific = "0", tag_mode = "EXPLICIT", optional = "true")]
    response_bytes: Option<ResponseBytes>,
}

/// What [`parse_ocsp_request`] read out of an OCSP request.
///
/// A responder answers with the *same* `CertID` it was asked about, so the
/// issuer hashes are carried verbatim rather than recomputed.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct OcspRequestFacts {
    /// The queried certificate's serial, canonical lowercase hex.
    pub serial_hex: String,
    /// `issuerNameHash`, the digest of the issuer's DER-encoded subject.
    pub issuer_name_hash: Vec<u8>,
    /// `issuerKeyHash`, the digest of the issuer's public key bit string.
    pub issuer_key_hash: Vec<u8>,
    /// Dotted OID of the digest algorithm the two hashes were produced with.
    /// A response echoes this algorithm with `NULL` parameters.
    pub hash_algorithm_oid: String,
}

/// The revocation status a responder asserts for one certificate.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OcspCertStatus {
    /// The certificate is not revoked.
    Good,
    /// The certificate is revoked.
    Revoked {
        /// When the authority processed the revocation.
        #[serde(with = "time::serde::rfc3339")]
        at: OffsetDateTime,
        /// RFC 5280 §5.3.1 `CRLReason` code.
        reason: u8,
    },
    /// The responder does not know about this certificate.
    Unknown,
}

/// What [`parse_ocsp_response`] read out of a signed OCSP response.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OcspResponseFacts {
    /// The queried certificate's serial, canonical lowercase hex.
    pub serial_hex: String,
    /// The asserted status.
    pub cert_status: OcspCertStatus,
    /// `producedAt`.
    pub produced_at: OffsetDateTime,
    /// `thisUpdate`.
    pub this_update: OffsetDateTime,
    /// `nextUpdate`, when present.
    pub next_update: Option<OffsetDateTime>,
    /// The algorithm the response was signed with.
    pub signature_algorithm: SignatureAlgorithm,
    /// The exact `ResponseData` bytes the signature covers.
    pub tbs_der: Vec<u8>,
    /// The signature value.
    pub signature: Vec<u8>,
}

/// Parses a DER OCSP request, reporting the single certificate it asks about.
///
/// Bounded and total: an oversized message, a malformed one, or one carrying
/// anything other than exactly one `Request` is rejected rather than expanded.
///
/// # Errors
/// Returns [`PkiError::TooLarge`] for an oversized message and
/// [`PkiError::OcspParse`] when the DER is malformed, carries trailing bytes,
/// or does not contain exactly one request.
pub fn parse_ocsp_request(der: &[u8]) -> Result<OcspRequestFacts, PkiError> {
    if der.len() > MAX_REVOCATION_BYTES {
        return Err(PkiError::TooLarge);
    }
    let request = OcspRequestDer::from_der(der).map_err(|_| PkiError::OcspParse)?;
    let [single] = request.tbs_request.request_list.as_slice() else {
        return Err(PkiError::OcspParse);
    };
    let cert_id = &single.req_cert;
    Ok(OcspRequestFacts {
        serial_hex: x509::serial_hex(cert_id.serial_number.as_bytes()),
        issuer_name_hash: cert_id.issuer_name_hash.as_bytes().to_vec(),
        issuer_key_hash: cert_id.issuer_key_hash.as_bytes().to_vec(),
        hash_algorithm_oid: cert_id.hash_algorithm.oid.to_string(),
    })
}

/// Builds a DER OCSP request for one certificate, for round-trip testing and
/// for the discovery scanner's status probes.
///
/// # Errors
/// Returns [`PkiError::OcspBuild`] when the facts cannot be encoded.
pub fn build_ocsp_request(facts: &OcspRequestFacts) -> Result<Vec<u8>, PkiError> {
    let request = OcspRequestDer {
        tbs_request: TbsRequest {
            version: None,
            requestor_name: None,
            request_list: vec![SingleRequest {
                req_cert: cert_id(facts)?,
                single_request_extensions: None,
            }],
            request_extensions: None,
        },
        optional_signature: None,
    };
    request.to_der().map_err(|_| PkiError::OcspBuild)
}

/// Rebuilds the `CertID` a response must echo back.
fn cert_id(facts: &OcspRequestFacts) -> Result<CertId, PkiError> {
    let oid: ObjectIdentifier = facts
        .hash_algorithm_oid
        .parse()
        .map_err(|_| PkiError::OcspBuild)?;
    let serial = hex::decode(&facts.serial_hex).map_err(|_| PkiError::OcspBuild)?;
    if serial.is_empty() {
        return Err(PkiError::OcspBuild);
    }
    Ok(CertId {
        hash_algorithm: AlgorithmIdentifierOwned {
            oid,
            parameters: Some(Any::null()),
        },
        issuer_name_hash: OctetString::new(facts.issuer_name_hash.clone())
            .map_err(|_| PkiError::OcspBuild)?,
        issuer_key_hash: OctetString::new(facts.issuer_key_hash.clone())
            .map_err(|_| PkiError::OcspBuild)?,
        serial_number: Int::new(&serial).map_err(|_| PkiError::OcspBuild)?,
    })
}

/// Builds a signed `BasicOCSPResponse` asserting `status` for the certificate
/// `req` asked about.
///
/// The responder is identified `byName` with the issuer's subject when
/// `responder_key` is the issuer's own key, and `byKey` — the SHA-1-sized
/// digest carried in the request's `issuerKeyHash` — otherwise, which is the
/// delegated-responder shape of RFC 6960 §4.2.2.2. The issuer certificate is
/// always included in `certs` so a relying party can chain the response.
///
/// # Errors
/// Returns [`PkiError::InvalidPem`] or [`PkiError::InvalidDer`] for an
/// unusable issuer certificate, [`PkiError::OcspBuild`] when the response
/// cannot be encoded, and [`PkiError::Signing`] when the responder key refuses
/// to sign.
pub fn build_ocsp_response(
    issuer_cert_pem: &str,
    responder_key: &KeyPair,
    status: OcspCertStatus,
    req: &OcspRequestFacts,
    produced_at: OffsetDateTime,
    next_update: OffsetDateTime,
) -> Result<Vec<u8>, PkiError> {
    let blocks = x509::parse_pem_blocks(issuer_cert_pem, x509::LABEL_CERTIFICATE, 1)?;
    let issuer_der = blocks.first().ok_or(PkiError::InvalidPem)?;
    let issuer = x509_cert::Certificate::from_der(issuer_der).map_err(|_| PkiError::InvalidDer)?;

    let issuer_public_key = issuer
        .tbs_certificate
        .subject_public_key_info
        .to_der()
        .map_err(|_| PkiError::InvalidDer)?;
    let responder_id = if issuer_public_key == responder_key.public_key_der() {
        let subject = issuer
            .tbs_certificate
            .subject
            .to_der()
            .map_err(|_| PkiError::InvalidDer)?;
        Any::new(
            Tag::ContextSpecific {
                constructed: true,
                number: TagNumber::N1,
            },
            subject,
        )
        .map_err(|_| PkiError::OcspBuild)?
    } else {
        let key_hash = OctetString::new(req.issuer_key_hash.clone())
            .map_err(|_| PkiError::OcspBuild)?
            .to_der()
            .map_err(|_| PkiError::OcspBuild)?;
        Any::new(
            Tag::ContextSpecific {
                constructed: true,
                number: TagNumber::N2,
            },
            key_hash,
        )
        .map_err(|_| PkiError::OcspBuild)?
    };

    let response_data = ResponseData {
        version: None,
        responder_id,
        produced_at: generalized(produced_at)?,
        responses: vec![SingleResponse {
            cert_id: cert_id(req)?,
            cert_status: encode_cert_status(status)?,
            this_update: generalized(produced_at)?,
            next_update: Some(generalized(next_update)?),
            single_extensions: None,
        }],
        response_extensions: None,
    };

    let tbs = response_data.to_der().map_err(|_| PkiError::OcspBuild)?;
    let signer = SealedKeySigner::new(responder_key)?;
    let signature = signer.sign(&tbs)?;

    let basic = BasicOcspResponse {
        tbs_response_data: response_data,
        signature_algorithm: signature_algorithm_identifier(signer.algorithm())?,
        signature: BitString::from_bytes(&signature).map_err(|_| PkiError::OcspBuild)?,
        certs: Some(vec![issuer]),
    };
    let basic_der = basic.to_der().map_err(|_| PkiError::OcspBuild)?;

    OcspResponseDer {
        response_status: ResponseStatus::Successful,
        response_bytes: Some(ResponseBytes {
            response_type: ID_PKIX_OCSP_BASIC,
            response: OctetString::new(basic_der).map_err(|_| PkiError::OcspBuild)?,
        }),
    }
    .to_der()
    .map_err(|_| PkiError::OcspBuild)
}

/// Parses a signed OCSP response, reporting the status it asserts and the
/// bytes its signature covers.
///
/// # Errors
/// Returns [`PkiError::TooLarge`] for an oversized message and
/// [`PkiError::OcspParse`] when the DER is malformed, is not a successful
/// basic response, or does not carry exactly one `SingleResponse`.
pub fn parse_ocsp_response(der: &[u8]) -> Result<OcspResponseFacts, PkiError> {
    if der.len() > MAX_REVOCATION_BYTES {
        return Err(PkiError::TooLarge);
    }
    let response = OcspResponseDer::from_der(der).map_err(|_| PkiError::OcspParse)?;
    if response.response_status != ResponseStatus::Successful {
        return Err(PkiError::OcspParse);
    }
    let bytes = response.response_bytes.ok_or(PkiError::OcspParse)?;
    if bytes.response_type != ID_PKIX_OCSP_BASIC {
        return Err(PkiError::OcspParse);
    }
    let basic =
        BasicOcspResponse::from_der(bytes.response.as_bytes()).map_err(|_| PkiError::OcspParse)?;
    let [single] = basic.tbs_response_data.responses.as_slice() else {
        return Err(PkiError::OcspParse);
    };
    Ok(OcspResponseFacts {
        serial_hex: x509::serial_hex(single.cert_id.serial_number.as_bytes()),
        cert_status: decode_cert_status(&single.cert_status)?,
        produced_at: from_generalized(&basic.tbs_response_data.produced_at)?,
        this_update: from_generalized(&single.this_update)?,
        next_update: single
            .next_update
            .as_ref()
            .map(from_generalized)
            .transpose()?,
        signature_algorithm: signature_algorithm_from_oid(&basic.signature_algorithm.oid)?,
        tbs_der: basic
            .tbs_response_data
            .to_der()
            .map_err(|_| PkiError::OcspParse)?,
        signature: basic
            .signature
            .as_bytes()
            .ok_or(PkiError::OcspParse)?
            .to_vec(),
    })
}

/// Parses a signed OCSP response and verifies its signature against the
/// responder's `SubjectPublicKeyInfo`.
///
/// # Errors
/// As [`parse_ocsp_response`], plus [`PkiError::SignatureInvalid`] when the
/// signature does not verify.
pub fn verify_ocsp_response(
    der: &[u8],
    responder_public_key_der: &[u8],
) -> Result<OcspResponseFacts, PkiError> {
    let facts = parse_ocsp_response(der)?;
    signer::verify(
        facts.signature_algorithm,
        responder_public_key_der,
        &facts.tbs_der,
        &facts.signature,
    )?;
    Ok(facts)
}

/// Decides the status a responder must assert for `serial_hex`, given the
/// serials this authority has issued and the ones it has revoked.
///
/// A serial the authority never issued is [`OcspCertStatus::Unknown`], never
/// [`OcspCertStatus::Good`]. A responder that answered `Good` for an unissued
/// serial would vouch for a certificate its CA never signed, turning the
/// revocation service into a forgery oracle (ADR 0067). Encoding the rule here
/// rather than in each route is what keeps every responder path honest.
pub fn status_for(serial_hex: &str, issued: &[String], revoked: &[RevokedEntry]) -> OcspCertStatus {
    if let Some(entry) = revoked
        .iter()
        .find(|entry| entry.serial_hex.eq_ignore_ascii_case(serial_hex))
    {
        return OcspCertStatus::Revoked {
            at: entry.revoked_at,
            reason: entry.reason_code,
        };
    }
    if issued
        .iter()
        .any(|candidate| candidate.eq_ignore_ascii_case(serial_hex))
    {
        OcspCertStatus::Good
    } else {
        OcspCertStatus::Unknown
    }
}

/// Encodes `CertStatus`, an implicitly tagged CHOICE.
fn encode_cert_status(status: OcspCertStatus) -> Result<Any, PkiError> {
    match status {
        OcspCertStatus::Good => Any::new(
            Tag::ContextSpecific {
                constructed: false,
                number: TagNumber::N0,
            },
            Vec::new(),
        )
        .map_err(|_| PkiError::OcspBuild),
        OcspCertStatus::Unknown => Any::new(
            Tag::ContextSpecific {
                constructed: false,
                number: TagNumber::N2,
            },
            Vec::new(),
        )
        .map_err(|_| PkiError::OcspBuild),
        OcspCertStatus::Revoked { at, reason } => {
            // RevokedInfo ::= SEQUENCE { revocationTime GeneralizedTime,
            //                            revocationReason [0] EXPLICIT CRLReason OPTIONAL }
            // written out by hand so the [1] IMPLICIT tag can wrap the
            // sequence *body* without a second encode pass.
            let mut body = generalized(at)?.to_der().map_err(|_| PkiError::OcspBuild)?;
            body.extend_from_slice(&x509::write_tlv(0xA0, &x509::write_tlv(0x0A, &[reason])));
            Any::new(
                Tag::ContextSpecific {
                    constructed: true,
                    number: TagNumber::N1,
                },
                body,
            )
            .map_err(|_| PkiError::OcspBuild)
        }
    }
}

/// Decodes `CertStatus`.
fn decode_cert_status(status: &Any) -> Result<OcspCertStatus, PkiError> {
    match status.tag() {
        Tag::ContextSpecific {
            number: TagNumber::N0,
            ..
        } => Ok(OcspCertStatus::Good),
        Tag::ContextSpecific {
            number: TagNumber::N2,
            ..
        } => Ok(OcspCertStatus::Unknown),
        Tag::ContextSpecific {
            number: TagNumber::N1,
            ..
        } => {
            let body = status.value();
            let (time_tag, time_value, rest) = x509::read_tlv(body).ok_or(PkiError::OcspParse)?;
            if time_tag != 0x18 {
                return Err(PkiError::OcspParse);
            }
            let time = GeneralizedTime::from_der(&x509::write_tlv(0x18, time_value))
                .map_err(|_| PkiError::OcspParse)?;
            let reason = match x509::read_tlv(rest) {
                Some((0xA0, inner, _)) => match x509::read_tlv(inner) {
                    Some((0x0A, [code], _)) => *code,
                    _ => return Err(PkiError::OcspParse),
                },
                None => 0,
                Some(_) => return Err(PkiError::OcspParse),
            };
            Ok(OcspCertStatus::Revoked {
                at: from_generalized(&time)?,
                reason,
            })
        }
        _ => Err(PkiError::OcspParse),
    }
}

/// The `AlgorithmIdentifier` for a signature algorithm, with `NULL`
/// parameters where RFC 4055 requires them and absent parameters otherwise.
fn signature_algorithm_identifier(
    algorithm: SignatureAlgorithm,
) -> Result<AlgorithmIdentifierOwned, PkiError> {
    let (oid, null_parameters) = match algorithm {
        SignatureAlgorithm::Sha256Rsa => ("1.2.840.113549.1.1.11", true),
        SignatureAlgorithm::Sha384Rsa => ("1.2.840.113549.1.1.12", true),
        SignatureAlgorithm::Sha512Rsa => ("1.2.840.113549.1.1.13", true),
        SignatureAlgorithm::Sha256Ecdsa => ("1.2.840.10045.4.3.2", false),
        SignatureAlgorithm::Sha384Ecdsa => ("1.2.840.10045.4.3.3", false),
        SignatureAlgorithm::Ed25519 => ("1.3.101.112", false),
    };
    Ok(AlgorithmIdentifierOwned {
        oid: oid.parse().map_err(|_| PkiError::OcspBuild)?,
        parameters: null_parameters.then(Any::null),
    })
}

/// Reverse of [`signature_algorithm_identifier`].
fn signature_algorithm_from_oid(oid: &ObjectIdentifier) -> Result<SignatureAlgorithm, PkiError> {
    match oid.to_string().as_str() {
        "1.2.840.113549.1.1.11" => Ok(SignatureAlgorithm::Sha256Rsa),
        "1.2.840.113549.1.1.12" => Ok(SignatureAlgorithm::Sha384Rsa),
        "1.2.840.113549.1.1.13" => Ok(SignatureAlgorithm::Sha512Rsa),
        "1.2.840.10045.4.3.2" => Ok(SignatureAlgorithm::Sha256Ecdsa),
        "1.2.840.10045.4.3.3" => Ok(SignatureAlgorithm::Sha384Ecdsa),
        "1.3.101.112" => Ok(SignatureAlgorithm::Ed25519),
        _ => Err(PkiError::UnsupportedAlgorithm),
    }
}

/// Converts a timestamp into DER `GeneralizedTime`, which has one-second
/// resolution.
fn generalized(value: OffsetDateTime) -> Result<GeneralizedTime, PkiError> {
    let seconds = u64::try_from(value.unix_timestamp()).map_err(|_| PkiError::OcspBuild)?;
    GeneralizedTime::from_unix_duration(std::time::Duration::from_secs(seconds))
        .map_err(|_| PkiError::OcspBuild)
}

/// Reverse of [`generalized`].
fn from_generalized(value: &GeneralizedTime) -> Result<OffsetDateTime, PkiError> {
    let seconds =
        i64::try_from(value.to_unix_duration().as_secs()).map_err(|_| PkiError::OcspParse)?;
    OffsetDateTime::from_unix_timestamp(seconds).map_err(|_| PkiError::OcspParse)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ca;
    use crate::keys;
    use crate::types::{KeyAlgorithm, SubjectDn};
    use time::Duration;

    pub(crate) fn root() -> ca::GeneratedCa {
        let now = OffsetDateTime::now_utc();
        ca::generate_root(&ca::CaParams {
            subject: SubjectDn::common_name("Revocation Test Root"),
            key_algorithm: KeyAlgorithm::EcdsaP256,
            not_before: now - Duration::minutes(1),
            not_after: now + Duration::days(365),
            path_len: None,
            crl_distribution_points: Vec::new(),
        })
        .unwrap()
    }

    pub(crate) fn entries() -> Vec<RevokedEntry> {
        let now = OffsetDateTime::now_utc().replace_nanosecond(0).unwrap();
        vec![
            RevokedEntry {
                serial_hex: "0102030405060708090a0b0c0d0e0f10".into(),
                revoked_at: now - Duration::hours(2),
                reason_code: 1,
            },
            RevokedEntry {
                serial_hex: "aabbccdd".into(),
                revoked_at: now - Duration::hours(1),
                reason_code: 4,
            },
        ]
    }

    pub(crate) fn request_facts() -> OcspRequestFacts {
        OcspRequestFacts {
            serial_hex: "0102030405060708090a0b0c0d0e0f10".into(),
            issuer_name_hash: vec![0x11; 20],
            issuer_key_hash: vec![0x22; 20],
            hash_algorithm_oid: "1.3.14.3.2.26".into(),
        }
    }

    #[test]
    fn a_crl_round_trips_its_number_window_and_serials() {
        let root = root();
        let now = OffsetDateTime::now_utc().replace_nanosecond(0).unwrap();
        let der = build_crl(
            &root.certificate_pem,
            &root.key,
            &entries(),
            42,
            now,
            now + Duration::days(7),
        )
        .unwrap();
        let facts = parse_crl(&der).unwrap();
        assert_eq!(facts.crl_number, 42);
        assert_eq!(facts.this_update, now);
        assert_eq!(facts.next_update, Some(now + Duration::days(7)));
        assert_eq!(
            facts.serials,
            ["0102030405060708090a0b0c0d0e0f10", "aabbccdd"]
        );
        verify_crl(&der, &root.certificate_pem).unwrap();
    }

    #[test]
    fn an_empty_crl_is_still_a_valid_signed_list() {
        let root = root();
        let now = OffsetDateTime::now_utc().replace_nanosecond(0).unwrap();
        let der = build_crl(
            &root.certificate_pem,
            &root.key,
            &[],
            1,
            now,
            now + Duration::days(1),
        )
        .unwrap();
        assert!(parse_crl(&der).unwrap().serials.is_empty());
        verify_crl(&der, &root.certificate_pem).unwrap();
        let pem = crl_to_pem(&der);
        assert!(pem.starts_with("-----BEGIN X509 CRL-----"));
        assert_eq!(
            x509::parse_pem_blocks(&pem, x509::LABEL_CRL, 1).unwrap()[0],
            der
        );
    }

    #[test]
    fn adversarial_a_tampered_crl_fails_verification() {
        let root = root();
        let now = OffsetDateTime::now_utc().replace_nanosecond(0).unwrap();
        let mut der = build_crl(
            &root.certificate_pem,
            &root.key,
            &entries(),
            7,
            now,
            now + Duration::days(1),
        )
        .unwrap();
        let position = der.len() / 4;
        der[position] ^= 0xff;
        assert!(verify_crl(&der, &root.certificate_pem).is_err());
    }

    #[test]
    fn adversarial_a_crl_from_another_authority_fails_verification() {
        let first = root();
        let second = root();
        let now = OffsetDateTime::now_utc().replace_nanosecond(0).unwrap();
        let der = build_crl(
            &first.certificate_pem,
            &first.key,
            &entries(),
            1,
            now,
            now + Duration::days(1),
        )
        .unwrap();
        assert_eq!(
            verify_crl(&der, &second.certificate_pem).unwrap_err(),
            PkiError::SignatureInvalid
        );
    }

    #[test]
    fn adversarial_crl_building_refuses_bad_windows_reasons_and_serials() {
        let root = root();
        let now = OffsetDateTime::now_utc().replace_nanosecond(0).unwrap();
        assert_eq!(
            build_crl(&root.certificate_pem, &root.key, &[], 1, now, now).unwrap_err(),
            PkiError::InvalidValidity
        );
        let bad_reason = vec![RevokedEntry {
            serial_hex: "01".into(),
            revoked_at: now,
            reason_code: 7,
        }];
        assert_eq!(
            build_crl(
                &root.certificate_pem,
                &root.key,
                &bad_reason,
                1,
                now,
                now + Duration::days(1)
            )
            .unwrap_err(),
            PkiError::CrlBuild
        );
        let bad_serial = vec![RevokedEntry {
            serial_hex: "zz".into(),
            revoked_at: now,
            reason_code: 0,
        }];
        assert_eq!(
            build_crl(
                &root.certificate_pem,
                &root.key,
                &bad_serial,
                1,
                now,
                now + Duration::days(1)
            )
            .unwrap_err(),
            PkiError::CrlBuild
        );
    }

    #[test]
    fn adversarial_hostile_crl_bytes_never_panic() {
        for hostile in [
            Vec::new(),
            vec![0x00],
            vec![0x30, 0x82, 0xff, 0xff],
            vec![0xffu8; 4096],
        ] {
            assert!(parse_crl(&hostile).is_err());
        }
        let huge = vec![0x41u8; MAX_REVOCATION_BYTES + 1];
        assert_eq!(parse_crl(&huge).unwrap_err(), PkiError::TooLarge);
    }

    #[test]
    fn an_ocsp_request_round_trips_through_der() {
        let der = build_ocsp_request(&request_facts()).unwrap();
        assert_eq!(parse_ocsp_request(&der).unwrap(), request_facts());
    }

    #[test]
    fn a_revoked_response_verifies_against_the_issuer_public_key() {
        let root = root();
        let now = OffsetDateTime::now_utc().replace_nanosecond(0).unwrap();
        let status = OcspCertStatus::Revoked {
            at: now - Duration::hours(3),
            reason: 1,
        };
        let der = build_ocsp_response(
            &root.certificate_pem,
            &root.key,
            status,
            &request_facts(),
            now,
            now + Duration::hours(24),
        )
        .unwrap();
        let facts = verify_ocsp_response(&der, &root.key.public_key_der()).unwrap();
        assert_eq!(facts.cert_status, status);
        assert_eq!(facts.serial_hex, request_facts().serial_hex);
        assert_eq!(facts.produced_at, now);
        assert_eq!(facts.next_update, Some(now + Duration::hours(24)));
        assert_eq!(facts.signature_algorithm, SignatureAlgorithm::Sha256Ecdsa);
    }

    #[test]
    fn good_and_unknown_responses_verify_too() {
        let root = root();
        let now = OffsetDateTime::now_utc().replace_nanosecond(0).unwrap();
        for status in [OcspCertStatus::Good, OcspCertStatus::Unknown] {
            let der = build_ocsp_response(
                &root.certificate_pem,
                &root.key,
                status,
                &request_facts(),
                now,
                now + Duration::hours(1),
            )
            .unwrap();
            let facts = verify_ocsp_response(&der, &root.key.public_key_der()).unwrap();
            assert_eq!(facts.cert_status, status);
        }
    }

    #[test]
    fn every_responder_key_algorithm_produces_a_verifiable_response() {
        let now = OffsetDateTime::now_utc().replace_nanosecond(0).unwrap();
        for algorithm in [
            KeyAlgorithm::EcdsaP256,
            KeyAlgorithm::EcdsaP384,
            KeyAlgorithm::Ed25519,
        ] {
            let root = ca::generate_root(&ca::CaParams {
                subject: SubjectDn::common_name("Responder Root"),
                key_algorithm: algorithm,
                not_before: now - Duration::minutes(1),
                not_after: now + Duration::days(365),
                path_len: None,
                crl_distribution_points: Vec::new(),
            })
            .unwrap();
            let der = build_ocsp_response(
                &root.certificate_pem,
                &root.key,
                OcspCertStatus::Good,
                &request_facts(),
                now,
                now + Duration::hours(1),
            )
            .unwrap();
            verify_ocsp_response(&der, &root.key.public_key_der()).unwrap();
        }
    }

    #[test]
    fn a_delegated_responder_signs_with_its_own_key() {
        let root = root();
        let now = OffsetDateTime::now_utc().replace_nanosecond(0).unwrap();
        let delegate = keys::generate(KeyAlgorithm::Ed25519).unwrap();
        let der = build_ocsp_response(
            &root.certificate_pem,
            &delegate,
            OcspCertStatus::Good,
            &request_facts(),
            now,
            now + Duration::hours(1),
        )
        .unwrap();
        verify_ocsp_response(&der, &delegate.public_key_der()).unwrap();
        assert_eq!(
            verify_ocsp_response(&der, &root.key.public_key_der()).unwrap_err(),
            PkiError::InvalidDer
        );
    }

    #[test]
    fn adversarial_a_tampered_response_fails_verification() {
        let root = root();
        let now = OffsetDateTime::now_utc().replace_nanosecond(0).unwrap();
        let mut der = build_ocsp_response(
            &root.certificate_pem,
            &root.key,
            OcspCertStatus::Good,
            &request_facts(),
            now,
            now + Duration::hours(1),
        )
        .unwrap();
        // Flip a byte of the queried serial, which lives inside the signed
        // `ResponseData` rather than in the trailing issuer certificate.
        let serial = hex::decode(request_facts().serial_hex).unwrap();
        let position = der
            .windows(serial.len())
            .position(|window| window == serial.as_slice())
            .unwrap();
        der[position] ^= 0xff;
        assert!(verify_ocsp_response(&der, &root.key.public_key_der()).is_err());
    }

    #[test]
    fn adversarial_hostile_ocsp_bytes_never_panic() {
        for hostile in [
            Vec::new(),
            vec![0x00],
            vec![0x30, 0x80, 0x00, 0x00],
            vec![0xffu8; 4096],
        ] {
            assert!(parse_ocsp_request(&hostile).is_err());
            assert!(parse_ocsp_response(&hostile).is_err());
        }
        let huge = vec![0x41u8; MAX_REVOCATION_BYTES + 1];
        assert_eq!(parse_ocsp_request(&huge).unwrap_err(), PkiError::TooLarge);
        assert_eq!(parse_ocsp_response(&huge).unwrap_err(), PkiError::TooLarge);
    }

    #[test]
    fn adversarial_a_request_asking_about_many_certificates_is_refused() {
        let request = OcspRequestDer {
            tbs_request: TbsRequest {
                version: None,
                requestor_name: None,
                request_list: vec![
                    SingleRequest {
                        req_cert: cert_id(&request_facts()).unwrap(),
                        single_request_extensions: None,
                    },
                    SingleRequest {
                        req_cert: cert_id(&request_facts()).unwrap(),
                        single_request_extensions: None,
                    },
                ],
                request_extensions: None,
            },
            optional_signature: None,
        };
        let der = request.to_der().unwrap();
        assert_eq!(parse_ocsp_request(&der).unwrap_err(), PkiError::OcspParse);
    }

    #[test]
    fn the_cert_status_choice_round_trips_every_variant() {
        let now = OffsetDateTime::now_utc().replace_nanosecond(0).unwrap();
        for status in [
            OcspCertStatus::Good,
            OcspCertStatus::Unknown,
            OcspCertStatus::Revoked { at: now, reason: 5 },
        ] {
            let encoded = encode_cert_status(status).unwrap();
            assert_eq!(decode_cert_status(&encoded).unwrap(), status);
        }
    }

    #[test]
    fn a_revoked_serial_appears_in_the_crl_and_ocsp_agrees_on_the_reason() {
        let root = root();
        let now = OffsetDateTime::now_utc().replace_nanosecond(0).unwrap();
        let revoked = entries();
        let der = build_crl(
            &root.certificate_pem,
            &root.key,
            &revoked,
            1,
            now,
            now + Duration::days(1),
        )
        .unwrap();
        let facts = parse_crl(&der).unwrap();
        assert!(facts.serials.contains(&revoked[0].serial_hex));

        let issued: Vec<String> = revoked
            .iter()
            .map(|entry| entry.serial_hex.clone())
            .collect();
        let status = status_for(&revoked[0].serial_hex, &issued, &revoked);
        let response = build_ocsp_response(
            &root.certificate_pem,
            &root.key,
            status,
            &request_facts(),
            now,
            now + Duration::hours(1),
        )
        .unwrap();
        let reported = verify_ocsp_response(&response, &root.key.public_key_der()).unwrap();
        assert_eq!(
            reported.cert_status,
            OcspCertStatus::Revoked {
                at: revoked[0].revoked_at,
                reason: revoked[0].reason_code,
            }
        );
    }

    #[test]
    fn adversarial_a_serial_the_authority_never_issued_is_unknown_not_good() {
        let revoked = entries();
        let issued = vec!["aabbccdd".to_owned()];
        assert_eq!(
            status_for("deadbeef", &issued, &[]),
            OcspCertStatus::Unknown
        );
        assert_eq!(status_for("aabbccdd", &issued, &[]), OcspCertStatus::Good);
        assert_eq!(status_for("AABBCCDD", &issued, &[]), OcspCertStatus::Good);
        // A revoked serial stays revoked even if the inventory has lost it.
        assert!(matches!(
            status_for("aabbccdd", &[], &revoked),
            OcspCertStatus::Revoked { .. }
        ));
        // An empty authority vouches for nothing.
        assert_eq!(status_for("01", &[], &[]), OcspCertStatus::Unknown);
    }

    #[test]
    fn the_crl_number_is_carried_through_and_never_reused_across_regenerations() {
        let root = root();
        let now = OffsetDateTime::now_utc().replace_nanosecond(0).unwrap();
        let mut seen = Vec::new();
        for number in [1u64, 2, 3, u64::from(u32::MAX) + 1] {
            let der = build_crl(
                &root.certificate_pem,
                &root.key,
                &entries(),
                number,
                now,
                now + Duration::days(1),
            )
            .unwrap();
            let facts = parse_crl(&der).unwrap();
            assert_eq!(facts.crl_number, number);
            assert!(!seen.contains(&facts.crl_number));
            seen.push(facts.crl_number);
        }
        assert!(seen.windows(2).all(|pair| pair[0] < pair[1]));
    }

    #[test]
    fn adversarial_a_megabyte_of_garbage_is_refused_by_both_parsers() {
        let garbage = vec![0x5au8; 1024 * 1024];
        assert!(parse_crl(&garbage).is_err());
        assert!(parse_ocsp_request(&garbage).is_err());
        assert!(parse_ocsp_response(&garbage).is_err());
    }

    #[test]
    fn signature_algorithm_identifiers_round_trip() {
        for algorithm in SignatureAlgorithm::ALL {
            let identifier = signature_algorithm_identifier(*algorithm).unwrap();
            assert_eq!(
                signature_algorithm_from_oid(&identifier.oid).unwrap(),
                *algorithm
            );
        }
    }
}

#[cfg(test)]
mod pact {
    //! The parsed shapes a CRL distribution endpoint and an OCSP responder
    //! hand to their route layers, pinned so a refactor cannot silently change
    //! what those endpoints publish.

    use super::tests::{entries, request_facts, root};
    use super::*;
    use time::{Duration, OffsetDateTime};

    /// A fixed instant, so the snapshot does not move with the clock.
    fn epoch() -> OffsetDateTime {
        OffsetDateTime::from_unix_timestamp(1_800_000_000).unwrap()
    }

    #[test]
    fn crl_facts_wire_shape_is_pinned() {
        let root = root();
        let mut fixed = entries();
        for (index, entry) in fixed.iter_mut().enumerate() {
            entry.revoked_at = epoch() - Duration::hours(i64::try_from(index).unwrap_or(0) + 1);
        }
        let der = build_crl(
            &root.certificate_pem,
            &root.key,
            &fixed,
            99,
            epoch(),
            epoch() + Duration::days(7),
        )
        .unwrap();
        insta::assert_json_snapshot!(parse_crl(&der).unwrap());
    }

    #[test]
    fn ocsp_request_facts_wire_shape_is_pinned() {
        let der = build_ocsp_request(&request_facts()).unwrap();
        insta::assert_json_snapshot!(parse_ocsp_request(&der).unwrap());
    }

    #[test]
    fn ocsp_cert_status_wire_shape_is_pinned() {
        insta::assert_json_snapshot!(vec![
            OcspCertStatus::Good,
            OcspCertStatus::Unknown,
            OcspCertStatus::Revoked {
                at: epoch(),
                reason: 1,
            },
        ]);
    }
}
