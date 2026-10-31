//! Reading STS's answer, boundedly, and refusing what cannot be trusted.
//!
//! The body has already been capped by invoke-through. The reader then walks
//! it event by event: no DTD, no more than [`MAX_DEPTH`] levels or
//! [`MAX_EVENTS`] events, no captured value longer than [`MAX_VALUE`], no
//! entity inside a captured value, and no field seen twice. A success answer
//! must hold all four credential fields and a request id, each in the shape
//! STS documents; anything else is `malformed_response`.

use std::fmt;

use chrono::{DateTime, Duration, Utc};
use quick_xml::events::Event;
use quick_xml::Reader;
use secrecy::SecretString;

use super::StsFailure;

pub const MAX_DEPTH: usize = 8;
pub const MAX_EVENTS: usize = 512;
pub const MAX_VALUE: usize = 4096;
/// Clock skew allowed between STS and the Host when checking `Expiration`.
pub const EXPIRATION_SKEW_SECONDS: i64 = 300;

const CREDENTIALS: &[&str] = &["AssumeRoleResponse", "AssumeRoleResult", "Credentials"];
const REQUEST_ID: &[&str] = &["AssumeRoleResponse", "ResponseMetadata", "RequestId"];
const ERROR_CODE: &[&str] = &["ErrorResponse", "Error", "Code"];

/// The temporary credential STS issued.
pub struct StsCredentials {
    pub access_key_id: String,
    pub secret_access_key: SecretString,
    pub session_token: SecretString,
    pub expiration: DateTime<Utc>,
}

impl fmt::Debug for StsCredentials {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("StsCredentials")
            .field("access_key_id", &"[REDACTED]")
            .field("secret_access_key", &"[REDACTED]")
            .field("session_token", &"[REDACTED]")
            .field("expiration", &self.expiration)
            .finish()
    }
}

/// A parsed `AssumeRoleResponse`.
#[derive(Debug)]
pub struct AssumeRoleAnswer {
    pub credentials: StsCredentials,
    pub request_id: String,
}

/// Every `(path, text)` the reader captured for the paths it was asked for.
fn capture(body: &[u8], wanted: &[&[&str]]) -> Result<Vec<(usize, String)>, StsFailure> {
    let text = std::str::from_utf8(body).map_err(|_| StsFailure::MalformedResponse)?;
    let mut reader = Reader::from_str(text);
    reader.config_mut().trim_text(true);
    let mut path: Vec<String> = Vec::new();
    let mut found: Vec<(usize, String)> = Vec::new();
    for _ in 0..MAX_EVENTS {
        match reader
            .read_event()
            .map_err(|_| StsFailure::MalformedResponse)?
        {
            Event::Start(start) => {
                if path.len() >= MAX_DEPTH {
                    return Err(StsFailure::MalformedResponse);
                }
                let name = std::str::from_utf8(start.local_name().as_ref())
                    .map_err(|_| StsFailure::MalformedResponse)?
                    .to_string();
                path.push(name);
            }
            Event::End(_) => {
                path.pop();
            }
            Event::Text(value) => {
                if let Some(index) = wanted.iter().position(|want| path_is(&path, want)) {
                    let value = value.decode().map_err(|_| StsFailure::MalformedResponse)?;
                    keep(&mut found, index, &value)?;
                }
            }
            Event::GeneralRef(_) | Event::CData(_) => {
                // No value STS sends for these paths needs an escape; one that
                // has one is not an answer this reader will interpret.
                if wanted.iter().any(|want| path_is(&path, want)) {
                    return Err(StsFailure::MalformedResponse);
                }
            }
            Event::DocType(_) => return Err(StsFailure::MalformedResponse),
            Event::Eof => return Ok(found),
            Event::Empty(_) | Event::Comment(_) | Event::Decl(_) | Event::PI(_) => {}
        }
    }
    Err(StsFailure::MalformedResponse)
}

/// Keep one captured value: bounded, and never a second time for its path.
fn keep(found: &mut Vec<(usize, String)>, index: usize, value: &str) -> Result<(), StsFailure> {
    if value.len() > MAX_VALUE || found.iter().any(|(seen, _)| *seen == index) {
        return Err(StsFailure::MalformedResponse);
    }
    found.push((index, value.to_string()));
    Ok(())
}

