//! Resources that are only known at claim time, bounded by a ceiling that was
//! known at issue time.
//!
//! Some authority genuinely cannot name its resource up front: an agent is
//! given "open a pull request on the repository this task turns out to be
//! about". The usual answer is a wildcard wide enough to cover whatever
//! arrives, which means the bound is decided by the thing being bounded.
//!
//! The answer here is a template plus a ceiling. The template says where the
//! unknown part goes (`repo:acme/{repository}`); the ceiling says what the
//! result may never escape (`repo:acme/*`). Binding substitutes a value that
//! must be a single segment — no separator, no wildcard, no braces — and then
//! checks the result against the ceiling anyway. Both halves are needed:
//! segment validation stops `{repository}` from being `../victim`, and the
//! ceiling check stops a template that was wrong in the first place.

use crate::permission::entry::PermissionEntry;
use crate::permission::scope::ResourceScope;
use crate::DomainError;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Most placeholders one template may carry.
pub const MAX_TEMPLATE_PLACEHOLDERS: usize = 8;
/// Longest value a placeholder may be bound to.
pub const MAX_BINDING_LENGTH: usize = 128;

/// A resource string with `{name}` holes in it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct ResourceTemplate {
    raw: String,
    placeholders: Vec<String>,
}

fn invalid(raw: &str, why: &str) -> DomainError {
    DomainError::ResourceSelectorInvalid(format!("template {raw:?}: {why}"))
}

impl ResourceTemplate {
    /// Parse a template.
    ///
    /// # Errors
    ///
    /// Returns [`DomainError::ResourceSelectorInvalid`] for unbalanced or
    /// nested braces, an empty or duplicated placeholder name, more than
    /// [`MAX_TEMPLATE_PLACEHOLDERS`] holes, a template with no holes at all
    /// (write a plain selector instead), or a `*` anywhere — a template
    /// produces one exact resource, never a subtree.
    pub fn parse(raw: &str) -> Result<Self, DomainError> {
        if raw.is_empty() {
            return Err(invalid(raw, "empty"));
        }
        if raw.contains('*') {
            return Err(invalid(
                raw,
                "carries a `*`; a bound template yields one exact resource",
            ));
        }
        let mut placeholders: Vec<String> = Vec::new();
        let mut rest = raw;
        while let Some(open) = rest.find('{') {
            let after = &rest[open + 1..];
            let Some(close) = after.find('}') else {
                return Err(invalid(raw, "has an unclosed `{`"));
            };
            let name = &after[..close];
            if name.is_empty() {
                return Err(invalid(raw, "has an empty placeholder"));
            }
            if name.contains('{') {
                return Err(invalid(raw, "has a nested placeholder"));
            }
            if !name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
            {
                return Err(invalid(raw, "placeholder names are alphanumeric"));
            }
            if placeholders.iter().any(|seen| seen == name) {
                return Err(invalid(raw, "names the same placeholder twice"));
            }
            placeholders.push(name.to_string());
            rest = &after[close + 1..];
        }
        if rest.contains('}') {
            return Err(invalid(raw, "has an unmatched `}`"));
        }
        if placeholders.is_empty() {
            return Err(invalid(
                raw,
                "has no placeholder; use a plain selector instead",
            ));
        }
        if placeholders.len() > MAX_TEMPLATE_PLACEHOLDERS {
            return Err(invalid(raw, "has too many placeholders"));
        }
        Ok(Self {
            raw: raw.to_string(),
            placeholders,
        })
    }

    #[must_use]
    pub fn raw(&self) -> &str {
        &self.raw
    }

    #[must_use]
    pub fn placeholders(&self) -> &[String] {
        &self.placeholders
    }

    /// Substitute values and return the exact resource they name.
    ///
    /// # Errors
    ///
    /// Returns [`DomainError::ResourceSelectorInvalid`] when a placeholder has
    /// no binding, when a binding is supplied that the template never names
    /// (a caller and an issuer disagreeing about the shape of the request is
    /// not something to paper over), or when a value is not a single segment.
    pub fn bind(&self, bindings: &BTreeMap<String, String>) -> Result<ResourceScope, DomainError> {
        for name in bindings.keys() {
            if !self.placeholders.iter().any(|known| known == name) {
                return Err(invalid(
                    &self.raw,
                    &format!("was given a value for {name:?}, which it does not name"),
                ));
            }
        }
        let mut out = self.raw.clone();
        for name in &self.placeholders {
            let value = bindings
                .get(name)
                .ok_or_else(|| invalid(&self.raw, &format!("has no value for {name:?}")))?;
            assert_single_segment(&self.raw, name, value)?;
            out = out.replace(&format!("{{{name}}}"), value);
        }
        ResourceScope::parse(&out)
    }
}

impl TryFrom<String> for ResourceTemplate {
    type Error = DomainError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::parse(&value)
    }
}

impl From<ResourceTemplate> for String {
    fn from(value: ResourceTemplate) -> Self {
        value.raw
    }
}

/// A bound value must be one segment and nothing clever.
fn assert_single_segment(raw: &str, name: &str, value: &str) -> Result<(), DomainError> {
    let refuse = |why: &str| {
        Err(invalid(
            raw,
            &format!("value for {name:?} {why}; a bound value is one segment"),
        ))
    };
    if value.is_empty() {
        return refuse("is empty");
    }
    if value.len() > MAX_BINDING_LENGTH {
        return refuse("is too long");
    }
    if value.chars().any(char::is_control) || value.trim() != value {
        return refuse("is not a bare value");
    }
    if value.contains('/') || value.contains(':') {
        return refuse("carries a separator, so it would escape its segment");
    }
    if value.contains('*') {
        return refuse("carries a wildcard");
    }
    if value.contains('{') || value.contains('}') {
        return refuse("carries a brace, so it would be substituted again");
    }
    if value.contains("..") {
        return refuse("carries a traversal");
    }
    Ok(())
}

