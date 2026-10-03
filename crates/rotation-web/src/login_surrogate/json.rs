//! `application/json`: parse, place, re-serialize.
//!
//! The body is parsed into a tree that keeps every member in order,
//! duplicates included — a map would keep one of two `"password"` keys and
//! hide the second copy. Every key and string is looked at decoded, so a
//! surrogate written with `\u` escapes is found where it is. The substitution
//! site is a string member of the top-level object and nowhere else: not a
//! nested object, not an array, not a key.
//!
//! The body is re-serialized compactly with the credential as a JSON string,
//! so a secret holding `"` or `\` is escaped by the serializer rather than
//! breaking out of its string. Members keep their order and duplicates; what
//! re-serialization does not keep is insignificant whitespace. It also does
//! not keep the spelling of a number, and a different spelling can be a
//! different value (an integer past `u64` becomes a float), so a body holding
//! any number that would not come back as written is refused as unsupported
//! ([`super::json_numbers`]) and the login falls back to CDP fill.

use std::fmt;

use serde::de::{Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use serde::ser::{Serialize, SerializeMap, SerializeSeq, Serializer};
use zeroize::Zeroizing;

use super::outcome::{Refusal, RefusalCode};
use super::sighting::count;

enum Node {
    Null,
    Bool(bool),
    Number(serde_json::Number),
    String(String),
    Array(Vec<Node>),
    Object(Vec<(String, Node)>),
}

impl Node {
    /// Surrogate-shaped runs in every key and string beneath this node.
    fn sightings(&self) -> usize {
        match self {
            Self::String(text) => count(text.as_bytes()),
            Self::Array(items) => items.iter().map(Self::sightings).sum(),
            Self::Object(members) => members
                .iter()
                .map(|(key, value)| count(key.as_bytes()) + value.sightings())
                .sum(),
            Self::Null | Self::Bool(_) | Self::Number(_) => 0,
        }
    }
}

/// `body` with the credential as the value of top-level `field`.
pub(super) fn substitute(
    body: &[u8],
    field: &str,
    surrogate: &str,
    credential: &str,
) -> Result<Zeroizing<Vec<u8>>, Refusal> {
    let root: Node = serde_json::from_slice(body)
        .map_err(|_| Refusal::new(RefusalCode::Unsupported, "json-malformed"))?;
    let total = root.sightings();
    if total == 0 {
        return Err(Refusal::new(RefusalCode::Absent, "json"));
    }
    let Node::Object(members) = &root else {
        let detail = if matches!(root, Node::Array(_)) {
            "json-array"
        } else {
            "json"
        };
        return Err(Refusal::new(RefusalCode::Misplaced, detail));
    };
    if let Some(detail) = stray(members) {
        return Err(Refusal::new(RefusalCode::Misplaced, detail));
    }
    let mut named = members.iter().enumerate().filter(|(_, (k, _))| k == field);
    let (site, value) = match (named.next(), named.next()) {
        (Some((index, (_, value))), None) => (index, value),
        (None, _) => return Err(Refusal::new(RefusalCode::Misplaced, "json-field")),
        (Some(_), Some(_)) => return Err(Refusal::new(RefusalCode::Misplaced, "json-repeated")),
    };
    if total != 1 || !matches!(value, Node::String(text) if text == surrogate) {
        return Err(Refusal::new(RefusalCode::Misplaced, "json-field"));
    }
    if !super::json_numbers::round_trip(body) {
        return Err(Refusal::new(RefusalCode::Unsupported, "json-number"));
    }
    let placed = Placed {
        members,
        site,
        credential,
    };
    // Measured first and allocated exactly, so the buffer never reallocates
    // and strands a copy of the credential in memory nobody zeroes.
    let failed = |_| Refusal::new(RefusalCode::Unsupported, "json-serialize");
    let mut measure = Measure(0);
    serde_json::to_writer(&mut measure, &placed).map_err(failed)?;
    let mut out = Zeroizing::new(Vec::with_capacity(measure.0));
    serde_json::to_writer(&mut *out, &placed).map_err(failed)?;
    Ok(out)
}

/// A writer that keeps nothing and counts what passed through it.
struct Measure(usize);

impl std::io::Write for Measure {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0 += bytes.len();
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// Whether any key or string in `body`, decoded, holds a surrogate. `false`
/// for a body that is not JSON at all.
pub(super) fn carries(body: &[u8]) -> bool {
    serde_json::from_slice::<Node>(body).is_ok_and(|root| root.sightings() > 0)
}

/// A surrogate in a key, an array or a nested object — never a substitution
/// site, whatever else the body holds. `None` when every sighting is in a
/// top-level string value.
fn stray(members: &[(String, Node)]) -> Option<&'static str> {
    for (key, value) in members {
        if count(key.as_bytes()) > 0 {
            return Some("json-key");
        }
        match value {
            Node::Array(_) if value.sightings() > 0 => return Some("json-array"),
            Node::Object(_) if value.sightings() > 0 => return Some("json-nested"),
            _ => {}
        }
    }
    None
}

/// The top-level object with the credential written at `site`.
struct Placed<'a> {
    members: &'a [(String, Node)],
    site: usize,
    credential: &'a str,
}