fn path_is(path: &[String], want: &[&str]) -> bool {
    path.len() == want.len() && path.iter().zip(want).all(|(have, want)| have == want)
}

fn take(found: &mut Vec<(usize, String)>, index: usize) -> Result<String, StsFailure> {
    let position = found
        .iter()
        .position(|(seen, _)| *seen == index)
        .ok_or(StsFailure::MalformedResponse)?;
    Ok(found.swap_remove(position).1)
}

fn shaped(value: &str, min: usize, max: usize, allowed: impl Fn(u8) -> bool) -> bool {
    (min..=max).contains(&value.len()) && value.bytes().all(allowed)
}

fn base64ish(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'=')
}

/// Read a success answer.
///
/// # Errors
///
/// `MalformedResponse` for anything but a complete, well-shaped answer.
pub fn parse_assume_role(body: &[u8]) -> Result<AssumeRoleAnswer, StsFailure> {
    let field = |name: &'static str| -> Vec<&'static str> {
        let mut path = CREDENTIALS.to_vec();
        path.push(name);
        path
    };
    let paths = [
        field("AccessKeyId"),
        field("SecretAccessKey"),
        field("SessionToken"),
        field("Expiration"),
        REQUEST_ID.to_vec(),
    ];
    let wanted: Vec<&[&str]> = paths.iter().map(Vec::as_slice).collect();
    let mut found = capture(body, &wanted)?;
    let access_key_id = take(&mut found, 0)?;
    let secret_access_key = take(&mut found, 1)?;
    let session_token = take(&mut found, 2)?;
    let expiration = take(&mut found, 3)?;
    let request_id = take(&mut found, 4)?;
    let well_formed = shaped(&access_key_id, 16, 128, |b| {
        b.is_ascii_uppercase() || b.is_ascii_digit()
    }) && shaped(&secret_access_key, 16, 128, base64ish)
        && shaped(&session_token, 16, MAX_VALUE, base64ish)
        && shaped(&request_id, 1, 64, |b| {
            b.is_ascii_alphanumeric() || b == b'-'
        });
    if !well_formed {
        return Err(StsFailure::MalformedResponse);
    }
    let expiration = DateTime::parse_from_rfc3339(&expiration)
        .map_err(|_| StsFailure::MalformedResponse)?
        .with_timezone(&Utc);
    Ok(AssumeRoleAnswer {
        credentials: StsCredentials {
            access_key_id,
            secret_access_key: SecretString::from(secret_access_key),
            session_token: SecretString::from(session_token),
            expiration,
        },
        request_id,
    })
}

/// The `Code` of an `ErrorResponse`, when the body is one.
#[must_use]
pub fn error_code(body: &[u8]) -> Option<String> {
    let mut found = capture(body, &[ERROR_CODE]).ok()?;
    take(&mut found, 0)
        .ok()
        .filter(|code| shaped(code, 1, 128, |b| b.is_ascii_alphanumeric() || b == b'.'))
}

/// The stable failure for an error answer.
#[must_use]
pub fn classify(status: u16, code: Option<&str>) -> StsFailure {
    match code {
        Some("ExpiredToken" | "InvalidClientTokenId" | "SignatureDoesNotMatch") => {
            StsFailure::ExpiredSource
        }
        Some("RegionDisabledException") => StsFailure::RegionDisabled,
        Some("Throttling" | "ThrottlingException" | "RequestLimitExceeded") => {
            StsFailure::Throttled
        }
        _ if status == 429 => StsFailure::Throttled,
        _ if status >= 500 => StsFailure::Unreachable,
        _ => StsFailure::AccessDenied,
    }
}

/// Refuse an expiration in the past, or later than the duration asked for
/// allows (plus skew): either means the answer is not the one requested.
///
/// # Errors
///
/// `MalformedResponse` outside `(now, now + duration + skew]`.
pub fn check_expiration(
    expiration: DateTime<Utc>,
    now: DateTime<Utc>,
    duration_seconds: u32,
) -> Result<(), StsFailure> {
    let latest = now
        + Duration::seconds(i64::from(duration_seconds))
        + Duration::seconds(EXPIRATION_SKEW_SECONDS);
    if expiration <= now || expiration > latest {
        return Err(StsFailure::MalformedResponse);
    }
    Ok(())
}

#[cfg(test)]
#[path = "response_tests.rs"]
mod tests;
