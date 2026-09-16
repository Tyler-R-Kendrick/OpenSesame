//! A permission entry: the actions and the resources they apply to, together.
//!
//! This is the type that closes the correlation hole. Authority used to be two
//! independent lists — `actions: [read, write]`, `resources: [A, B]` — and two
//! independent checks, one per list. Nothing in that shape can distinguish
//! "read A and write B" from "read or write, on A or B", so an issuer who
//! approved the first was enforcing the second, and `write A` was authorized
//! by a grant nobody meant to give.
//!
//! An entry is the smallest unit that *is* a full cross product on purpose:
//! it authorizes every pair in `actions × resources`, and it says so. A caller
//! who wants two uncorrelated pairs writes two entries, and a check has to
//! find both halves of a pair inside a single entry — never one half here and
//! the other half there.

use crate::permission::scope::{parse_scopes, ResourceScope};
use crate::DomainError;
use serde::{Deserialize, Serialize};

/// Most actions one entry may name.
pub const MAX_ENTRY_ACTIONS: usize = 64;
/// Most resource selectors one entry may name.
pub const MAX_ENTRY_SCOPES: usize = 256;
/// Longest action name accepted.
pub const MAX_ACTION_LENGTH: usize = 128;

/// The wire shape: selectors stay strings, so an entry serialises into the
/// same vocabulary the flat `actions`/`resources` fields already use and a
/// reviewer reading JSON sees no new encoding.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PermissionEntryWire {
    pub actions: Vec<String>,
    pub resources: Vec<String>,
}

/// One correlated block of authority.
///
/// Fields are private and the constructor is the only way in, because the
/// canonical form (sorted, deduplicated, non-empty, parsed selectors) is what
/// the containment and flattening checks assume. A publicly mutable `Vec`
/// would let a caller reintroduce an unparsed pattern after validation.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "PermissionEntryWire", into = "PermissionEntryWire")]
pub struct PermissionEntry {
    actions: Vec<String>,
    scopes: Vec<ResourceScope>,
}

impl PermissionEntry {
    /// Build an entry from action names and selector strings.
    ///
    /// # Errors
    ///
    /// Returns [`DomainError::PermissionEntryInvalid`] when either side is
    /// empty or over its bound, or an action name is empty, oversized or
    /// carries a control character; propagates
    /// [`DomainError::ResourceSelectorInvalid`] from selector parsing.
    ///
    /// An empty side is an error rather than "matches nothing" because the two
    /// readings differ by everything: a request that produced an entry with no
    /// resources is a request that failed to say what it was for.
    pub fn new<A: AsRef<str>, R: AsRef<str>>(
        actions: &[A],
        resources: &[R],
    ) -> Result<Self, DomainError> {
        Self::from_scopes(actions, parse_scopes(resources)?)
    }

    /// Build an entry from already-parsed selectors.
    ///
    /// # Errors
    ///
    /// As [`Self::new`], minus the selector parsing.
    pub fn from_scopes<A: AsRef<str>>(
        actions: &[A],
        scopes: Vec<ResourceScope>,
    ) -> Result<Self, DomainError> {
        let invalid = |why: String| DomainError::PermissionEntryInvalid(why);
        if actions.is_empty() {
            return Err(invalid("names no actions".into()));
        }
        if actions.len() > MAX_ENTRY_ACTIONS {
            return Err(invalid(format!(
                "names {} actions, over the {MAX_ENTRY_ACTIONS} bound",
                actions.len()
            )));
        }
        if scopes.is_empty() {
            return Err(invalid("names no resources".into()));
        }
        if scopes.len() > MAX_ENTRY_SCOPES {
            return Err(invalid(format!(
                "names {} resources, over the {MAX_ENTRY_SCOPES} bound",
                scopes.len()
            )));
        }
        let mut names: Vec<String> = Vec::with_capacity(actions.len());
        for action in actions {
            let action = action.as_ref();
            if action.is_empty() {
                return Err(invalid("carries an empty action name".into()));
            }
            if action.len() > MAX_ACTION_LENGTH {
                return Err(invalid(format!("action {action:?} is too long")));
            }
            if action.chars().any(char::is_control) || action.trim() != action {
                return Err(invalid(format!("action {action:?} is not a bare name")));
            }
            names.push(action.to_string());
        }
        names.sort();
        names.dedup();
        let mut scopes = scopes;
        scopes.sort();
        scopes.dedup();
        Ok(Self {
            actions: names,
            scopes,
        })
    }

    #[must_use]
    pub fn actions(&self) -> &[String] {
        &self.actions
    }

    #[must_use]
    pub fn scopes(&self) -> &[ResourceScope] {
        &self.scopes
    }

    /// The selector strings, in the flat wire encoding.
    #[must_use]
    pub fn resource_patterns(&self) -> Vec<String> {
        self.scopes.iter().map(ResourceScope::encode).collect()
    }

    /// True when this entry names `action`.
    #[must_use]
    pub fn permits_action(&self, action: &str) -> bool {
        self.actions.iter().any(|name| name == action)
    }

    /// True when this entry covers `resource`.
    #[must_use]
    pub fn permits_resource(&self, resource: &str) -> bool {
        self.scopes.iter().any(|scope| scope.matches(resource))
    }

    /// True when this entry authorizes `action` **on** `resource`.
    ///
    /// Both halves come from the same entry. That conjunction is the whole
    /// mechanism: it is not expressible as "some entry allows the action" and
    /// "some entry allows the resource", which is the check this replaces.
    #[must_use]
    pub fn permits(&self, action: &str, resource: &str) -> bool {
        self.permits_action(action) && self.permits_resource(resource)
    }

