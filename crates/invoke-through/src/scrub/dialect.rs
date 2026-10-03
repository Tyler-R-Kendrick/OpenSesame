//! Finding a credential under one layer of text encoding, however the
//! encoder chose to spell each character.
//!
//! A fixed list of encoded forms misses every encoder that spells one
//! character differently: `encodeURIComponent` leaves `!'()*~` bare where the
//! form serializer escapes them, Django writes an apostrophe `&#x27;` and Go
//! `&#39;`, Go's JSON escapes `&` as `\u0026`, and nothing stops a page from
//! mixing hex cases or escaping every character. So each dialect matches the
//! credential one unit at a time, accepting at every position any spelling
//! that decodes to that unit — the literal, or any escape the dialect has for
//! it — and a match is the longest run that decodes to the whole credential.
//!
//! Matching is a small NFA simulation: the set of haystack positions reachable
//! after each unit. A spelling whose escape could also be read literally
//! (`%25` for a credential holding `%2`) keeps both readings alive.
//!
//! The same matcher as rotation-web's login scrub
//! (`crates/rotation-web/src/login_surrogate/scrub/dialect.rs`), repeated
//! rather than shared: that crate is the runner's contract and takes no
//! dependency on the broker, and this one takes none on the runner. A change
//! to either is made to both.

/// One layer of encoding a response or DOM read can put a credential in.
#[derive(Clone, Copy, Debug)]
pub(super) enum Dialect {
    /// Percent-encoding in any hex case, any subset of bytes escaped, and `+`
    /// for a space: RFC 3986, the form serializer, `encodeURIComponent`.
    Percent,
    /// A JSON string body: `\uXXXX` in any hex case (a surrogate pair for an
    /// astral character), the two-character escapes, or the character itself.
    Json,
    /// HTML text or attribute: the five named references in any case,
    /// decimal and hex numeric references with or without the `;`, or the
    /// character itself.
    Html,
}

pub(super) const ALL: [Dialect; 3] = [Dialect::Percent, Dialect::Json, Dialect::Html];

/// `haystack` with every match of `credential` replaced by `marker`, or
/// `None` when there is none.
pub(super) fn replace(
    dialect: Dialect,
    haystack: &[u8],
    credential: &str,
    marker: &[u8],
) -> Option<Vec<u8>> {
    if credential.is_empty() {
        return None;
    }
    let mut out: Option<Vec<u8>> = None;
    let mut frontier = Vec::new();
    let mut next = Vec::new();
    let (mut copied, mut at) = (0, 0);
    while at < haystack.len() {
        match longest(dialect, haystack, at, credential, &mut frontier, &mut next) {
            Some(end) => {
                let buf = out.get_or_insert_with(|| Vec::with_capacity(haystack.len()));
                buf.extend_from_slice(&haystack[copied..at]);
                buf.extend_from_slice(marker);
                copied = end;
                at = end;
            }
            None => at += 1,
        }
    }
    let mut buf = out?;
    buf.extend_from_slice(&haystack[copied..]);
    Some(buf)
}

/// The end of the longest spelling of `credential` starting at `start`.
fn longest(
    dialect: Dialect,
    haystack: &[u8],
    start: usize,
    credential: &str,
    frontier: &mut Vec<usize>,
    next: &mut Vec<usize>,
) -> Option<usize> {
    frontier.clear();
    frontier.push(start);
    let mut advance = |step: &dyn Fn(usize, &mut Vec<usize>)| {
        next.clear();
        for &at in frontier.iter() {
            step(at, next);
        }
        next.sort_unstable();
        next.dedup();
        std::mem::swap(frontier, next);
        !frontier.is_empty()
    };
    let matched = match dialect {
        Dialect::Percent => credential
            .bytes()
            .all(|byte| advance(&|at, out| percent(haystack, at, byte, out))),
        Dialect::Json => credential
            .chars()
            .all(|c| advance(&|at, out| json(haystack, at, c, out))),
        Dialect::Html => credential
            .chars()
            .all(|c| advance(&|at, out| html(haystack, at, c, out))),
    };
    if matched {
        frontier.last().copied()
    } else {
        None
    }
}

/// Every position after one spelling of `c` in its literal UTF-8 at `at`.
fn literal(haystack: &[u8], at: usize, c: char, out: &mut Vec<usize>) {
    let mut utf8 = [0u8; 4];
    let bytes = c.encode_utf8(&mut utf8).as_bytes();
    if haystack.get(at..at + bytes.len()) == Some(bytes) {
        out.push(at + bytes.len());
    }
}

fn percent(haystack: &[u8], at: usize, byte: u8, out: &mut Vec<usize>) {
    match haystack.get(at) {
        Some(&found) if found == byte => out.push(at + 1),
        Some(b'+') if byte == b' ' => out.push(at + 1),
        _ => {}
    }
    if haystack.get(at) == Some(&b'%') && hex_run(haystack, at + 1, 2, 2) == Some((byte.into(), 2))
    {
        out.push(at + 3);
    }
}

