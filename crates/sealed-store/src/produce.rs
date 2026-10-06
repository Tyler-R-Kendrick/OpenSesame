//! Producing the password of a stored entry (ADR 0174), the native half of the
//! facade `producePassword` in `@opensesame/vault-core`. Both read the same
//! vectors (`spec/conformance/produce-vectors.json`), so a password comes out
//! the same from the daemon's autofill, `opensesame pass show` and the app.
//!
//! An entry's first password method may keep the password, hold the root an
//! algorithm computes it from, or leave a slot in it for a pepper the person
//! keeps. This module is the only native code that opens any of that; the
//! pepper is never read, asked for or stored.

use std::sync::LazyLock;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use hkdf::Hkdf;
use serde::Deserialize;
use serde_json::Value;
use sha2::Sha256;
use zeroize::Zeroizing;

use crate::Entry;

#[derive(Deserialize)]
struct Classes {
    lower: String,
    upper: String,
    digits: String,
    symbols: String,
}

#[derive(Deserialize)]
struct Policy {
    classes: Classes,
    ambiguous: String,
}

static POLICY: LazyLock<Policy> = LazyLock::new(|| {
    serde_json::from_str(include_str!(
        "../../../spec/conformance/password-policy.json"
    ))
    .expect("spec/conformance/password-policy.json is valid")
});

const LABEL: &[u8] = b"opensesame/derived/v1";
const ROOT_BYTES: usize = 32;
const STREAM_BYTES: usize = 255 * 32;
const MAX_COUNTER: u64 = 0xffff_ffff;
const MAX_PASSWORD_LENGTH: usize = 256;
const MAX_FLOOR: usize = MAX_PASSWORD_LENGTH / 4;

/// What an entry gives with nothing from the person.
#[derive(Debug, PartialEq, Eq)]
pub enum Produced {
    /// The whole password.
    Ok(Zeroizing<String>),
    /// The password around the slot a pepper of the person's own fills.
    Slotted {
        head: Zeroizing<String>,
        tail: Zeroizing<String>,
    },
    /// Nothing kept.
    Absent,
    /// Made by an older version from a pepper or master input it asked for.
    Legacy,
}

/// Cut `password` where a Python-style position expression says a pepper goes
/// (`pepper-position.ts`): empty or `end` is after the last character; `3` and
/// `-2` insert before that index; `2:5`, `:4` and `-3:` stand in for a slice.
/// Text that is not a position cuts at the end. Characters are counted as
/// Python counts them (code points), only ASCII whitespace is dropped and `end`
/// is read in ASCII case alone, so this agrees with the TypeScript reader on
/// every expression in `spec/conformance/pepper-position-vectors.json`.
#[must_use]
pub fn split_at_pepper(password: &str, expression: &str) -> (String, String) {
    let chars: Vec<char> = password.chars().collect();
    let length = chars.len();
    let (start, stop) = match parse_position(expression) {
        Position::Insert(index) => {
            let at = clamp(index, length);
            (at, at)
        }
        Position::Replace(from, to) => {
            let start = from.map_or(0, |index| clamp(index, length));
            let stop = to.map_or(length, |index| clamp(index, length));
            (start, start.max(stop))
        }
    };
    (
        chars[..start].iter().collect(),
        chars[stop..].iter().collect(),
    )
}

enum Position {
    Insert(i64),
    Replace(Option<i64>, Option<i64>),
}

fn parse_position(expression: &str) -> Position {
    let mut text: String = expression
        .chars()
        .filter(|c| !matches!(c, ' ' | '\t' | '\n' | '\u{b}' | '\u{c}' | '\r'))
        .collect();
    if text.starts_with('[') && text.ends_with(']') && text.len() >= 2 {
        text = text[1..text.len() - 1].to_owned();
    }
    let end = Position::Insert(i64::MAX);
    if text.is_empty() || text.eq_ignore_ascii_case("end") {
        return end;
    }
    let Some((from, to)) = text.split_once(':') else {
        return integer(&text).map_or(end, Position::Insert);
    };
    let bound = |part: &str| -> Option<Option<i64>> {
        if part.is_empty() {
            Some(None)
        } else {
            integer(part).map(Some)
        }
    };
    match (bound(from), bound(to)) {
        (Some(from), Some(to)) => Position::Replace(from, to),
        _ => end,
    }
}