    /// True when every pair `child` authorizes is authorized by `self`.
    ///
    /// Entry-to-entry, deliberately. A child entry must fit inside one parent
    /// entry; letting it draw its actions from one parent entry and its
    /// resources from another would rebuild the cross product that entries
    /// exist to prevent.
    #[must_use]
    pub fn contains(&self, child: &Self) -> bool {
        child
            .actions
            .iter()
            .all(|action| self.permits_action(action))
            && child
                .scopes
                .iter()
                .all(|scope| self.scopes.iter().any(|mine| mine.contains(scope)))
    }

    /// The pairs this entry authorizes, as `(action, selector)`.
    ///
    /// Bounded by `MAX_ENTRY_ACTIONS * MAX_ENTRY_SCOPES`. Used by the
    /// flattening check, which has to compare products pair by pair.
    #[must_use]
    pub fn pairs(&self) -> Vec<(&str, &ResourceScope)> {
        self.actions
            .iter()
            .flat_map(|action| {
                self.scopes
                    .iter()
                    .map(move |scope| (action.as_str(), scope))
            })
            .collect()
    }
}

impl TryFrom<PermissionEntryWire> for PermissionEntry {
    type Error = DomainError;

    fn try_from(wire: PermissionEntryWire) -> Result<Self, Self::Error> {
        Self::new(&wire.actions, &wire.resources)
    }
}

impl From<PermissionEntry> for PermissionEntryWire {
    fn from(entry: PermissionEntry) -> Self {
        Self {
            resources: entry.resource_patterns(),
            actions: entry.actions,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn both_halves_must_come_from_the_same_entry() {
        let entry = PermissionEntry::new(&["repository.read"], &["repo:acme/catalog"]).unwrap();
        assert!(entry.permits("repository.read", "repo:acme/catalog"));
        assert!(!entry.permits("repository.write", "repo:acme/catalog"));
        assert!(!entry.permits("repository.read", "repo:victim/secrets"));
    }

    #[test]
    fn an_entry_is_a_deliberate_product() {
        let entry = PermissionEntry::new(
            &["repository.read", "repository.write"],
            &["repo:acme/catalog", "repo:acme/docs"],
        )
        .unwrap();
        for action in ["repository.read", "repository.write"] {
            for resource in ["repo:acme/catalog", "repo:acme/docs"] {
                assert!(entry.permits(action, resource));
            }
        }
        assert_eq!(entry.pairs().len(), 4);
    }

    #[test]
    fn empty_sides_and_bad_names_are_refused() {
        let no_actions: [&str; 0] = [];
        assert!(PermissionEntry::new(&no_actions, &["repo:acme/catalog"]).is_err());
        let no_resources: [&str; 0] = [];
        assert!(PermissionEntry::new(&["repository.read"], &no_resources).is_err());
        assert!(PermissionEntry::new(&[""], &["repo:acme/catalog"]).is_err());
        assert!(PermissionEntry::new(&[" read"], &["repo:acme/catalog"]).is_err());
        assert!(PermissionEntry::new(&["read"], &["repo:acme*"]).is_err());
        let many: Vec<String> = (0..=MAX_ENTRY_ACTIONS).map(|i| format!("a{i}")).collect();
        assert!(PermissionEntry::new(&many, &["repo:acme/catalog"]).is_err());
    }

    #[test]
    fn canonical_form_is_sorted_and_deduplicated() {
        let entry = PermissionEntry::new(
            &["b", "a", "a"],
            &["repo:acme/z", "repo:acme/a", "repo:acme/a"],
        )
        .unwrap();
        assert_eq!(entry.actions(), ["a", "b"]);
        assert_eq!(entry.resource_patterns(), ["repo:acme/a", "repo:acme/z"]);
    }

    #[test]
    fn containment_is_per_entry_and_narrowing_only() {
        let parent =
            PermissionEntry::new(&["repository.read", "repository.write"], &["repo:acme/*"])
                .unwrap();
        let child = PermissionEntry::new(&["repository.read"], &["repo:acme/catalog"]).unwrap();
        assert!(parent.contains(&child));
        assert!(!child.contains(&parent));

        let elsewhere = PermissionEntry::new(&["repository.read"], &["repo:victim/x"]).unwrap();
        assert!(!parent.contains(&elsewhere));

        let extra_action =
            PermissionEntry::new(&["repository.admin"], &["repo:acme/catalog"]).unwrap();
        assert!(!parent.contains(&extra_action));
    }

    #[test]
    fn serde_round_trips_through_the_flat_vocabulary() {
        let entry =
            PermissionEntry::new(&["repository.read"], &["repo:acme/*", "repo:other/x"]).unwrap();
        let json = serde_json::to_value(&entry).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "actions": entry.actions(),
                "resources": entry.resource_patterns(),
            })
        );
        assert_eq!(
            serde_json::from_value::<PermissionEntry>(json).unwrap(),
            entry
        );
    }

    #[test]
    fn deserialize_refuses_what_the_constructor_refuses() {
        let hostile = serde_json::json!({"actions": ["read"], "resources": ["repo:acme*"]});
        assert!(serde_json::from_value::<PermissionEntry>(hostile).is_err());
        let empty = serde_json::json!({"actions": [], "resources": ["repo:acme/x"]});
        assert!(serde_json::from_value::<PermissionEntry>(empty).is_err());
    }
}
