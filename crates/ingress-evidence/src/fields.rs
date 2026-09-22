//! Physical-field collection and RFC 8941 decoding for the two RFC 9440 fields.
//!
//! This module turns header text into decoded byte sequences and nothing
//! more. It does not look inside a certificate; `chain.rs` does that.

use base64::Engine as _;
use http::HeaderMap;
use sfv::{BareItem, Item, List, ListEntry, Parser, Version};

use crate::error::{Field, IngressError};
use crate::limits::IngressLimits;

/// Every physical `Client-Cert` / `Client-Cert-Chain` field value, in wire order.
pub(crate) struct RawFields<'h> {
    pub(crate) leaf: Vec<&'h [u8]>,
    pub(crate) chain: Vec<&'h [u8]>,
}

/// True when at least one RFC 9440 field is present, whatever its state.
#[must_use]
pub fn has_client_cert_fields(headers: &HeaderMap) -> bool {
    headers.contains_key(Field::ClientCert.header_name())
        || headers.contains_key(Field::ClientCertChain.header_name())
}

/// Collects the physical fields and applies the total-bytes limit first, so
/// nothing below ever sees more text than the limit allows.
pub(crate) fn collect<'h>(
    headers: &'h HeaderMap,
    limits: &IngressLimits,
) -> Result<RawFields<'h>, IngressError> {
    let leaf: Vec<&[u8]> = headers
        .get_all(Field::ClientCert.header_name())
        .iter()
        .map(http::HeaderValue::as_bytes)
        .collect();
    let chain: Vec<&[u8]> = headers
        .get_all(Field::ClientCertChain.header_name())
        .iter()
        .map(http::HeaderValue::as_bytes)
        .collect();
    let total: usize = leaf.iter().chain(chain.iter()).map(|v| v.len()).sum();
    if total > limits.max_total_header_bytes {
        return Err(IngressError::HeaderBytesExceeded);
    }
    if leaf.len() > 1 {
        return Err(IngressError::LeafRepeated);
    }
    if leaf.is_empty() {
        return Err(IngressError::LeafMissing);
    }
    Ok(RawFields { leaf, chain })
}

/// Decodes the singleton `Client-Cert` item.
pub(crate) fn decode_leaf(value: &[u8]) -> Result<Vec<u8>, IngressError> {
    let field = Field::ClientCert;
    check_visible_ascii(value, field)?;
    if is_blank(value) {
        return Err(IngressError::EmptyItem(field));
    }
    let item: Item = Parser::new(value)
        .with_version(Version::Rfc8941)
        .parse_item()
        .map_err(|_| IngressError::MalformedStructuredField(field))?;
    let bytes = byte_sequence(&item, field)?;
    check_canonical(value, std::slice::from_ref(&bytes), field)?;
    Ok(bytes)
}

/// Decodes one physical `Client-Cert-Chain` field into its members.
pub(crate) fn decode_chain_field(value: &[u8]) -> Result<Vec<Vec<u8>>, IngressError> {
    let field = Field::ClientCertChain;
    check_visible_ascii(value, field)?;
    if is_blank(value) {
        return Err(IngressError::EmptyItem(field));
    }
    let list: List = Parser::new(value)
        .with_version(Version::Rfc8941)
        .parse_list()
        .map_err(|_| IngressError::MalformedStructuredField(field))?;
    if list.is_empty() {
        return Err(IngressError::EmptyItem(field));
    }
    let mut members = Vec::with_capacity(list.len());
    for entry in &list {
        match entry {
            ListEntry::Item(item) => members.push(byte_sequence(item, field)?),
            ListEntry::InnerList(_) => return Err(IngressError::NotByteSequence(field)),
        }
    }
    check_canonical(value, &members, field)?;
    Ok(members)
}

fn byte_sequence(item: &Item, field: Field) -> Result<Vec<u8>, IngressError> {
    let BareItem::ByteSequence(bytes) = &item.bare_item else {
        return Err(IngressError::NotByteSequence(field));
    };
    if !item.params.is_empty() {
        return Err(IngressError::ParametersPresent(field));
    }
    if bytes.is_empty() {
        return Err(IngressError::EmptyItem(field));
    }
    Ok(bytes.clone())
}

/// A field value of only OWS is reported as an empty item rather than left
/// to the two libraries, which disagree on whether it is an empty List.
fn is_blank(value: &[u8]) -> bool {
    value.iter().all(|b| matches!(b, b' ' | b'\t'))
}

/// Header text outside visible ASCII (plus SP / HTAB) can never be a valid
/// structured field; refusing it up front keeps the two parsers aligned on
/// obs-text, which each library reports differently.
fn check_visible_ascii(value: &[u8], field: Field) -> Result<(), IngressError> {
    if value.iter().all(|b| matches!(b, 0x20..=0x7e | b'\t')) {
        Ok(())
    } else {
        Err(IngressError::MalformedStructuredField(field))
    }
}

/// RFC 8941 tells parsers to tolerate missing padding and stray pad bits.
/// Both libraries do, each in its own way, so the raw text is walked once
/// more after a structurally successful parse: because the value is known to
/// be only byte sequences separated by commas and OWS, every `:...:` segment
/// must equal the canonical re-encoding of the member decoded from it.
fn check_canonical(value: &[u8], members: &[Vec<u8>], field: Field) -> Result<(), IngressError> {
    let mut index = 0;
    for member in members {
        while index < value.len() && matches!(value[index], b' ' | b'\t' | b',') {
            index += 1;
        }
        if value.get(index) != Some(&b':') {
            return Err(IngressError::MalformedStructuredField(field));
        }
        index += 1;
        let Some(end) = value[index..].iter().position(|b| *b == b':') else {
            return Err(IngressError::MalformedStructuredField(field));
        };
        let raw = &value[index..index + end];
        let canonical = base64::engine::general_purpose::STANDARD.encode(member);
        if raw != canonical.as_bytes() {
            return Err(IngressError::MalformedStructuredField(field));
        }
        index += end + 1;
    }
    Ok(())
}