fn integer(text: &str) -> Option<i64> {
    let digits = text.strip_prefix(['+', '-']).unwrap_or(text);
    if digits.is_empty() || !digits.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    // A figure past 64 bits still names a place: it clamps to either end, as
    // Python's does, so it saturates rather than being refused.
    Some(text.parse().unwrap_or_else(|_| {
        if text.starts_with('-') {
            i64::MIN
        } else {
            i64::MAX
        }
    }))
}

fn clamp(index: i64, length: usize) -> usize {
    let length = i64::try_from(length).unwrap_or(i64::MAX);
    let absolute = if index < 0 {
        index.saturating_add(length)
    } else {
        index
    };
    usize::try_from(absolute.clamp(0, length)).unwrap_or(0)
}

/// Uniform integers read from a fixed byte stream, four bytes a draw.
struct Stream {
    bytes: Zeroizing<Vec<u8>>,
    at: usize,
}

impl Stream {
    fn index(&mut self, max: usize) -> Option<usize> {
        let max = u64::try_from(max).ok()?;
        let limit = (1u64 << 32) / max * max;
        loop {
            let slice = self.bytes.get(self.at..self.at + 4)?;
            self.at += 4;
            let value = u64::from(u32::from_be_bytes([slice[0], slice[1], slice[2], slice[3]]));
            if value < limit {
                return usize::try_from(value % max).ok();
            }
        }
    }
}

struct Rules {
    length: usize,
    classes: [bool; 4],
    avoid_ambiguous: bool,
    min_digits: usize,
    min_symbols: usize,
}

fn count(value: &Value) -> Option<usize> {
    let number = value.as_f64()?;
    if number.is_finite() && number >= 0.0 {
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        Some(number.floor() as usize)
    } else {
        Some(0)
    }
}

fn rules_of(value: &Value) -> Option<Rules> {
    let flag = |key: &str| value.get(key)?.as_bool();
    Some(Rules {
        length: count(value.get("length")?)?,
        classes: [
            flag("lower")?,
            flag("upper")?,
            flag("digits")?,
            flag("symbols")?,
        ],
        avoid_ambiguous: flag("avoidAmbiguous")?,
        min_digits: count(value.get("minDigits")?)?,
        min_symbols: count(value.get("minSymbols")?)?,
    })
}

/// The pools the rules draw from: the characters and the floor of each class.
fn pools(rules: &Rules) -> Option<Vec<(Vec<char>, usize)>> {
    let classes = &POLICY.classes;
    let sets = [
        &classes.lower,
        &classes.upper,
        &classes.digits,
        &classes.symbols,
    ];
    let asked = [0, 0, rules.min_digits, rules.min_symbols];
    let mut out = Vec::new();
    for (index, set) in sets.iter().enumerate() {
        if !rules.classes[index] {
            continue;
        }
        let chars: Vec<char> = set
            .chars()
            .filter(|c| !rules.avoid_ambiguous || !POLICY.ambiguous.contains(*c))
            .collect();
        if chars.is_empty() {
            continue;
        }
        out.push((chars, MAX_FLOOR.min(asked[index].max(1))));
    }
    (!out.is_empty()).then_some(out)
}

