//! Strict RFC 3339 timestamps shared by every transport DTO.
//!
//! Both planes must read the same string the same way, so the accepted
//! grammar is narrower than what `chrono` or V8 would tolerate on their own:
//! `YYYY-MM-DDTHH:MM:SS[.fff](Z|±HH:MM)`, uppercase `T`/`Z`, at most three
//! fractional digits, no leap second, and always an offset. The canonical
//! form is UTC with millisecond precision, which is exactly what a JavaScript
//! `Date` produces, so a round trip through either plane is byte-identical.

use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Deserializer, Serializer};

/// Parse a strict RFC 3339 timestamp.
///
/// # Errors
///
/// Returns the offending input's classification when it is not in the
/// canonical grammar or is not a real calendar instant.
pub fn parse(input: &str) -> Result<DateTime<Utc>, TimestampError> {
    if !grammar_ok(input) {
        return Err(TimestampError::Grammar);
    }
    let parsed = DateTime::parse_from_rfc3339(input).map_err(|_| TimestampError::Calendar)?;
    Ok(parsed.with_timezone(&Utc))
}

/// Canonical form: UTC, millisecond precision, `Z` suffix.
#[must_use]
pub fn canonical(value: &DateTime<Utc>) -> String {
    value.to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// Why a timestamp string was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TimestampError {
    /// Not in the strict grammar (missing offset, lowercase, too much
    /// precision, leap second, wrong shape).
    Grammar,
    /// Grammar-valid but not a real instant (month 13, February 30, ...).
    Calendar,
}

impl std::fmt::Display for TimestampError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Grammar => "timestamp is not strict RFC 3339 with an offset",
            Self::Calendar => "timestamp is not a real calendar instant",
        })
    }
}

fn digits(bytes: &[u8], from: usize, count: usize) -> bool {
    bytes.len() >= from + count && bytes[from..from + count].iter().all(u8::is_ascii_digit)
}

fn grammar_ok(input: &str) -> bool {
    let b = input.as_bytes();
    // YYYY-MM-DDTHH:MM:SS is 19 bytes; the offset adds 1 or 6.
    if b.len() < 20 || b.len() > 29 {
        return false;
    }
    let date_time_ok = digits(b, 0, 4)
        && b[4] == b'-'
        && digits(b, 5, 2)
        && b[7] == b'-'
        && digits(b, 8, 2)
        && b[10] == b'T'
        && digits(b, 11, 2)
        && b[13] == b':'
        && digits(b, 14, 2)
        && b[16] == b':'
        && digits(b, 17, 2);
    if !date_time_ok || &b[17..19] == b"60" {
        return false;
    }
    let mut at = 19;
    if b[at] == b'.' {
        let start = at + 1;
        let mut end = start;
        while end < b.len() && b[end].is_ascii_digit() {
            end += 1;
        }
        if end == start || end - start > 3 {
            return false;
        }
        at = end;
    }
    match b.get(at) {
        Some(b'Z') => at + 1 == b.len(),
        Some(b'+' | b'-') => {
            at + 6 == b.len() && digits(b, at + 1, 2) && b[at + 3] == b':' && digits(b, at + 4, 2)
        }
        _ => false,
    }
}

/// `#[serde(with = "timestamp")]` for a required `DateTime<Utc>` field.
///
/// # Errors
///
/// Serde error when the string is not strict RFC 3339.
pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<DateTime<Utc>, D::Error> {
    let raw = String::deserialize(d)?;
    parse(&raw).map_err(serde::de::Error::custom)
}

/// Serialize in canonical form.
///
/// # Errors
///
/// Never, in practice; the signature is serde's.
pub fn serialize<S: Serializer>(value: &DateTime<Utc>, s: S) -> Result<S::Ok, S::Error> {
    s.serialize_str(&canonical(value))
}

/// `#[serde(with = "timestamp::option")]` for an `Option<DateTime<Utc>>`.
pub mod option {
    use super::{canonical, parse};
    use chrono::{DateTime, Utc};
    use serde::{Deserialize, Deserializer, Serializer};

    /// # Errors
    ///
    /// Serde error when a present string is not strict RFC 3339.
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Option<DateTime<Utc>>, D::Error> {
        match Option::<String>::deserialize(d)? {
            None => Ok(None),
            Some(raw) => parse(&raw).map(Some).map_err(serde::de::Error::custom),
        }
    }

    /// # Errors
    ///
    /// Never, in practice; the signature is serde's.
    pub fn serialize<S: Serializer>(
        value: &Option<DateTime<Utc>>,
        s: S,
    ) -> Result<S::Ok, S::Error> {
        match value {
            None => s.serialize_none(),
            Some(v) => s.serialize_str(&canonical(v)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{canonical, parse, TimestampError};

    #[test]
    fn accepts_canonical_and_offset_forms() {
        for s in [
            "2026-09-22T10:00:00Z",
            "2026-09-22T10:00:00.5Z",
            "2026-09-22T10:00:00.250Z",
            "2026-09-22T15:30:00+05:30",
            "2026-09-22T05:00:00-05:00",
        ] {
            assert!(parse(s).is_ok(), "{s}");
        }
        let v = parse("2026-09-22T15:30:00+05:30").expect("parses");
        assert_eq!(canonical(&v), "2026-09-22T10:00:00.000Z");
    }

    #[test]
    fn rejects_ambiguous_or_lenient_forms() {
        for (s, why) in [
            ("2026-09-22T10:00:00", TimestampError::Grammar),
            ("2026-09-22 10:00:00Z", TimestampError::Grammar),
            ("2026-09-22t10:00:00z", TimestampError::Grammar),
            ("2026-09-22T10:00:00.1234Z", TimestampError::Grammar),
            ("2026-09-22T10:00:00.Z", TimestampError::Grammar),
            ("2026-09-22T23:59:60Z", TimestampError::Grammar),
            ("2026-09-22T10:00:00+0530", TimestampError::Grammar),
            ("2026-09-22", TimestampError::Grammar),
            ("1758535200", TimestampError::Grammar),
            ("", TimestampError::Grammar),
            ("2026-02-30T00:00:00Z", TimestampError::Calendar),
            ("2026-13-01T00:00:00Z", TimestampError::Calendar),
            ("2026-01-01T24:00:00Z", TimestampError::Calendar),
            ("2026-01-01T00:60:00Z", TimestampError::Calendar),
            ("2026-01-01T00:00:00+24:00", TimestampError::Calendar),
        ] {
            assert_eq!(parse(s), Err(why), "{s}");
        }
    }
}
