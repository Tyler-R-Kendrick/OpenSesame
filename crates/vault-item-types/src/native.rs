//! Projection onto the base native secret (ADR 0087 §3).
//!
//! `sealed_store::Entry` is line one plus a `key: value` trailer, and it is
//! what `opensesame pass`, the `pm-bridges` binaries and `kdbx-bridge` already
//! read. Because every item type declares how it lands there, a community type
//! is readable by the host plane the day it is authored, with no host-plane
//! code at all.
//!
//! `packages/vault-item-types/src/native.ts` is the same function; the two are
//! held together by `tests/conformance.rs`.

use std::collections::BTreeMap;

use opensesame_sealed_store::Entry;
use serde::{Deserialize, Serialize};

use crate::catalogue::{FieldShape, FieldTypeId};
use crate::schema::{FieldDefinition, ItemTypeDefinition};

/// A field value as stored: text, a list of text for a repeating field, or the
/// named parts of a record-shaped one. Text throughout, because the base
/// native secret is text and every type projects onto it.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum FieldValue {
    Text(String),
    List(Vec<String>),
    Parts(BTreeMap<String, String>),
}

impl FieldValue {
    #[must_use]
    pub fn as_text(&self) -> &str {
        match self {
            Self::Text(text) => text,
            _ => "",
        }
    }

    #[must_use]
    pub fn as_list(&self) -> Vec<String> {
        match self {
            Self::Text(text) if text.is_empty() => Vec::new(),
            Self::Text(text) => vec![text.clone()],
            Self::List(list) => list.clone(),
            Self::Parts(_) => Vec::new(),
        }
    }

    #[must_use]
    pub fn as_parts(&self) -> BTreeMap<String, String> {
        match self {
            Self::Parts(parts) => parts.clone(),
            _ => BTreeMap::new(),
        }
    }
}

pub type FieldValues = BTreeMap<String, FieldValue>;

/// What a readback recovered: the definition's own fields, plus trailer keys
/// it does not claim, kept verbatim rather than dropped.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Readback {
    pub values: FieldValues,
    pub extra: BTreeMap<String, String>,
}

/// Line one holds no newline and the trailer is line-oriented, so a value that
/// contains one is escaped rather than allowed to split the entry.
#[must_use]
pub fn encode_value(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('\r', "\\r")
        .replace('\n', "\\n")
}

#[must_use]
pub fn decode_value(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut chars = value.chars().peekable();
    while let Some(current) = chars.next() {
        if current != '\\' {
            out.push(current);
            continue;
        }
        match chars.peek() {
            Some('n') => {
                out.push('\n');
                chars.next();
            }
            Some('r') => {
                out.push('\r');
                chars.next();
            }
            Some('\\') => {
                out.push('\\');
                chars.next();
            }
            _ => out.push(current),
        }
    }
    out
}

/// `pass-otp` reads an `otpauth://` URI only from a line that *starts* with
/// it, so a TOTP seed is written bare rather than behind its trailer key. The
/// exception belongs to the field type, not to any definition.
fn is_bare_otpauth(field: &FieldDefinition, text: &str) -> bool {
    field.field_type == FieldTypeId::Totp && text.to_ascii_lowercase().starts_with("otpauth://")
}

fn trailer_lines(field: &FieldDefinition, key: &str, value: Option<&FieldValue>) -> Vec<String> {
    let Some(value) = value else {
        return Vec::new();
    };
    if field.field_type.shape() == FieldShape::Record {
        let parts = value.as_parts();
        return field
            .field_type
            .parts()
            .iter()
            .filter_map(|part| {
                let text = parts.get(part.id)?;
                if text.is_empty() {
                    return None;
                }
                Some(format!("{key}.{}: {}", part.id, encode_value(text)))
            })
            .collect();
    }
    if field.repeats() {
        return value
            .as_list()
            .into_iter()
            .filter(|entry| !entry.is_empty())
            .map(|entry| format!("{key}: {}", encode_value(&entry)))
            .collect();
    }
    let text = value.as_text();
    if text.is_empty() {
        Vec::new()
    } else if is_bare_otpauth(field, text) {
        vec![text.to_owned()]
    } else {
        vec![format!("{key}: {}", encode_value(text))]
    }
}