/// A permission entry whose resource is decided at claim time, under a ceiling
/// decided at issue time.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DynamicPermissionRule {
    actions: Vec<String>,
    template: ResourceTemplate,
    ceiling: ResourceScope,
}

impl DynamicPermissionRule {
    /// Define the rule.
    ///
    /// # Errors
    ///
    /// Returns [`DomainError::PermissionEntryInvalid`] when the actions do not
    /// form a valid entry, or when the ceiling is [`ResourceScope::Everything`]
    /// — a dynamic resource under an unbounded ceiling is a wildcard with
    /// extra steps, and the whole mechanism is the bound.
    pub fn new<A: AsRef<str>>(
        actions: &[A],
        template: ResourceTemplate,
        ceiling: ResourceScope,
    ) -> Result<Self, DomainError> {
        if ceiling == ResourceScope::Everything {
            return Err(DomainError::PermissionEntryInvalid(
                "a dynamic resource needs a bounded ceiling, not `*`".into(),
            ));
        }
        // Validated here so a rule cannot be stored and fail only at claim time.
        let probe = PermissionEntry::from_scopes(actions, vec![ceiling.clone()])?;
        Ok(Self {
            actions: probe.actions().to_vec(),
            template,
            ceiling,
        })
    }

    #[must_use]
    pub fn actions(&self) -> &[String] {
        &self.actions
    }

    #[must_use]
    pub fn ceiling(&self) -> &ResourceScope {
        &self.ceiling
    }

    #[must_use]
    pub fn template(&self) -> &ResourceTemplate {
        &self.template
    }

    /// Bind the template and return the correlated entry it produced.
    ///
    /// # Errors
    ///
    /// Propagates [`ResourceTemplate::bind`], and returns
    /// [`DomainError::CapabilityWidenForbidden`] when the bound resource falls
    /// outside the ceiling.
    pub fn bind(
        &self,
        bindings: &BTreeMap<String, String>,
    ) -> Result<PermissionEntry, DomainError> {
        let scope = self.template.bind(bindings)?;
        if !self.ceiling.contains(&scope) {
            return Err(DomainError::CapabilityWidenForbidden);
        }
        PermissionEntry::from_scopes(&self.actions, vec![scope])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bindings(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
            .collect()
    }

    fn rule() -> DynamicPermissionRule {
        DynamicPermissionRule::new(
            &["pull_request.create"],
            ResourceTemplate::parse("repo:acme/{repository}").unwrap(),
            ResourceScope::parse("repo:acme/*").unwrap(),
        )
        .unwrap()
    }

    #[test]
    fn binding_yields_a_correlated_entry_inside_the_ceiling() {
        let entry = rule()
            .bind(&bindings(&[("repository", "catalog")]))
            .unwrap();
        assert!(entry.permits("pull_request.create", "repo:acme/catalog"));
        assert!(!entry.permits("pull_request.create", "repo:acme/docs"));
        assert!(!entry.permits("repository.admin", "repo:acme/catalog"));
    }

    #[test]
    fn a_bound_value_cannot_escape_its_segment() {
        for hostile in [
            "../victim",
            "catalog/sub",
            "acme:catalog",
            "*",
            "cat*",
            "{repository}",
            "",
            " catalog",
        ] {
            assert!(
                rule().bind(&bindings(&[("repository", hostile)])).is_err(),
                "{hostile:?} must not bind"
            );
        }
    }

    #[test]
    fn a_missing_or_surplus_binding_fails_closed() {
        assert!(rule().bind(&bindings(&[])).is_err());
        assert!(rule()
            .bind(&bindings(&[("repository", "catalog"), ("org", "victim")]))
            .is_err());
    }

    #[test]
    fn the_ceiling_is_checked_even_when_the_template_is_wrong() {
        let mistaken = DynamicPermissionRule::new(
            &["read"],
            ResourceTemplate::parse("repo:victim-{repository}").unwrap(),
            ResourceScope::parse("repo:acme/*").unwrap(),
        )
        .unwrap();
        assert_eq!(
            mistaken.bind(&bindings(&[("repository", "catalog")])),
            Err(DomainError::CapabilityWidenForbidden)
        );
    }

    #[test]
    fn an_unbounded_ceiling_is_refused_at_definition() {
        assert!(DynamicPermissionRule::new(
            &["read"],
            ResourceTemplate::parse("repo:acme/{repository}").unwrap(),
            ResourceScope::Everything,
        )
        .is_err());
    }

    #[test]
    fn templates_are_validated_not_guessed() {
        for raw in [
            "repo:acme/{repository",
            "repo:acme/{}",
            "repo:acme/{repo}{repo}",
            "repo:acme/{repo}}",
            "repo:acme/{re po}",
            "repo:acme/*",
            "repo:acme/catalog",
            "",
        ] {
            assert!(
                ResourceTemplate::parse(raw).is_err(),
                "{raw:?} must not parse"
            );
        }
        let ok = ResourceTemplate::parse("repo:{org}/{repository}").unwrap();
        assert_eq!(ok.placeholders(), ["org", "repository"]);
    }
}