fn json(haystack: &[u8], at: usize, c: char, out: &mut Vec<usize>) {
    literal(haystack, at, c, out);
    let short = match c {
        '"' => Some(b'"'),
        '\\' => Some(b'\\'),
        '/' => Some(b'/'),
        '\u{8}' => Some(b'b'),
        '\u{c}' => Some(b'f'),
        '\n' => Some(b'n'),
        '\r' => Some(b'r'),
        '\t' => Some(b't'),
        _ => None,
    };
    if let Some(letter) = short {
        if haystack.get(at..at + 2) == Some(&[b'\\', letter]) {
            out.push(at + 2);
        }
    }
    let mut units = [0u16; 2];
    let mut end = at;
    for unit in c.encode_utf16(&mut units) {
        if haystack.get(end..end + 2) != Some(b"\\u")
            || hex_run(haystack, end + 2, 4, 4) != Some((u32::from(*unit), 4))
        {
            return;
        }
        end += 6;
    }
    out.push(end);
}

const NAMED: [(char, &[u8]); 5] = [
    ('&', b"amp"),
    ('<', b"lt"),
    ('>', b"gt"),
    ('"', b"quot"),
    ('\'', b"apos"),
];

fn html(haystack: &[u8], at: usize, c: char, out: &mut Vec<usize>) {
    literal(haystack, at, c, out);
    if haystack.get(at) != Some(&b'&') {
        return;
    }
    let reference = at + 1;
    for (named, name) in NAMED {
        let spelled = haystack
            .get(reference..reference + name.len())
            .is_some_and(|found| found.eq_ignore_ascii_case(name));
        if named == c && spelled {
            push_with_semicolon(haystack, reference + name.len(), out);
        }
    }
    if haystack.get(reference) != Some(&b'#') {
        return;
    }
    let digits = reference + 1;
    let numeric = match haystack.get(digits) {
        Some(b'x' | b'X') => hex_run(haystack, digits + 1, 1, usize::MAX).map(|(v, n)| (v, n + 1)),
        _ => decimal_run(haystack, digits),
    };
    if let Some((value, len)) = numeric {
        if value == u32::from(c) {
            push_with_semicolon(haystack, digits + len, out);
        }
    }
}

/// A reference ends at `end`, or one past it when a `;` closes it. Both are
/// kept: the credential's next character may itself be a `;`.
fn push_with_semicolon(haystack: &[u8], end: usize, out: &mut Vec<usize>) {
    out.push(end);
    if haystack.get(end) == Some(&b';') {
        out.push(end + 1);
    }
}

/// The value of the maximal run of hex digits at `at`, of `min..=max`
/// digits, and its length. Saturates rather than overflowing: a value past
/// `char::MAX` matches no character.
fn hex_run(haystack: &[u8], at: usize, min: usize, max: usize) -> Option<(u32, usize)> {
    run(haystack, at, min, max, 16)
}

fn decimal_run(haystack: &[u8], at: usize) -> Option<(u32, usize)> {
    run(haystack, at, 1, usize::MAX, 10)
}

fn run(haystack: &[u8], at: usize, min: usize, max: usize, radix: u32) -> Option<(u32, usize)> {
    let rest = haystack.get(at..)?;
    let len = rest
        .iter()
        .take(max)
        .take_while(|b| char::from(**b).is_digit(radix))
        .count();
    if len < min {
        return None;
    }
    let value = rest[..len].iter().fold(0u32, |value, b| {
        value
            .saturating_mul(radix)
            .saturating_add(char::from(*b).to_digit(radix).unwrap_or_default())
    });
    Some((value, len))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn found(dialect: Dialect, haystack: &str, credential: &str) -> Option<String> {
        replace(dialect, haystack.as_bytes(), credential, b"#")
            .map(|out| String::from_utf8(out).unwrap())
    }

    #[test]
    fn an_escape_that_also_reads_literally_keeps_both_readings() {
        // "%25" is "%" escaped, or "%" then "25" read literally; the longest
        // reading is the one replaced.
        assert_eq!(
            found(Dialect::Percent, "x%252y", "%2").as_deref(),
            Some("x#y")
        );
        assert_eq!(
            found(Dialect::Percent, "x%252y", "%252").as_deref(),
            Some("x#y")
        );
        assert_eq!(
            found(Dialect::Percent, "x%2y", "%2").as_deref(),
            Some("x#y")
        );
        assert_eq!(
            found(Dialect::Percent, "x%25y", "%").as_deref(),
            Some("x#y")
        );
    }

    #[test]
    fn a_numeric_reference_is_read_to_its_last_digit() {
        // "&#391" is U+0187, never an apostrophe followed by "1".
        assert_eq!(found(Dialect::Html, "&#391", "'1"), None);
        assert_eq!(found(Dialect::Html, "&#0039;1", "'1").as_deref(), Some("#"));
    }

    #[test]
    fn an_astral_character_needs_both_halves_of_its_pair() {
        let credential = "a\u{1F511}";
        assert_eq!(
            found(Dialect::Json, r"a\uD83D\uDD11!", credential).as_deref(),
            Some("#!")
        );
        assert_eq!(found(Dialect::Json, r"a\uD83D!", credential), None);
    }

    #[test]
    fn a_longer_spelling_is_replaced_whole() {
        // The trailing ";" is part of the reference, not left behind.
        assert_eq!(
            found(Dialect::Html, "&amp;&lt;", "&<").as_deref(),
            Some("#")
        );
    }
}