/// Project an item's values onto the base native secret.
#[must_use]
pub fn to_entry(definition: &ItemTypeDefinition, values: &FieldValues) -> Entry {
    let secret = definition
        .spec
        .native
        .secret
        .as_deref()
        .and_then(|id| values.get(id))
        .map_or_else(String::new, |value| encode_value(value.as_text()));

    let mut lines: Vec<String> = Vec::new();
    for mapping in &definition.spec.native.trailer {
        let Some(field) = definition.field(&mapping.field) else {
            continue;
        };
        lines.extend(trailer_lines(
            field,
            &mapping.key,
            values.get(&mapping.field),
        ));
    }
    let trailer = if lines.is_empty() {
        String::new()
    } else {
        format!("{}\n", lines.join("\n"))
    };
    // Round-tripping through `Entry::parse` rather than building the struct
    // is what picks up the bare `otpauth://` line as the entry's OTP; building
    // it directly and calling `with_otp(None)` would strip that line back out.
    Entry::parse(&format!("{secret}\n{trailer}"))
}

/// Split a trailer line into its key, optional record part, and raw value.
fn split_line(line: &str) -> Option<(&str, Option<&str>, &str)> {
    let (head, raw) = line.split_once(':')?;
    if head.is_empty() || !head.is_ascii() {
        return None;
    }
    let (key, part) = match head.split_once('.') {
        Some((key, part)) => (key, Some(part)),
        None => (head, None),
    };
    let mut first = key.chars();
    if !first.next().is_some_and(|c| c.is_ascii_lowercase()) {
        return None;
    }
    if !key
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
    {
        return None;
    }
    Some((key, part, raw.strip_prefix(' ').unwrap_or(raw)))
}

/// Recover an item's values from a native entry. Total: trailer keys the
/// definition does not claim survive in `extra`.
#[must_use]
pub fn from_entry(definition: &ItemTypeDefinition, entry: &Entry) -> Readback {
    let by_key: BTreeMap<&str, &str> = definition
        .spec
        .native
        .trailer
        .iter()
        .map(|mapping| (mapping.key.as_str(), mapping.field.as_str()))
        .collect();
    let totp_field = definition
        .spec
        .native
        .trailer
        .iter()
        .find(|mapping| {
            definition
                .field(&mapping.field)
                .is_some_and(|field| field.field_type == FieldTypeId::Totp)
        })
        .map(|mapping| mapping.field.clone());

    let mut readback = Readback::default();
    if let Some(secret) = definition.spec.native.secret.as_deref() {
        readback.values.insert(
            secret.to_owned(),
            FieldValue::Text(decode_value(&entry.secret)),
        );
    }
    let mut lists: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut records: BTreeMap<String, BTreeMap<String, String>> = BTreeMap::new();

    for line in entry.trailer.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.to_ascii_lowercase().starts_with("otpauth://") {
            match totp_field.as_ref() {
                Some(field) => {
                    readback
                        .values
                        .insert(field.clone(), FieldValue::Text(trimmed.to_owned()));
                }
                None => {
                    readback
                        .extra
                        .insert("otpauth".to_owned(), trimmed.to_owned());
                }
            }
            continue;
        }
        let Some((key, part, raw)) = split_line(line) else {
            continue;
        };
        absorb_line(
            definition,
            &by_key,
            &mut readback,
            &mut lists,
            &mut records,
            (key, part, raw),
        );
    }

    for (field, list) in lists {
        readback.values.insert(field, FieldValue::List(list));
    }
    for (field, parts) in records {
        readback.values.insert(field, FieldValue::Parts(parts));
    }
    readback
}

fn absorb_line(
    definition: &ItemTypeDefinition,
    by_key: &BTreeMap<&str, &str>,
    readback: &mut Readback,
    lists: &mut BTreeMap<String, Vec<String>>,
    records: &mut BTreeMap<String, BTreeMap<String, String>>,
    line: (&str, Option<&str>, &str),
) {
    let (key, part, raw) = line;
    let extra_key = part.map_or_else(|| key.to_owned(), |part| format!("{key}.{part}"));
    let Some(field) = by_key.get(key).and_then(|id| definition.field(id)) else {
        readback.extra.insert(extra_key, decode_value(raw));
        return;
    };
    if field.field_type.shape() == FieldShape::Record {
        let known = part.is_some_and(|name| {
            field
                .field_type
                .parts()
                .iter()
                .any(|candidate| candidate.id == name)
        });
        match part.filter(|_| known) {
            Some(name) => {
                records
                    .entry(field.id.clone())
                    .or_default()
                    .insert(name.to_owned(), decode_value(raw));
            }
            None => {
                readback.extra.insert(extra_key, decode_value(raw));
            }
        }
        return;
    }
    if field.repeats() {
        lists
            .entry(field.id.clone())
            .or_default()
            .push(decode_value(raw));
        return;
    }
    readback
        .values
        .insert(field.id.clone(), FieldValue::Text(decode_value(raw)));
}