/// The password for `counter` under `rules` from a root in base64, as
/// `deriveCharacters` computes it.
fn derive(root_b64: &str, counter: u64, rules: &Rules) -> Option<Zeroizing<String>> {
    if counter > MAX_COUNTER {
        return None;
    }
    let root = Zeroizing::new(STANDARD.decode(root_b64).ok()?);
    if root.len() != ROOT_BYTES {
        return None;
    }
    let pools = pools(rules)?;
    let mut stream = Zeroizing::new(vec![0u8; STREAM_BYTES]);
    let info = u32::try_from(counter).ok()?.to_be_bytes();
    Hkdf::<Sha256>::new(Some(LABEL), &root)
        .expand(&info, &mut stream)
        .ok()?;
    let mut source = Stream {
        bytes: stream,
        at: 0,
    };
    let union: Vec<char> = pools.iter().flat_map(|(chars, _)| chars.clone()).collect();
    let floors: usize = pools.iter().map(|(_, floor)| floor).sum();
    let length = rules.length.min(MAX_PASSWORD_LENGTH).max(floors);
    let mut out: Vec<char> = Vec::with_capacity(length);
    for (chars, floor) in &pools {
        for _ in 0..*floor {
            out.push(chars[source.index(chars.len())?]);
        }
    }
    while out.len() < length {
        out.push(union[source.index(union.len())?]);
    }
    for i in (1..out.len()).rev() {
        let j = source.index(i + 1)?;
        out.swap(i, j);
    }
    Some(Zeroizing::new(out.into_iter().collect()))
}

/// The JSON object a trailer carries after its `otpauth://` lines, if any.
fn trailer_json(trailer: &str) -> Option<Value> {
    let kept: Vec<&str> = trailer
        .lines()
        .filter(|line| {
            !line
                .trim_start()
                .to_ascii_lowercase()
                .starts_with("otpauth://")
        })
        .collect();
    let text = kept.join("\n");
    let text = text.trim();
    text.starts_with('{')
        .then(|| serde_json::from_str(text).ok())
        .flatten()
}

fn is_password(method: &Value) -> bool {
    method.get("type").and_then(Value::as_str) == Some("password")
}

/// The password method an entry holds: an account's first, or the one method of
/// a credential kept on its own (ADR 0178).
fn first_password(meta: &Value) -> Option<&Value> {
    let values = meta.get("values")?;
    if let Some(method) = values.get("method").filter(|method| is_password(method)) {
        return Some(method);
    }
    values
        .get("methods")?
        .as_array()?
        .iter()
        .find(|method| is_password(method))
}

fn base_password(method: &Value, line_one: &str) -> Option<Zeroizing<String>> {
    let generator = method.get("generator");
    let id = generator
        .and_then(|g| g.get("id"))
        .and_then(Value::as_str)
        .unwrap_or("manual");
    let secret = method.get("secret").and_then(Value::as_str).unwrap_or("");
    match id {
        "derived" => {
            let generator = generator?;
            let rules = rules_of(generator.get("rules")?)?;
            let counter = generator.get("counter")?.as_u64()?;
            if secret.is_empty() {
                return Some(Zeroizing::new(String::new()));
            }
            derive(secret, counter, &rules)
        }
        _ => Some(Zeroizing::new(if secret.is_empty() {
            line_one.to_owned()
        } else {
            secret.to_owned()
        })),
    }
}

/// Produce an entry's password. An entry that says nothing about methods is a
/// plain `pass` entry: line one is the password.
#[must_use]
pub fn produce_entry(entry: &Entry) -> Produced {
    let meta = trailer_json(&entry.trailer);
    let Some(method) = meta.as_ref().and_then(first_password) else {
        return if entry.secret.is_empty() {
            Produced::Absent
        } else {
            Produced::Ok(Zeroizing::new(entry.secret.clone()))
        };
    };
    let id = method
        .get("generator")
        .and_then(|g| g.get("id"))
        .and_then(Value::as_str);
    if id == Some("sphinx") || method.get("sealed").is_some_and(|sealed| !sealed.is_null()) {
        return Produced::Legacy;
    }
    let Some(password) = base_password(method, &entry.secret) else {
        return Produced::Absent;
    };
    if password.is_empty() {
        return Produced::Absent;
    }
    if method.get("pepper").and_then(Value::as_bool) != Some(true) {
        return Produced::Ok(password);
    }
    let at = method.get("pepperAt").and_then(Value::as_str).unwrap_or("");
    let (head, tail) = split_at_pepper(&password, at);
    Produced::Slotted {
        head: Zeroizing::new(head),
        tail: Zeroizing::new(tail),
    }
}

#[cfg(test)]
#[path = "produce_tests.rs"]
mod tests;
