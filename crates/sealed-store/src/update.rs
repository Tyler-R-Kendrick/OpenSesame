//! pass-update style secret rotation helpers.

use regex::Regex;

use crate::entry::Entry;
use crate::generate::generate_password;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdateMode {
    /// Replace first line only; keep trailer/OTP.
    FirstLine,
    /// Replace entire body (secret + trailer); OTP cleared unless re-supplied.
    Multiline,
}

#[derive(Debug, Clone)]
pub struct UpdateOptions {
    pub mode: UpdateMode,
    pub length: usize,
    pub auto_length: bool,
    pub symbols: bool,
    pub include: Option<Regex>,
    pub exclude: Option<Regex>,
}

impl Default for UpdateOptions {
    fn default() -> Self {
        Self {
            mode: UpdateMode::FirstLine,
            length: 32,
            auto_length: false,
            symbols: true,
            include: None,
            exclude: None,
        }
    }
}

/// Returns None when include/exclude say to skip this entry.
pub fn apply_secret_update(
    entry: &Entry,
    new_secret: Option<String>,
    opts: &UpdateOptions,
) -> Option<Entry> {
    if let Some(re) = &opts.exclude {
        if re.is_match(&entry.secret) {
            return None;
        }
    }
    if let Some(re) = &opts.include {
        if !re.is_match(&entry.secret) {
            return None;
        }
    }

    let length = if opts.auto_length {
        entry.secret.chars().count().max(1)
    } else {
        opts.length.max(1)
    };
    let secret = new_secret.unwrap_or_else(|| generate_password(length, opts.symbols));

    match opts.mode {
        UpdateMode::FirstLine => Some(Entry {
            secret,
            trailer: entry.trailer.clone(),
            otp: entry.otp.clone(),
        }),
        UpdateMode::Multiline => Some(Entry {
            secret,
            trailer: String::new(),
            otp: None,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::otp::parse_otpauth;

    #[test]
    fn first_line_preserves_trailer_and_otp() {
        let otp = parse_otpauth(
            "otpauth://totp/Demo?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
        )
        .unwrap();
        let entry = Entry {
            secret: "oldpass".into(),
            trailer: "login: a\n".into(),
            otp: Some(otp.clone()),
        };
        let next = apply_secret_update(&entry, Some("newpass".into()), &UpdateOptions::default())
            .unwrap();
        assert_eq!(next.secret, "newpass");
        assert!(next.trailer.contains("login: a") || next.render().contains("login: a"));
        assert!(next.otp.is_some());
    }

    #[test]
    fn exclude_regex_skips() {
        let entry = Entry {
            secret: "1234".into(),
            trailer: String::new(),
            otp: None,
        };
        let opts = UpdateOptions {
            exclude: Some(Regex::new(r"^[0-9]+$").unwrap()),
            ..Default::default()
        };
        assert!(apply_secret_update(&entry, Some("x".into()), &opts).is_none());
    }

    #[test]
    fn auto_length_matches_previous() {
        let entry = Entry {
            secret: "abcdefghij".into(),
            trailer: String::new(),
            otp: None,
        };
        let opts = UpdateOptions {
            auto_length: true,
            symbols: false,
            ..Default::default()
        };
        let next = apply_secret_update(&entry, None, &opts).unwrap();
        assert_eq!(next.secret.len(), 10);
    }
}
