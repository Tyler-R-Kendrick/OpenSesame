//! Resource selectors: an exact id, or a subtree bounded at a separator.
//!
//! The whole point of a selector type is that there is no third option. A bare
//! string prefix (`repo:acme`) would let `repo:acme-private/secrets` in, and a
//! regular expression would let anything in that the author did not think
//! about. Both are refused at parse time, so no matcher downstream ever has to
//! decide what a pattern "probably meant".
//!
//! The string encoding is the one the flat `Grant::resources` field already
//! uses — `*`, `repo:acme/catalog`, `repo:acme/*` — so a selector round-trips
//! through the existing wire format unchanged. What is new is that anything
//! *outside* that grammar is now an error instead of a dead pattern.

use crate::DomainError;
use serde::{Deserialize, Serialize};

/// Longest resource string accepted. Bounds hostile input; every real
/// resource id in the repository is an order of magnitude shorter.
pub const MAX_RESOURCE_LENGTH: usize = 512;

/// Separator a subtree selector is bounded at.
///
/// Only these two, because these are the two the resource vocabulary uses:
/// `repo:acme/catalog` is a `:`-scoped provider namespace containing a
/// `/`-scoped path. A subtree must end on one of them, which is exactly what
/// stops `repo:acme/*` from reaching `repo:acme-private/…`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScopeSeparator {
    Slash,
    Colon,
}

impl ScopeSeparator {
    #[must_use]
    pub const fn as_char(self) -> char {
        match self {
            Self::Slash => '/',
            Self::Colon => ':',
        }
    }
}

/// A resource selector.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub enum ResourceScope {
    /// `*`. Everything. Kept because legacy grants encode it and dropping it
    /// would silently narrow them; never synthesised from a narrower form.
    Everything,
    /// One resource, matched by equality. `repo:acme/catalog` does not reach
    /// `repo:acme/catalog-private`.
    Exact(String),
    /// Everything strictly below `prefix` at `separator`, e.g. `repo:acme/*`.
    /// The prefix is stored without its separator; the separator is part of
    /// the match, so the boundary cannot be crossed by a longer sibling name.
    Subtree {
        prefix: String,
        separator: ScopeSeparator,
    },
}

/// Substrings that mean a person wrote a pattern this grammar cannot honour.
///
/// A regex here would not widen anything — `Exact` matches by equality, so
/// `repo:acme/.*` would simply match nothing. That is the reason to refuse it:
/// an author who believed they had written a subtree would get a grant that is
/// silently dead, and a dead grant is debugged by widening something else.
const PATTERN_LOOKALIKES: [&str; 5] = [".*", ".+", "**", "?", "[^"];

fn selector_invalid(pattern: &str, why: &str) -> DomainError {
    DomainError::ResourceSelectorInvalid(format!("{pattern:?}: {why}"))
}

/// The subtree reading of `pattern`, if it ends in a separator wildcard.
///
/// Split out so the grammar reads as one decision per function rather than
/// three levels of nesting inside the parser.
fn parse_subtree(pattern: &str) -> Option<Result<ResourceScope, DomainError>> {
    for separator in [ScopeSeparator::Slash, ScopeSeparator::Colon] {
        let suffix = format!("{}*", separator.as_char());
        let Some(prefix) = pattern.strip_suffix(&suffix) else {
            continue;
        };
        return Some(subtree_from_prefix(pattern, prefix, separator));
    }
    None
}

fn subtree_from_prefix(
    pattern: &str,
    prefix: &str,
    separator: ScopeSeparator,
) -> Result<ResourceScope, DomainError> {
    if prefix.is_empty() {
        return Err(selector_invalid(pattern, "subtree has no prefix"));
    }
    if prefix.contains('*') {
        return Err(selector_invalid(
            pattern,
            "a subtree carries exactly one `*`, at the end",
        ));
    }
    Ok(ResourceScope::Subtree {
        prefix: prefix.to_string(),
        separator,
    })
}

