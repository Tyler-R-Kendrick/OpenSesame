//! Value-blind scrubbing of secrets in log lines, events, error strings and JSON
//! on the Host / authority plane (ADR 0155).
//!
//! The rules are not written here. They are `spec/log-scrub/log-scrub.json`,
//! embedded at build time and read by `@opensesame/log-scrub` too, so both
//! planes recognise a secret the same way and one vector table proves both.
//! Two layers: a *key* layer censors the value of anything named like a secret
//! (`accessToken`, `x-api-key`, `db_password`), and a *value* layer rewrites text
//! that carries a secret with no key to name it (a bearer in an error message, a
//! `#token=` in a URL, a JWT, a DSN password).

use std::sync::LazyLock;

use regex::{Captures, Regex};
use serde_json::{Map, Value};

mod writer;

#[cfg(feature = "tracing")]
pub use writer::ScrubMakeWriter;
pub use writer::{Format, ScrubWriter};

const SPEC: &str = include_str!("../../../spec/log-scrub/log-scrub.json");

/// What replaces a secret.
pub const MARKER: &str = "[REDACTED]";

/// Depth ceiling so a hostile document cannot stall a logger.
const MAX_DEPTH: usize = 12;

struct Rule {
    re: Regex,
    replace: String,
}

struct Engine {
    rules: Vec<Rule>,
    key_strip: Regex,
    key_exact: Vec<String>,
    key_suffixes: Vec<String>,
    key_keep: Vec<String>,
}

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

fn text<'a>(value: &'a Value, field: &str) -> &'a str {
    value.get(field).and_then(Value::as_str).unwrap_or_default()
}

static ENGINE: LazyLock<Engine> = LazyLock::new(|| {
    let spec: Value = serde_json::from_str(SPEC).expect("log-scrub spec is valid JSON");
    let rules = spec["rules"]
        .as_array()
        .expect("log-scrub spec has rules")
        .iter()
        .map(|rule| {
            let flags = text(rule, "flags");
            let prefix = if flags.contains('i') { "(?i)" } else { "" };
            // JS `\b` is ASCII; Rust's is Unicode, so a token right after CJK
            // or accented text would not be found. Pin the ASCII meaning.
            let pattern = text(rule, "pattern").replace("\\b", "(?-u:\\b)");
            Rule {
                re: Regex::new(&format!("{prefix}{pattern}")).expect("log-scrub rule compiles"),
                replace: text(rule, "replace").to_owned(),
            }
        })
        .collect();
    let keys = &spec["keys"];
    Engine {
        rules,
        key_strip: Regex::new(text(keys, "strip")).expect("log-scrub key strip compiles"),
        key_exact: strings(&keys["exact"]),
        key_suffixes: strings(&keys["suffixes"]),
        key_keep: strings(&keys["keep"]),
    }
});

/// `$1`..`$9` in a spec template are capture groups; the rest is literal.
fn expand(template: &str, caps: &Captures<'_>) -> String {
    let mut out = String::with_capacity(template.len());
    let mut chars = template.chars().peekable();
    while let Some(c) = chars.next() {
        match (c, chars.peek().and_then(|next| next.to_digit(10))) {
            ('$', Some(n @ 1..=9)) => {
                chars.next();
                out.push_str(caps.get(n as usize).map_or("", |m| m.as_str()));
            }
            _ => out.push(c),
        }
    }
    out
}

/// Rewrite every secret a piece of text carries. Idempotent.
#[must_use]
pub fn redact_text(input: &str) -> String {
    let mut out = input.to_owned();
    for rule in &ENGINE.rules {
        out = rule
            .re
            .replace_all(&out, |caps: &Captures<'_>| expand(&rule.replace, caps))
            .into_owned();
    }
    out
}

/// Is a key named like a secret? `tokenType` is not; `accessToken` is.
#[must_use]
pub fn is_sensitive_key(key: &str) -> bool {
    let lowered = key.to_lowercase();
    let normal = ENGINE.key_strip.replace_all(&lowered, "");
    ENGINE.key_exact.iter().any(|exact| *exact == normal)
        || ENGINE
            .key_suffixes
            .iter()
            .any(|suffix| normal.ends_with(suffix.as_str()))
}

fn kept_kind(value: &Value) -> bool {
    let kind = match value {
        Value::Bool(_) => "boolean",
        Value::Null => "null",
        _ => return false,
    };
    ENGINE.key_keep.iter().any(|keep| keep == kind)
}

fn walk(value: &Value, depth: usize) -> Value {
    if depth >= MAX_DEPTH {
        return Value::String(MARKER.into());
    }
    match value {
        Value::String(s) => Value::String(redact_text(s)),
        Value::Array(items) => Value::Array(items.iter().map(|v| walk(v, depth + 1)).collect()),
        Value::Object(map) => {
            let mut out = Map::new();
            for (key, item) in map {
                let censored = is_sensitive_key(key) && !kept_kind(item);
                out.insert(
                    key.clone(),
                    if censored {
                        Value::String(MARKER.into())
                    } else {
                        walk(item, depth + 1)
                    },
                );
            }
            Value::Object(out)
        }
        other => other.clone(),
    }
}

/// A copy of the document with the value of every sensitive key censored at any
/// depth and every string scrubbed.
#[must_use]
pub fn redact_json(value: &Value) -> Value {
    walk(value, 0)
}

#[cfg(test)]
mod privacy;

#[cfg(test)]
mod tests;
