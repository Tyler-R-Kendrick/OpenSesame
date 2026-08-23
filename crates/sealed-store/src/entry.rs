/// Plaintext store entry: first line is the secret; remainder is freeform trailer.
/// Optional structured OTP mirrors pass-otp `otpauth://` lines in the trailer.
///
/// `parse` and `render` are exact inverses: `parse(e.render()) == e` for every
/// `Entry` whose `secret` holds no newline (the format reserves line one for it),
/// and `render(Entry::parse(t)) == t` for every `t`. Keep that property — the
/// store is git-backed, so a render that is not a fixed point both churns diffs
/// and, when the secret is empty, silently promotes a trailer line to the secret.
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
        Entry {
            secret: self.secret.clone(),
            trailer,
            otp: None,
        }
        .render_raw()
    }

    /// Line one is the secret; everything after the terminator is the trailer
    /// verbatim. Emitting the terminator unconditionally is what keeps an empty
    /// secret from swallowing the first trailer line on the next parse, and
    /// what keeps a trailer's own leading blank line stable across rewrites.
    fn render_raw(&self) -> String {
        format!("{}\n{}", self.secret, self.trailer)
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

    /// `parse` after `render` must return the entry unchanged, and rendering the
    /// result again must be byte-identical — one pass and every later pass.
    ///
    /// Canonical trailers only: empty, or newline-terminated. A trailer missing
    /// its final newline gains one on the first render (see the test below), so
    /// it converges a pass later rather than immediately.
    fn assert_fixed_point(secret: &str, trailer: &str) {
        let e = Entry {
            secret: secret.into(),
            trailer: trailer.into(),
            otp: None,
        };
        let once = e.render();
        let parsed = Entry::parse(&once);
        assert_eq!(parsed.secret, e.secret, "secret drifted for {once:?}");
        assert_eq!(parsed.trailer, e.trailer, "trailer drifted for {once:?}");
        assert_eq!(parsed.render(), once, "render not stable for {once:?}");
    }

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

    /// Regression: an entry with no password used to render as the bare trailer,
    /// so the next parse promoted `url: x` to the secret and dropped the line.
    #[test]
    fn empty_secret_does_not_swallow_the_first_trailer_line() {
        let e = Entry {
            secret: String::new(),
            trailer: "url: x\nlogin: a\n".into(),
            otp: None,
        };
        let parsed = Entry::parse(&e.render());
        assert_eq!(parsed.secret, "");
        assert_eq!(parsed.trailer, "url: x\nlogin: a\n");
    }

    /// Regression: rendering used to insert a blank separator that the next parse
    /// folded back in, so a git-backed store saw the line flap in and out forever.
    #[test]
    fn rewriting_an_entry_is_byte_stable() {
        let first = Entry {
            secret: "pw".into(),
            trailer: "url: x\n".into(),
            otp: None,
        }
        .render();
        let second = Entry::parse(&first).render();
        let third = Entry::parse(&second).render();
        assert_eq!(first, second);
        assert_eq!(second, third);
    }

    #[test]
    fn fixed_point_holds_across_entry_shapes() {
        assert_fixed_point("pw", "");
        assert_fixed_point("pw", "url: x\n");
        assert_fixed_point("pw", "\nurl: x\n");
        assert_fixed_point("pw", "\n\nurl: x\n");
        assert_fixed_point("", "");
        assert_fixed_point("", "url: x\n");
        assert_fixed_point("", "\nurl: x\n");
        assert_fixed_point("", "login: a\nurl: x\n");
    }

    /// A trailer with no final newline gains one on the first render, then holds
    /// still. The normalization is intended — store files are newline-terminated —
    /// so what matters is that it happens once and never churns after that.
    #[test]
    fn trailer_without_a_final_newline_normalizes_once_then_holds() {
        let e = Entry {
            secret: "pw".into(),
            trailer: "url: x".into(),
            otp: None,
        };
        let first = e.render();
        let parsed = Entry::parse(&first);
        assert_eq!(parsed.secret, "pw");
        assert_eq!(parsed.trailer, "url: x\n");
        assert_eq!(parsed.render(), first);
    }

    /// A trailer that already opens with a blank line keeps it; the pass-style
    /// `secret\n\nmetadata` layout must survive a rewrite untouched.
    #[test]
    fn blank_separator_in_the_trailer_survives_a_rewrite() {
        let text = "pw\n\nurl: x\n";
        let parsed = Entry::parse(text);
        assert_eq!(parsed.secret, "pw");
        assert_eq!(parsed.trailer, "\nurl: x\n");
        assert_eq!(parsed.render(), text);
    }
}