impl ResourceScope {
    /// Parse the string encoding.
    ///
    /// # Errors
    ///
    /// Returns [`DomainError::ResourceSelectorInvalid`] for an empty or
    /// oversized string, a control character, a bare prefix such as
    /// `repo:acme*`, a `*` anywhere but as the final segment, or anything
    /// shaped like a regular expression.
    pub fn parse(pattern: &str) -> Result<Self, DomainError> {
        let invalid = |why: &str| selector_invalid(pattern, why);
        if pattern.is_empty() {
            return Err(invalid("empty"));
        }
        if pattern.len() > MAX_RESOURCE_LENGTH {
            return Err(invalid("longer than MAX_RESOURCE_LENGTH"));
        }
        if pattern.chars().any(char::is_control) {
            return Err(invalid("contains a control character"));
        }
        if pattern.trim() != pattern {
            return Err(invalid("has leading or trailing whitespace"));
        }
        if let Some(bad) = PATTERN_LOOKALIKES
            .iter()
            .find(|needle| pattern.contains(**needle))
        {
            return Err(invalid(&format!(
                "contains {bad:?}; selectors are exact ids or `prefix<sep>*` subtrees, never patterns"
            )));
        }
        if pattern == "*" {
            return Ok(Self::Everything);
        }
        if let Some(subtree) = parse_subtree(pattern) {
            return subtree;
        }
        if pattern.contains('*') {
            return Err(invalid(
                "a bare prefix never widens; write `prefix/*` or `prefix:*`",
            ));
        }
        Ok(Self::Exact(pattern.to_string()))
    }

    /// The string encoding, byte-identical to what [`Self::parse`] accepts.
    #[must_use]
    pub fn encode(&self) -> String {
        match self {
            Self::Everything => "*".to_string(),
            Self::Exact(id) => id.clone(),
            Self::Subtree { prefix, separator } => {
                format!("{prefix}{}*", separator.as_char())
            }
        }
    }

    /// True when `resource` is inside this selector.
    #[must_use]
    pub fn matches(&self, resource: &str) -> bool {
        match self {
            Self::Everything => true,
            Self::Exact(id) => id == resource,
            Self::Subtree { prefix, separator } => resource
                .strip_prefix(prefix.as_str())
                .and_then(|rest| rest.strip_prefix(separator.as_char()))
                .is_some_and(|leaf| !leaf.is_empty()),
        }
    }

    /// True when every resource `child` covers is also covered by `self`.
    ///
    /// Used for attenuation, where comparing selectors by equality would
    /// refuse legitimate narrowing (`repo:acme/catalog` under `repo:acme/*`)
    /// and comparing them by string prefix would accept illegitimate widening.
    #[must_use]
    pub fn contains(&self, child: &Self) -> bool {
        match (self, child) {
            (Self::Everything, _) => true,
            // Nothing narrower than `*` can contain `*`, and an exact id
            // contains no subtree — one resource is not a family of them.
            (_, Self::Everything) | (Self::Exact(_), Self::Subtree { .. }) => false,
            (Self::Exact(parent), Self::Exact(child)) => parent == child,
            (Self::Subtree { .. }, Self::Exact(id)) => self.matches(id),
            (Self::Subtree { .. }, Self::Subtree { prefix, .. }) => {
                // Either the same subtree, or a subtree whose own root already
                // sits inside this one — in which case everything below that
                // root does too, whatever separator it uses.
                self == child || self.matches(prefix)
            }
        }
    }
}

impl TryFrom<String> for ResourceScope {
    type Error = DomainError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::parse(&value)
    }
}

impl From<ResourceScope> for String {
    fn from(value: ResourceScope) -> Self {
        value.encode()
    }
}

impl std::fmt::Display for ResourceScope {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.encode())
    }
}

