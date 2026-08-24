//! OTP (pass-otp Key URI Format) and RFC 6238 TOTP.

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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OtpUri {
    /// Full otpauth:// URI as stored.
    pub uri: String,
    pub secret: Vec<u8>,
    pub digits: u32,
    pub period: u64,
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
    #[error("unsupported OTP type (only totp is generated)")]
    UnsupportedType,
    #[error("base32 decode failed: {0}")]
    Base32(String),
}

/// Validate and parse an otpauth:// URI (TOTP).
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
    // Generation only supports TOTP; HOTP may still validate/store.
    let secret_param = url
        .query_pairs()
        .find(|(k, _)| k == "secret")
        .map(|(_, v)| v.into_owned())
        .ok_or(OtpError::MissingSecret)?;
    let secret = decode_base32(&secret_param)?;
    let digits = url
        .query_pairs()
        .find(|(k, _)| k == "digits")
        .and_then(|(_, v)| v.parse().ok())
        .unwrap_or(6);
    let digits = if (6..=10).contains(&digits) {
        digits
    } else {
        6
    };
    let period = url
        .query_pairs()
        .find(|(k, _)| k == "period")
        .and_then(|(_, v)| v.parse().ok())
        .unwrap_or(30);
    let period = if period > 0 { period } else { 30 };
    let algorithm = match url
        .query_pairs()
        .find(|(k, _)| k == "algorithm")
        .map(|(_, v)| v.to_ascii_uppercase())
        .as_deref()
    {
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
    let issuer = url
        .query_pairs()
        .find(|(k, _)| k == "issuer")
        .map(|(_, v)| v.into_owned());
    Ok(OtpUri {
        uri: trimmed.to_string(),
        secret,
        digits,
        period,
        algorithm,
        label,
        issuer,
    })
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
    if otp.uri.to_ascii_lowercase().contains("otpauth://hotp/") {
        return Err(OtpError::UnsupportedType);
    }
    let counter = at_unix / otp.period;
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
    let binary = u32::from_be_bytes([
        digest[offset] & 0x7f,
        digest[offset + 1],
        digest[offset + 2],
        digest[offset + 3],
    ]);
    let modulus = 10u32.pow(otp.digits);
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
    let clean: String = input
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-')
        .map(|c| c.to_ascii_uppercase())
        .filter(|c| *c != '=')
        .collect();
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
mod tests {
    use super::*;

    /// RFC 6238 Appendix B seed ASCII "12345678901234567890" as base32.
    const RFC_SEED: &str = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

    fn rfc_uri(digits: u32) -> String {
        format!(
            "otpauth://totp/Example:alice@example.com?secret={RFC_SEED}&issuer=Example&digits={digits}&algorithm=SHA1&period=30"
        )
    }

    #[test]
    fn rfc6238_sha1_8_digits() {
        let otp = parse_otpauth(&rfc_uri(8)).unwrap();
        let vectors: &[(u64, &str)] = &[
            (59, "94287082"),
            (1_111_111_109, "07081804"),
            (1_111_111_111, "14050471"),
            (1_234_567_890, "89005924"),
            (2_000_000_000, "69279037"),
            (20_000_000_000, "65353130"),
        ];
        for &(secs, expected) in vectors {
            assert_eq!(totp_code(&otp, secs).unwrap(), expected, "T={secs}");
        }
    }

    #[test]
    fn validate_rejects_missing_secret() {
        assert!(!validate_otpauth("otpauth://totp/Example?issuer=Example"));
    }

    #[test]
    fn find_and_sync_trailer() {
        let trailer = "url: https://example.com\notpauth://totp/x?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ\nnote: hi\n"; // gitleaks:allow -- RFC fixture
        let found = find_otpauth_in_trailer(trailer).unwrap();
        assert!(found.uri.contains("otpauth://totp/x"));
        let synced = sync_trailer_otp(trailer, Some(&found));
        assert_eq!(
            synced
                .lines()
                .filter(|l| l.starts_with("otpauth://"))
                .count(),
            1
        );
        assert!(synced.contains("url: https://example.com"));
        assert!(synced.contains("note: hi"));
    }
}
