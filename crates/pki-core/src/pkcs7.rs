//! PKCS#7 `certs-only` encoding and strict decoding (RFC 2315 / RFC 5652
//! degenerate `SignedData`).
//!
//! EST (RFC 7030) moves certificate chains as `application/pkcs7-mime`
//! `certs-only` objects: a `SignedData` with **no** signers and no encapsulated
//! content — the certificates are the payload. This module builds exactly that
//! envelope and parses nothing else: [`parse_certs_only`] refuses any object
//! with a signature, content or CRL, so a hostile "PKCS#7" cannot smuggle
//! signed attributes past an EST client.
//!
//! The encoding is written directly against DER primitives (length-prefixed
//! sequences) rather than through a CMS builder: the schema is fixed and tiny,
//! every input is bounded, and the interop suite re-verifies the output with
//! the system `openssl pkcs7` as an independent oracle.
//!
//! Secrecy invariant: certificates are public material. Nothing here reads or
//! emits private-key bytes.

use crate::error::PkiError;

/// Largest certs-only object this module builds or parses.
pub const MAX_PKCS7_BYTES: usize = 256 * 1024;
/// Most certificates one certs-only object may carry.
pub const MAX_PKCS7_CERTS: usize = 16;

/// `id-data` (1.2.840.113549.1.7.1) — the only content type allowed inside
/// the degenerate `SignedData`, and its content must be absent.
const OID_DATA: &[u8] = &[
    0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x01,
];
/// `id-signedData` (1.2.840.113549.1.7.2) — the only content type this module
/// serves.
const OID_SIGNED_DATA: &[u8] = &[
    0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x02,
];

/// DER length prefix (definite, minimal form) for `len`.
fn der_len(len: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(4);
    if len < 0x80 {
        out.push(u8::try_from(len).unwrap_or_default());
    } else {
        let bytes = len.to_be_bytes();
        let first = bytes.iter().position(|byte| *byte != 0).unwrap_or(7);
        let used = 8 - first;
        out.push(0x80 | u8::try_from(used).unwrap_or_default());
        out.extend_from_slice(&bytes[first..]);
    }
    out
}

/// `tag || len(payload) || payload`.
fn der_tlv(tag: u8, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(payload.len() + 5);
    out.push(tag);
    out.extend_from_slice(&der_len(payload.len()));
    out.extend_from_slice(payload);
    out
}

/// Builds an RFC 5652 `certs-only` object carrying `der_certs` (DER-encoded
/// `Certificate`s, any order; the caller decides whether a root is included).
///
/// # Errors
/// Returns [`PkiError::TooLarge`] when the certificate count or total size
/// exceeds this module's caps, and [`PkiError::InvalidName`] (this crate's
/// stable malformed-input refusal) when a certificate is not a DER `SEQUENCE`
/// — a cheap shape check so a caller cannot wrap arbitrary bytes in a valid
/// envelope.
pub fn certs_only(der_certs: &[Vec<u8>]) -> Result<Vec<u8>, PkiError> {
    if der_certs.is_empty() || der_certs.len() > MAX_PKCS7_CERTS {
        return Err(PkiError::TooLarge);
    }
    let total: usize = der_certs.iter().map(Vec::len).sum();
    if total > MAX_PKCS7_BYTES {
        return Err(PkiError::TooLarge);
    }
    for cert in der_certs {
        if cert.len() < 4 || cert[0] != 0x30 {
            return Err(PkiError::InvalidName);
        }
    }

    // SignedData ::= SEQUENCE { version INTEGER (1), digestAlgorithms SET {},
    //   contentInfo SEQUENCE { OID id-data }, certificates [0] IMPLICIT,
    //   signerInfos SET {} }.
    let mut signed_data = Vec::new();
    signed_data.extend_from_slice(&[0x02, 0x01, 0x01]); // version = 1
    signed_data.extend_from_slice(&[0x31, 0x00]); // digestAlgorithms: empty SET
    signed_data.extend_from_slice(&der_tlv(0x30, OID_DATA)); // contentInfo (no content)
    let mut certs_payload = Vec::new();
    for cert in der_certs {
        certs_payload.extend_from_slice(cert);
    }
    signed_data.extend_from_slice(&der_tlv(0xa0, &certs_payload)); // [0] IMPLICIT SET OF
    signed_data.extend_from_slice(&[0x31, 0x00]); // signerInfos: empty SET

    // ContentInfo ::= SEQUENCE { OID id-signedData, [0] EXPLICIT SignedData }
    let mut content_info = OID_SIGNED_DATA.to_vec();
    content_info.extend_from_slice(&der_tlv(0xa0, &der_tlv(0x30, &signed_data)));
    Ok(der_tlv(0x30, &content_info))
}