/// Parse a list of selector strings, refusing the whole list on one bad entry.
///
/// # Errors
///
/// Propagates the first [`ResourceScope::parse`] failure. Partial acceptance
/// is not an option: dropping the entry nobody could parse would leave a
/// narrower grant than the issuer read, which is a different authority.
pub fn parse_scopes<S: AsRef<str>>(patterns: &[S]) -> Result<Vec<ResourceScope>, DomainError> {
    patterns
        .iter()
        .map(|pattern| ResourceScope::parse(pattern.as_ref()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_ids_do_not_reach_longer_siblings() {
        let scope = ResourceScope::parse("repo:acme/catalog").unwrap();
        assert!(scope.matches("repo:acme/catalog"));
        assert!(!scope.matches("repo:acme/catalog-private"));
        assert!(!scope.matches("repo:acme/catalog/sub"));
    }

    #[test]
    fn subtrees_stop_at_their_separator() {
        let scope = ResourceScope::parse("repo:acme/*").unwrap();
        assert!(scope.matches("repo:acme/catalog"));
        assert!(scope.matches("repo:acme/team/catalog"));
        assert!(!scope.matches("repo:acme-private/catalog"));
        assert!(!scope.matches("repo:acme/"));
        assert!(!scope.matches("repo:acme"));
    }

    #[test]
    fn bare_prefixes_and_patterns_are_refused() {
        for pattern in [
            "repo:acme*",
            "*acme",
            "repo:*/catalog",
            "repo:acme/.*",
            "repo:acme/.+",
            "repo:acme/**",
            "repo:acme/?",
            "repo:[^a]/x",
            "",
            " repo:acme/catalog",
            "/*",
        ] {
            assert!(
                ResourceScope::parse(pattern).is_err(),
                "{pattern:?} must not parse"
            );
        }
    }

    #[test]
    fn encoding_round_trips() {
        for pattern in ["*", "repo:acme/catalog", "repo:acme/*", "connection:abc:*"] {
            let scope = ResourceScope::parse(pattern).unwrap();
            assert_eq!(scope.encode(), pattern);
            assert_eq!(ResourceScope::parse(&scope.encode()).unwrap(), scope);
        }
    }

    #[test]
    fn containment_narrows_only() {
        let all = ResourceScope::Everything;
        let subtree = ResourceScope::parse("repo:acme/*").unwrap();
        let nested = ResourceScope::parse("repo:acme/team/*").unwrap();
        let exact = ResourceScope::parse("repo:acme/catalog").unwrap();
        let elsewhere = ResourceScope::parse("repo:victim/secrets").unwrap();

        assert!(all.contains(&subtree));
        assert!(subtree.contains(&exact));
        assert!(subtree.contains(&nested));
        assert!(subtree.contains(&subtree));

        assert!(!subtree.contains(&all));
        assert!(!exact.contains(&subtree));
        assert!(!nested.contains(&subtree));
        assert!(!subtree.contains(&elsewhere));
        // A sibling prefix is not a subtree, however similar it reads.
        let sibling = ResourceScope::parse("repo:acme-private/*").unwrap();
        assert!(!subtree.contains(&sibling));
    }

    #[test]
    fn serde_uses_the_string_encoding_and_validates_on_the_way_in() {
        let scope = ResourceScope::parse("repo:acme/*").unwrap();
        let json = serde_json::to_string(&scope).unwrap();
        assert_eq!(json, "\"repo:acme/*\"");
        assert_eq!(serde_json::from_str::<ResourceScope>(&json).unwrap(), scope);
        assert!(serde_json::from_str::<ResourceScope>("\"repo:acme*\"").is_err());
    }

    #[test]
    fn a_list_is_refused_whole() {
        assert!(parse_scopes(&["repo:acme/catalog", "repo:acme*"]).is_err());
        assert_eq!(
            parse_scopes(&["repo:acme/catalog", "repo:acme/*"])
                .unwrap()
                .len(),
            2
        );
    }
}
