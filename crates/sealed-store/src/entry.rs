/// Plaintext store entry: first line is the secret; remainder is freeform trailer.
/// Optional structured OTP mirrors pass-otp `otpauth://` lines in the trailer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub secret: String,
    pub trailer: String,
    pub otp: Option<crate::otp::OtpUri>,
}

impl Entry {
    pub fn parse(text: &str) -> Self {
        let mut lines = text.split_inclusive('\n');
        let first = lines.next().unwrap_or("");
        let secret = first.trim_end_matches(['\r', '\n']).to_string();
        let trailer: String = lines.collect();
        let otp = crate::otp::find_otpauth_in_trailer(&trailer);
        Self {
            secret,
            trailer,
            otp,
        }
    }

    /// Ensure trailer otpauth lines match `self.otp`, then render pass-style plaintext.
    pub fn render(&self) -> String {
        let trailer = crate::otp::sync_trailer_otp(&self.trailer, self.otp.as_ref());
        let body = Entry {
            secret: self.secret.clone(),
            trailer,
            otp: None,
        };
        body.render_raw()
    }

    fn render_raw(&self) -> String {
        if self.trailer.is_empty() {
            format!("{}\n", self.secret)
        } else if self.trailer.starts_with('\n') || self.secret.is_empty() {
            format!("{}{}", self.secret, self.trailer)
        } else {
            let mut out = String::new();
            out.push_str(&self.secret);
            out.push('\n');
            if !self.trailer.is_empty() {
                out.push('\n');
                out.push_str(self.trailer.trim_start_matches('\n'));
                if !out.ends_with('\n') {
                    out.push('\n');
                }
            }
            out
        }
    }

    pub fn with_otp(mut self, otp: Option<crate::otp::OtpUri>) -> Self {
        self.otp = otp;
        self.trailer = crate::otp::sync_trailer_otp(&self.trailer, self.otp.as_ref());
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::otp::parse_otpauth;

    #[test]
    fn entry_round_trip_preserves_secret_and_trailer() {
        let e = Entry {
            secret: "s3cr3t".into(),
            trailer: "url: https://example.com\n".into(),
            otp: None,
        };
        let parsed = Entry::parse(&e.render());
        assert_eq!(parsed.secret, "s3cr3t");
        assert!(parsed.trailer.contains("example.com"));
    }

    #[test]
    fn secret_only() {
        let e = Entry::parse("only\n");
        assert_eq!(e.secret, "only");
        assert!(e.trailer.is_empty());
        assert!(e.otp.is_none());
    }

    #[test]
    fn parses_otpauth_from_trailer() {
        let text = "password\n\nurl: https://x\notpauth://totp/Demo?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ\n"; // gitleaks:allow -- RFC fixture
        let e = Entry::parse(text);
        assert_eq!(e.secret, "password");
        assert!(e.otp.is_some());
        let rendered = e.render();
        let again = Entry::parse(&rendered);
        assert!(again.otp.is_some());
        assert_eq!(again.otp.as_ref().unwrap().uri, e.otp.as_ref().unwrap().uri);
    }

    #[test]
    fn with_otp_injects_trailer_line() {
        let otp = parse_otpauth(
            "otpauth://totp/Demo?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", // gitleaks:allow -- RFC fixture
        )
        .unwrap();
        let e = Entry {
            secret: "pw".into(),
            trailer: "login: a\n".into(),
            otp: None,
        }
        .with_otp(Some(otp));
        assert!(e.render().contains("otpauth://totp/Demo"));
        assert!(e.render().contains("login: a"));
    }
}
