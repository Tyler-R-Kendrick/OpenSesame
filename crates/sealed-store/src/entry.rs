/// Plaintext store entry: first line is the secret; remainder is freeform trailer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub secret: String,
    pub trailer: String,
}

impl Entry {
    pub fn parse(text: &str) -> Self {
        let mut lines = text.split_inclusive('\n');
        let first = lines.next().unwrap_or("");
        let secret = first.trim_end_matches(['\r', '\n']).to_string();
        let trailer: String = lines.collect();
        Self { secret, trailer }
    }

    pub fn render(&self) -> String {
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
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entry_round_trip_preserves_secret_and_trailer() {
        let e = Entry {
            secret: "s3cr3t".into(),
            trailer: "url: https://example.com\n".into(),
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
    }
}