/// One TLV: returns `(tag, payload)` and the rest, or `None` on truncation.
fn take_tlv(input: &[u8]) -> Option<(u8, &[u8], &[u8])> {
    let (tag, rest) = input.split_first()?;
    let (len_byte, mut rest) = rest.split_first()?;
    let len = if *len_byte < 0x80 {
        usize::from(*len_byte)
    } else {
        let used = usize::from(len_byte & 0x7f);
        if used == 0 || used > 4 || rest.len() < used {
            return None;
        }
        let mut len = 0usize;
        for byte in &rest[..used] {
            len = (len << 8) | usize::from(*byte);
        }
        rest = &rest[used..];
        len
    };
    if rest.len() < len {
        return None;
    }
    Some((*tag, &rest[..len], &rest[len..]))
}

/// Strictly decodes a `certs-only` object and returns the DER certificates in
/// payload order. Anything with content, CRLs or signatures is refused.
///
/// # Errors
/// Returns [`PkiError::TooLarge`] past the size or count caps and
/// [`PkiError::CsrParse`] (this crate's stable malformed-envelope refusal) for
/// any structural deviation.
pub fn parse_certs_only(der: &[u8]) -> Result<Vec<Vec<u8>>, PkiError> {
    if der.len() > MAX_PKCS7_BYTES {
        return Err(PkiError::TooLarge);
    }
    let (tag, content_info, trailing) = take_tlv(der).ok_or(PkiError::CsrParse)?;
    if tag != 0x30 || !trailing.is_empty() {
        return Err(PkiError::CsrParse);
    }
    let (tag, oid, rest) = take_tlv(content_info).ok_or(PkiError::CsrParse)?;
    if tag != 0x06 || oid != &OID_SIGNED_DATA[2..] || rest.is_empty() {
        return Err(PkiError::CsrParse);
    }
    let (tag, explicit, trailing) = take_tlv(rest).ok_or(PkiError::CsrParse)?;
    if tag != 0xa0 || !trailing.is_empty() {
        return Err(PkiError::CsrParse);
    }
    let (tag, signed_data, trailing) = take_tlv(explicit).ok_or(PkiError::CsrParse)?;
    if tag != 0x30 || !trailing.is_empty() {
        return Err(PkiError::CsrParse);
    }

    // version INTEGER 1
    let (tag, version, rest) = take_tlv(signed_data).ok_or(PkiError::CsrParse)?;
    if tag != 0x02 || version != [0x01] {
        return Err(PkiError::CsrParse);
    }
    // digestAlgorithms: empty SET only (nothing is signed here).
    let (tag, digests, rest) = take_tlv(rest).ok_or(PkiError::CsrParse)?;
    if tag != 0x31 || !digests.is_empty() {
        return Err(PkiError::CsrParse);
    }
    // contentInfo: SEQUENCE { OID id-data } with absent content.
    let (tag, inner, rest) = take_tlv(rest).ok_or(PkiError::CsrParse)?;
    if tag != 0x30 {
        return Err(PkiError::CsrParse);
    }
    let (tag, oid, inner_rest) = take_tlv(inner).ok_or(PkiError::CsrParse)?;
    if tag != 0x06 || oid != &OID_DATA[2..] || !inner_rest.is_empty() {
        return Err(PkiError::CsrParse);
    }
    // certificates [0] IMPLICIT: concatenated DER certificates.
    let (tag, certs_payload, rest) = take_tlv(rest).ok_or(PkiError::CsrParse)?;
    if tag != 0xa0 {
        return Err(PkiError::CsrParse);
    }
    let mut certificates = Vec::new();
    let mut cursor = certs_payload;
    while !cursor.is_empty() {
        let (tag, _payload, next) = take_tlv(cursor).ok_or(PkiError::CsrParse)?;
        if tag != 0x30 || certificates.len() >= MAX_PKCS7_CERTS {
            return Err(PkiError::CsrParse);
        }
        let consumed = cursor.len() - next.len();
        certificates.push(cursor[..consumed].to_vec());
        cursor = next;
    }
    if certificates.is_empty() {
        return Err(PkiError::CsrParse);
    }
    // signerInfos: empty SET is the only thing allowed to remain.
    let (tag, signers, trailing) = take_tlv(rest).ok_or(PkiError::CsrParse)?;
    if tag != 0x31 || !signers.is_empty() || !trailing.is_empty() {
        return Err(PkiError::CsrParse);
    }
    Ok(certificates)
}

#[cfg(test)]
#[path = "pkcs7_tests.rs"]
mod tests;
