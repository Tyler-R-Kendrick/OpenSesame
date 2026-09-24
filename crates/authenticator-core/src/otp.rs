//! Portable OTP (Key URI Format, RFC 4226, and RFC 6238) implementation.

use hmac::{Hmac, Mac};
use sha1::Sha1;
use sha2::{Sha256, Sha512};
use thiserror::Error;
use url::Url;

type HmacSha1 = Hmac<Sha1>;
type HmacSha256 = Hmac<Sha256>;
type HmacSha512 = Hmac<Sha512>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OtpAlgorithm {
    Sha1,
    Sha256,
    Sha512,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OtpKind {
    Totp,
    Hotp,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OtpUri {
    /// Full otpauth:// URI as stored.
    pub uri: String,
    pub secret: Vec<u8>,
    pub kind: OtpKind,
    pub digits: u32,
    pub period: u64,
    pub counter: Option<u64>,
    pub algorithm: OtpAlgorithm,
    pub label: Option<String>,
    pub issuer: Option<String>,
}

#[derive(Debug, Error)]
pub enum OtpError {
    #[error("not a valid otpauth URI: {0}")]
    InvalidUri(String),
    #[error("otpauth URI has no secret")]
    MissingSecret,
    #[error("HOTP URI has no counter")]
    MissingCounter,
    #[error("OTP operation does not match URI type")]
    UnsupportedType,
    #[error("base32 decode failed: {0}")]
    Base32(String),
}

/// Validate and parse an otpauth:// URI (TOTP or HOTP).
///
/// # Errors
///
/// Returns an error when validation or the underlying operation fails.
pub fn parse_otpauth(raw: &str) -> Result<OtpUri, OtpError> {
    let trimmed = raw.trim();
    if !trimmed.to_ascii_lowercase().starts_with("otpauth://") {
        return Err(OtpError::InvalidUri("must start with otpauth://".into()));
    }
    let url = Url::parse(trimmed).map_err(|e| OtpError::InvalidUri(e.to_string()))?;
    if url.scheme() != "otpauth" {
        return Err(OtpError::InvalidUri("scheme must be otpauth".into()));
    }
    let host = url.host_str().unwrap_or("").to_ascii_lowercase();
    if host != "totp" && host != "hotp" {
        return Err(OtpError::InvalidUri(format!("unknown type {host}")));
    }
    let kind = if host == "hotp" {
        OtpKind::Hotp
    } else {
        OtpKind::Totp
    };
    if !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
        return Err(OtpError::InvalidUri(
            "credentials and fragments are forbidden".into(),
        ));
    }
    let pairs: Vec<_> = url.query_pairs().collect();
    let parameter = |name: &str| -> Result<Option<&str>, OtpError> {
        let mut values = pairs
            .iter()
            .filter(|(key, _)| key == name)
            .map(|(_, value)| value.as_ref());
        let value = values.next();
        if values.next().is_some() {
            return Err(OtpError::InvalidUri(format!("duplicate {name} parameter")));
        }
        Ok(value)
    };
    let secret_param = parameter("secret")?.ok_or(OtpError::MissingSecret)?;
    let secret = decode_base32(secret_param)?;
    let digits = parameter("digits")?
        .map(|value| {
            decimal::<u32>(value)
                .filter(|digits| (6..=10).contains(digits))
                .ok_or_else(|| OtpError::InvalidUri("digits must be between 6 and 10".into()))
        })
        .transpose()?
        .unwrap_or(6);
    let period = parameter("period")?
        .map(|value| {
            decimal::<u64>(value)
                .filter(|period| *period > 0)
                .ok_or_else(|| OtpError::InvalidUri("period must be positive".into()))
        })
        .transpose()?
        .unwrap_or(30);
    let counter = parameter("counter")?
        .map(|value| {
            decimal::<u64>(value).ok_or_else(|| OtpError::InvalidUri("invalid HOTP counter".into()))
        })
        .transpose()?;
    if kind == OtpKind::Hotp && counter.is_none() {
        return Err(OtpError::MissingCounter);
    }
    let algorithm_value = parameter("algorithm")?.map(str::to_ascii_uppercase);
    let algorithm = match algorithm_value.as_deref() {
        None | Some("SHA1" | "SHA-1") => OtpAlgorithm::Sha1,
        Some("SHA256" | "SHA-256") => OtpAlgorithm::Sha256,
        Some("SHA512" | "SHA-512") => OtpAlgorithm::Sha512,
        Some(other) => {
            return Err(OtpError::InvalidUri(format!(
                "unsupported algorithm {other}"
            )))
        }
    };
    let label = {
        let path = url.path().trim_start_matches('/');
        if path.is_empty() {
            None
        } else {
            Some(path.to_string())
        }
    };
    let issuer = parameter("issuer")?.map(str::to_owned);
    Ok(OtpUri {
        uri: trimmed.to_string(),
        secret,
        kind,
        digits,
        period,
        counter,
        algorithm,
        label,
        issuer,
    })
}

/// An authenticator secret as a person pastes it: a bare base32 seed (SHA-1,
/// six digits, thirty seconds) or an `otpauth://totp` URI. The same rules as
/// `parseTotp` in `packages/vault-core` (`spec/conformance/otp-cases.json`).
///
/// # Errors
///
/// Returns an error for anything but a usable TOTP secret.
pub fn parse_totp(raw: &str) -> Result<OtpUri, OtpError> {
    let trimmed = raw.trim();
    if trimmed.contains(':') {
        let otp = parse_otpauth(trimmed)?;
        return if otp.kind == OtpKind::Totp {
            Ok(otp)
        } else {
            Err(OtpError::UnsupportedType)
        };
    }
    let secret = decode_base32(trimmed)?;
    Ok(OtpUri {
        uri: format!("otpauth://totp/?secret={}", trimmed.to_ascii_uppercase()),
        secret,
        kind: OtpKind::Totp,
        digits: 6,
        period: 30,
        counter: None,
        algorithm: OtpAlgorithm::Sha1,
        label: None,
        issuer: None,
    })
}

/// An `otpauth://hotp` URI with its counter.
///
/// # Errors
///
/// Returns an error for anything but a usable HOTP URI.
pub fn parse_hotp(raw: &str) -> Result<OtpUri, OtpError> {
    let otp = parse_otpauth(raw)?;
    if otp.kind == OtpKind::Hotp {
        Ok(otp)
    } else {
        Err(OtpError::UnsupportedType)
    }
}

/// A plain decimal: ASCII digits only, so `+6`, `6.5` and ` 6` are refused.
fn decimal<T: std::str::FromStr>(value: &str) -> Option<T> {
    if value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    value.parse().ok()
}

#[must_use]
pub fn validate_otpauth(raw: &str) -> bool {
    parse_otpauth(raw).is_ok()
}

/// RFC 6238 TOTP. `at_unix` is seconds since epoch.
///
/// # Errors
///
/// Returns an error when validation or the underlying operation fails.
pub fn totp_code(otp: &OtpUri, at_unix: u64) -> Result<String, OtpError> {
    if otp.kind != OtpKind::Totp {
        return Err(OtpError::UnsupportedType);
    }
    let counter = at_unix / otp.period;
    hotp_digest(otp, counter)
}

/// RFC 4226 HOTP at an explicit counter. Callers must persist a successful
/// counter advance atomically before returning the code to the user.
///
/// # Errors
///
/// Returns an error when the URI is not HOTP or HMAC evaluation fails.
pub fn hotp_code(otp: &OtpUri, counter: u64) -> Result<String, OtpError> {
    if otp.kind != OtpKind::Hotp {
        return Err(OtpError::UnsupportedType);
    }
    hotp_digest(otp, counter)
}

fn hotp_digest(otp: &OtpUri, counter: u64) -> Result<String, OtpError> {
    let mut msg = [0u8; 8];
    msg[..8].copy_from_slice(&counter.to_be_bytes());
    let digest = match otp.algorithm {
        OtpAlgorithm::Sha1 => {
            let mut mac = HmacSha1::new_from_slice(&otp.secret)
                .map_err(|e| OtpError::InvalidUri(e.to_string()))?;
            mac.update(&msg);
            mac.finalize().into_bytes().to_vec()
        }
        OtpAlgorithm::Sha256 => {
            let mut mac = HmacSha256::new_from_slice(&otp.secret)
                .map_err(|e| OtpError::InvalidUri(e.to_string()))?;
            mac.update(&msg);
            mac.finalize().into_bytes().to_vec()
        }
        OtpAlgorithm::Sha512 => {
            let mut mac = HmacSha512::new_from_slice(&otp.secret)
                .map_err(|e| OtpError::InvalidUri(e.to_string()))?;
            mac.update(&msg);
            mac.finalize().into_bytes().to_vec()
        }
    };
    let offset = (digest[digest.len() - 1] & 0x0f) as usize;
    let binary = u64::from(u32::from_be_bytes([
        digest[offset] & 0x7f,
        digest[offset + 1],
        digest[offset + 2],
        digest[offset + 3],
    ]));
    let modulus = 10u64.pow(otp.digits);
    let code = binary % modulus;
    Ok(format!("{:0width$}", code, width = otp.digits as usize))
}

/// Find the first otpauth:// line in trailer text.
#[must_use]
pub fn find_otpauth_in_trailer(trailer: &str) -> Option<OtpUri> {
    for line in trailer.lines() {
        let t = line.trim();
        if t.to_ascii_lowercase().starts_with("otpauth://") {
            if let Ok(otp) = parse_otpauth(t) {
                return Some(otp);
            }
        }
    }
    None
}

/// Remove existing otpauth lines and append `otp.uri` (if any).
pub fn sync_trailer_otp(trailer: &str, otp: Option<&OtpUri>) -> String {
    let mut lines: Vec<String> = trailer
        .lines()
        .filter(|l| !l.trim().to_ascii_lowercase().starts_with("otpauth://"))
        .map(str::to_string)
        .collect();
    if let Some(o) = otp {
        lines.push(o.uri.clone());
    }
    if lines.is_empty() {
        return String::new();
    }
    let mut out = lines.join("\n");
    if !out.ends_with('\n') {
        out.push('\n');
    }
    out
}

fn decode_base32(input: &str) -> Result<Vec<u8>, OtpError> {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    // Padding is accepted only at the end, as in `decodeBase32` (TypeScript).
    let clean: String = input
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-')
        .map(|c| c.to_ascii_uppercase())
        .collect::<String>()
        .trim_end_matches('=')
        .to_owned();
    if clean.is_empty() {
        return Err(OtpError::Base32("empty".into()));
    }
    let mut bits: u32 = 0;
    let mut value: u32 = 0;
    let mut out = Vec::new();
    for c in clean.chars() {
        let idx = ALPHABET
            .iter()
            .position(|&b| b == c as u8)
            .ok_or_else(|| OtpError::Base32(format!("unexpected character \"{c}\"")))?;
        value = (value << 5) | u32::try_from(idx).expect("base32 alphabet index fits in u32");
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            out.push(((value >> bits) & 0xff) as u8);
        }
    }
    if out.is_empty() {
        return Err(OtpError::Base32("decoded to no bytes".into()));
    }
    Ok(out)
}

#[cfg(test)]
#[path = "otp_tests.rs"]
mod tests;
