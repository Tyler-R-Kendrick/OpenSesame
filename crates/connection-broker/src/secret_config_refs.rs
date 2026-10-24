//! `${…}` reference parsing for secret config values, split out of
//! `secret_config.rs` for the module-size budget (ADR 0093).

use super::{valid_key_name, valid_slug};
use crate::error::{BrokerError, Result};

/// One parsed `${…}` occurrence.
#[derive(Debug, PartialEq)]
pub(super) enum Reference {
    SameConfig { key: String },
    CrossConfig { slug: String, key: String },
}

fn parse_reference(inner: &str) -> Result<Reference> {
    if let Some(rest) = inner.strip_prefix("config:") {
        let (slug, key) = rest.split_once('.').ok_or_else(|| {
            BrokerError::Invalid(format!(
                "cross-config reference `{inner}` must be `config:<slug>.<KEY>`"
            ))
        })?;
        if !valid_slug(slug) || !valid_key_name(key) {
            return Err(BrokerError::Invalid(format!(
                "invalid cross-config reference `{inner}`"
            )));
        }
        return Ok(Reference::CrossConfig {
            slug: slug.to_string(),
            key: key.to_string(),
        });
    }
    if !valid_key_name(inner) {
        return Err(BrokerError::Invalid(format!(
            "invalid secret reference `{inner}`"
        )));
    }
    Ok(Reference::SameConfig {
        key: inner.to_string(),
    })
}

/// Scan a value for references. `$${…}` is an escape for a literal `${…}` and
/// is left alone here (unescaped during substitution). Malformed references
/// (unclosed, bad names) are hard errors — fail closed, never pass through.
pub(super) fn parse_references(value: &str) -> Result<Vec<(usize, usize, Reference)>> {
    let bytes = value.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i + 1 < bytes.len() {
        if bytes[i] == b'$' && bytes[i + 1] == b'$' && bytes.get(i + 2) == Some(&b'{') {
            let close = value[i + 2..]
                .find('}')
                .ok_or_else(|| BrokerError::Invalid("unclosed secret reference".into()))?;
            i += 2 + close + 1;
            continue;
        }
        if bytes[i] == b'$' && bytes[i + 1] == b'{' {
            let close = value[i..]
                .find('}')
                .ok_or_else(|| BrokerError::Invalid("unclosed secret reference".into()))?;
            let inner = &value[i + 2..i + close];
            let reference = parse_reference(inner)?;
            out.push((i, i + close + 1, reference));
            i += close + 1;
            continue;
        }
        i += 1;
    }
    Ok(out)
}

pub(super) fn unescape(value: &str) -> String {
    value.replace("$${", "${")
}
