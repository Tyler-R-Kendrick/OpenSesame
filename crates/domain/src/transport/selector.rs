//! Exact-match peer identity selectors. No wildcards, no CN, no email, no IP.

use super::error::TransportError;
use super::validate_thumbprint;
use serde::{Deserialize, Serialize};

/// Longest selector accepted (the SPIFFE ID ceiling).
pub const MAX_SELECTOR_BYTES: usize = 2048;
const MAX_DNS_BYTES: usize = 253;
const MAX_LABEL_BYTES: usize = 63;

/// One validated identity a peer presented or a binding names. A
/// deserialized value is always well-formed; a hand-built one is checked by
/// [`PeerIdentitySelector::validate`] wherever it enters policy.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(
    rename_all = "snake_case",
    deny_unknown_fields,
    try_from = "SelectorWire"
)]
pub enum PeerIdentitySelector {
    /// `spiffe://trust-domain/path`, validated per the SPIFFE ID standard.
    SpiffeId(String),
    /// Lowercase RFC 9525 DNS reference identity; never a wildcard or an IP.
    DnsName(String),
    /// A non-SPIFFE URI SAN, compared byte-for-byte.
    UriSan(String),
    /// SHA-256 of the leaf DER, 64 lowercase hex characters.
    LeafThumbprintSha256(String),
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
enum SelectorWire {
    SpiffeId(String),
    DnsName(String),
    UriSan(String),
    LeafThumbprintSha256(String),
}

impl TryFrom<SelectorWire> for PeerIdentitySelector {
    type Error = TransportError;
    fn try_from(wire: SelectorWire) -> Result<Self, TransportError> {
        let selector = match wire {
            SelectorWire::SpiffeId(s) => Self::SpiffeId(s),
            SelectorWire::DnsName(s) => Self::DnsName(s),
            SelectorWire::UriSan(s) => Self::UriSan(s),
            SelectorWire::LeafThumbprintSha256(s) => Self::LeafThumbprintSha256(s),
        };
        selector.validate()?;
        Ok(selector)
    }
}

impl PeerIdentitySelector {
    /// Validate the selector's syntax for its kind.
    ///
    /// # Errors
    ///
    /// `MalformedConfiguration` describing the first rule the value breaks.
    pub fn validate(&self) -> Result<(), TransportError> {
        match self {
            Self::SpiffeId(id) => validate_spiffe_id(id),
            Self::DnsName(name) => validate_dns_name(name),
            Self::UriSan(uri) => validate_uri_san(uri),
            Self::LeafThumbprintSha256(hex) => validate_thumbprint("leaf_thumbprint_sha256", hex),
        }
    }

    /// The selector's raw value.
    #[must_use]
    pub fn value(&self) -> &str {
        match self {
            Self::SpiffeId(v)
            | Self::DnsName(v)
            | Self::UriSan(v)
            | Self::LeafThumbprintSha256(v) => v,
        }
    }

    /// True for the thumbprint selector.
    #[must_use]
    pub const fn is_thumbprint(&self) -> bool {
        matches!(self, Self::LeafThumbprintSha256(_))
    }
}

fn malformed(kind: &str, why: &str) -> TransportError {
    TransportError::malformed(format!("{kind}: {why}"))
}

fn is_ascii_printable_no_space(value: &str) -> bool {
    value.bytes().all(|b| (0x21..=0x7E).contains(&b))
}

fn validate_spiffe_id(id: &str) -> Result<(), TransportError> {
    const KIND: &str = "spiffe_id";
    if id.len() > MAX_SELECTOR_BYTES {
        return Err(malformed(KIND, "exceeds 2048 bytes"));
    }
    if !is_ascii_printable_no_space(id) {
        return Err(malformed(KIND, "must be printable ASCII"));
    }
    let Some(rest) = id.strip_prefix("spiffe://") else {
        return Err(malformed(KIND, "must start with spiffe://"));
    };
    let (trust_domain, path) = rest.split_once('/').unwrap_or((rest, ""));
    let domain_ok = !trust_domain.is_empty()
        && trust_domain.bytes().all(|b| {
            b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'.' | b'-' | b'_')
        });
    if !domain_ok {
        return Err(malformed(KIND, "trust domain must be [a-z0-9._-]+"));
    }
    if path.is_empty() {
        return Err(malformed(KIND, "workload path is required"));
    }
    for segment in path.split('/') {
        let segment_ok = !segment.is_empty()
            && segment != "."
            && segment != ".."
            && segment
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_'));
        if !segment_ok {
            return Err(malformed(
                KIND,
                "path segments must be non-empty [a-zA-Z0-9._-]+",
            ));
        }
    }
    Ok(())
}

fn validate_dns_name(name: &str) -> Result<(), TransportError> {
    const KIND: &str = "dns_name";
    if name.is_empty() || name.len() > MAX_DNS_BYTES {
        return Err(malformed(KIND, "must be 1..=253 bytes"));
    }
    if name.contains('*') {
        return Err(malformed(KIND, "wildcards are not selectors"));
    }
    if name.ends_with('.') {
        return Err(malformed(KIND, "trailing dot is not a reference identity"));
    }
    if name.contains(':') || name.bytes().all(|b| b.is_ascii_digit() || b == b'.') {
        return Err(malformed(KIND, "IP addresses are not selectors"));
    }
    for label in name.split('.') {
        let label_ok = !label.is_empty()
            && label.len() <= MAX_LABEL_BYTES
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
        if !label_ok {
            return Err(malformed(
                KIND,
                "labels must be lowercase LDH, 1..=63 bytes",
            ));
        }
    }
    Ok(())
}

fn validate_uri_san(uri: &str) -> Result<(), TransportError> {
    const KIND: &str = "uri_san";
    if uri.is_empty() || uri.len() > MAX_SELECTOR_BYTES {
        return Err(malformed(KIND, "must be 1..=2048 bytes"));
    }
    if !is_ascii_printable_no_space(uri) {
        return Err(malformed(KIND, "must be printable ASCII"));
    }
    let Some((scheme, rest)) = uri.split_once(':') else {
        return Err(malformed(KIND, "must carry a scheme"));
    };
    let scheme_ok = scheme
        .as_bytes()
        .first()
        .is_some_and(u8::is_ascii_lowercase)
        && scheme.bytes().all(|b| {
            b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'+' | b'.' | b'-')
        });
    if !scheme_ok || rest.is_empty() {
        return Err(malformed(
            KIND,
            "scheme must be lowercase [a-z][a-z0-9+.-]* with a body",
        ));
    }
    if scheme == "spiffe" {
        return Err(malformed(KIND, "SPIFFE IDs use the spiffe_id selector"));
    }
    if scheme == "mailto" || rest.contains('@') {
        return Err(malformed(KIND, "email addresses are not selectors"));
    }
    if uri.contains('*') || uri.contains('#') {
        return Err(malformed(KIND, "wildcards and fragments are not selectors"));
    }
    Ok(())
}
