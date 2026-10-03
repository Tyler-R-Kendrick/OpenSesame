//! The scope a surrogate is issued for, declared on the entry that asks for
//! it (ADR 0150 section 8: the narrowest operation the child needs).
//!
//! ```text
//! GITHUB_TOKEN=opensesameConnection(conn://org/github, projection=legacy-token,
//!                                   paths="/repos/acme,/user", methods="GET,POST")
//! ```
//!
//! `paths=` is a comma-separated list of absolute path prefixes, matched on
//! segment boundaries by the proxy (`/repos/acme` admits `/repos/acme/x`,
//! never `/repos/acme-private`). It is how a person grants a run less than
//! "everything the provider's host serves", and it has no default: an entry
//! that declares none carries none, and the surrogate-proxy plugin refuses to
//! issue one for it. The root is not a prefix (it bounds nothing). `methods=`
//! names the HTTP methods the surrogate may be used with, and a `paths=`
//! declaration requires it: a scope is complete when declared, so a bounded
//! read-only run never inherits write verbs from a default.

use crate::{arg_string, EnvResolver, EnvSpecError};

/// Methods a declaration may name. The set the surrogate-proxy plugin checks
/// on the wire; both run `methods` in `spec/conformance/surrogate-scope.json`.
const METHODS: [&str; 7] = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

/// What an entry declared. Empty or `None` is "not declared".
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct Declared {
    pub(crate) path_prefixes: Vec<String>,
    pub(crate) methods: Option<Vec<String>>,
}

fn keyed(resolver: &EnvResolver, key: &str) -> Option<String> {
    resolver
        .args
        .iter()
        .find(|arg| arg.key.as_deref() == Some(key))
        .and_then(arg_string)
}

fn refuse(key: &str, reason: &str) -> EnvSpecError {
    EnvSpecError::Scope(format!("{key}: {reason}"))
}

/// The declaration on `resolver`, validated.
///
/// # Errors
///
/// A `paths=` entry that is not a bounded absolute prefix (see
/// [`is_bounded_prefix`]), a `methods=` entry that is not an HTTP method, or
/// either one declared empty, or `paths=` declared without `methods=`.
pub(crate) fn declared(key: &str, resolver: &EnvResolver) -> Result<Declared, EnvSpecError> {
    let mut out = Declared::default();
    if let Some(raw) = keyed(resolver, "paths") {
        for prefix in items(&raw) {
            if !is_bounded_prefix(prefix) {
                return Err(refuse(
                    key,
                    &format!(
                        "paths= entry `{prefix}` does not bound the surrogate: name an absolute \
                         prefix such as /repos/acme (the root, dot segments, queries and \
                         fragments are refused)"
                    ),
                ));
            }
            let prefix = prefix.trim_end_matches('/').to_owned();
            if !out.path_prefixes.contains(&prefix) {
                out.path_prefixes.push(prefix);
            }
        }
        if out.path_prefixes.is_empty() {
            return Err(refuse(key, "paths= names no prefix"));
        }
    }
    if let Some(raw) = keyed(resolver, "methods") {
        let mut methods: Vec<String> = Vec::new();
        for method in items(&raw) {
            let method = method.to_ascii_uppercase();
            if !is_http_method(&method) {
                return Err(refuse(
                    key,
                    &format!(
                        "methods= entry `{method}` is not one of {}",
                        METHODS.join(", ")
                    ),
                ));
            }
            if !methods.contains(&method) {
                methods.push(method);
            }
        }
        if methods.is_empty() {
            return Err(refuse(key, "methods= names no method"));
        }
        out.methods = Some(methods);
    }
    if !out.path_prefixes.is_empty() && out.methods.is_none() {
        return Err(refuse(
            key,
            "paths= needs methods= beside it: name the verbs the surrogate may use, for \
             example methods=\"GET\"",
        ));
    }
    Ok(out)
}

fn items(raw: &str) -> impl Iterator<Item = &str> {
    raw.split(',')
        .map(str::trim)
        .filter(|item| !item.is_empty())
}

/// Whether `method` is one an operator may grant: exactly an upper-case entry
/// of [`METHODS`].
#[must_use]
pub fn is_http_method(method: &str) -> bool {
    METHODS.contains(&method)
}

/// Whether `prefix` bounds a path: absolute, with at least one named segment
/// and no empty, `.` or `..` segment, query, fragment, backslash, semicolon,
/// whitespace or control character. The same rule the surrogate-proxy plugin enforces on
/// the wire (`plugin::wire::is_bounded_prefix`); both run
/// `spec/conformance/surrogate-scope.json` (ADR 0139).
#[must_use]
pub fn is_bounded_prefix(prefix: &str) -> bool {
    let Some(rest) = prefix.strip_prefix('/') else {
        return false;
    };
    let rest = rest.strip_suffix('/').unwrap_or(rest);
    !rest.is_empty()
        && rest
            .split('/')
            .all(|segment| !matches!(segment, "" | "." | ".."))
        && !prefix
            .chars()
            .any(|c| c.is_control() || c.is_whitespace() || matches!(c, '?' | '#' | '\\' | ';'))
}

#[cfg(test)]
mod tests {
    use super::*;

    const VECTORS: &str = include_str!("../../../spec/conformance/surrogate-scope.json");

    fn vectors(kind: &str) -> Vec<String> {
        let all: serde_json::Value = serde_json::from_str(VECTORS).unwrap();
        all[kind]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_owned())
            .collect()
    }

    #[test]
    fn the_shared_vectors_decide_what_bounds_a_path() {
        for prefix in vectors("bounded") {
            assert!(is_bounded_prefix(&prefix), "{prefix:?} must bound");
        }
        for prefix in vectors("unbounded") {
            assert!(!is_bounded_prefix(&prefix), "{prefix:?} must not bound");
        }
    }

    #[test]
    fn the_shared_vectors_decide_what_is_an_http_method() {
        let all: serde_json::Value = serde_json::from_str(VECTORS).unwrap();
        for (kind, expected) in [("valid", true), ("invalid", false)] {
            for method in all["methods"][kind].as_array().unwrap() {
                let method = method.as_str().unwrap();
                assert_eq!(is_http_method(method), expected, "{method:?}");
            }
        }
    }
}