impl Serialize for Placed<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(self.members.len()))?;
        for (index, (key, value)) in self.members.iter().enumerate() {
            if index == self.site {
                map.serialize_entry(key, self.credential)?;
            } else {
                map.serialize_entry(key, value)?;
            }
        }
        map.end()
    }
}

impl Serialize for Node {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Null => serializer.serialize_unit(),
            Self::Bool(value) => serializer.serialize_bool(*value),
            Self::Number(number) => number.serialize(serializer),
            Self::String(text) => serializer.serialize_str(text),
            Self::Array(items) => {
                let mut seq = serializer.serialize_seq(Some(items.len()))?;
                for item in items {
                    seq.serialize_element(item)?;
                }
                seq.end()
            }
            Self::Object(members) => {
                let mut map = serializer.serialize_map(Some(members.len()))?;
                for (key, value) in members {
                    map.serialize_entry(key, value)?;
                }
                map.end()
            }
        }
    }
}

impl<'de> Deserialize<'de> for Node {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_any(NodeVisitor)
    }
}

struct NodeVisitor;

impl<'de> Visitor<'de> for NodeVisitor {
    type Value = Node;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("a JSON value")
    }

    fn visit_unit<E>(self) -> Result<Node, E> {
        Ok(Node::Null)
    }

    fn visit_bool<E>(self, value: bool) -> Result<Node, E> {
        Ok(Node::Bool(value))
    }

    fn visit_i64<E>(self, value: i64) -> Result<Node, E> {
        Ok(Node::Number(value.into()))
    }

    fn visit_u64<E>(self, value: u64) -> Result<Node, E> {
        Ok(Node::Number(value.into()))
    }

    fn visit_f64<E: serde::de::Error>(self, value: f64) -> Result<Node, E> {
        serde_json::Number::from_f64(value)
            .map(Node::Number)
            .ok_or_else(|| E::custom("non-finite number"))
    }

    fn visit_str<E>(self, value: &str) -> Result<Node, E> {
        Ok(Node::String(value.to_string()))
    }

    fn visit_string<E>(self, value: String) -> Result<Node, E> {
        Ok(Node::String(value))
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Node, A::Error> {
        let mut items = Vec::new();
        while let Some(item) = seq.next_element()? {
            items.push(item);
        }
        Ok(Node::Array(items))
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Node, A::Error> {
        let mut members = Vec::new();
        while let Some(member) = map.next_entry::<String, Node>()? {
            members.push(member);
        }
        Ok(Node::Object(members))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const S: &str = "osr_0123456789abcdef0123456789abcdef";

    #[test]
    fn members_keep_their_order_and_types() {
        let body = format!(r#"{{"z":1,"user":"a","password":"{S}","keep":[true,null,-2]}}"#);
        let out = substitute(body.as_bytes(), "password", S, "x").unwrap();
        assert_eq!(
            std::str::from_utf8(&out).unwrap(),
            r#"{"z":1,"user":"a","password":"x","keep":[true,null,-2]}"#
        );
    }

    #[test]
    fn an_escaped_surrogate_is_still_found_in_its_field() {
        let escaped = S.replacen('o', "\\u006f", 1);
        let body = format!(r#"{{"password":"{escaped}"}}"#);
        let out = substitute(body.as_bytes(), "password", S, "x").unwrap();
        assert_eq!(&out[..], br#"{"password":"x"}"#);
    }

    #[test]
    fn the_output_buffer_is_allocated_once_at_its_exact_size() {
        // A credential that escapes longer than it was written would outgrow
        // a buffer sized from the input.
        let body = format!(r#"{{"a":1.5,"b":2,"c":-3.25,"password":"{S}"}}"#);
        let out = substitute(body.as_bytes(), "password", S, "\u{1}\"\\").unwrap();
        assert_eq!(out.capacity(), out.len());
        assert_eq!(
            std::str::from_utf8(&out).unwrap(),
            r#"{"a":1.5,"b":2,"c":-3.25,"password":"\u0001\"\\"}"#
        );
    }

    #[test]
    fn a_number_that_would_change_value_is_refused_not_rewritten() {
        for number in ["123456789012345678901234567890", "-0", "1e2", "1.50"] {
            let body = format!(r#"{{"n":{number},"password":"{S}"}}"#);
            let refusal = substitute(body.as_bytes(), "password", S, "x").unwrap_err();
            assert_eq!(refusal.code, RefusalCode::Unsupported, "{number}");
            assert_eq!(refusal.detail.as_deref(), Some("json-number"), "{number}");
        }
    }

    #[test]
    fn big_and_signed_numbers_that_do_round_trip_are_kept_verbatim() {
        let body = format!(r#"{{"id":18446744073709551615,"n":-9223372036854775808,"password":"{S}"}}"#);
        let out = substitute(body.as_bytes(), "password", S, "x").unwrap();
        assert_eq!(
            std::str::from_utf8(&out).unwrap(),
            r#"{"id":18446744073709551615,"n":-9223372036854775808,"password":"x"}"#
        );
    }

    #[test]
    fn malformed_json_is_unsupported() {
        let refusal = substitute(b"{\"password\":", "password", S, "x").unwrap_err();
        assert_eq!(refusal.code, RefusalCode::Unsupported);
    }
}
