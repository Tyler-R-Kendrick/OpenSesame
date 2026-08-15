//! Capability algebra with Exact/Enumerated resource selectors only.
//!
//! Attenuation is fail-closed: widening authority returns `Disproven` or
//! `RequiresPolicyDecision`, never silent acceptance.

use crate::{canonicalize_json, digest_sha256, DomainError};
use serde::{Deserialize, Serialize};

/// Resource selector — only Exact and Enumerated variants are permitted.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum ResourceSelector {
    Exact { value: String },
    Enumerated { values: Vec<String> },
}

impl ResourceSelector {
    pub fn exact(value: impl Into<String>) -> Self {
        Self::Exact {
            value: value.into(),
        }
    }

    pub fn enumerated(values: impl IntoIterator<Item = impl Into<String>>) -> Self {
        Self::Enumerated {
            values: values.into_iter().map(Into::into).collect(),
        }
    }

    /// Whether every resource covered by `self` is also covered by `parent`.
    pub fn is_subset_of(&self, parent: &Self) -> bool {
        match (self, parent) {
            (Self::Exact { value }, Self::Exact { value: p }) => value == p,
            (Self::Exact { value }, Self::Enumerated { values }) => {
                values.iter().any(|v| v == value)
            }
            (Self::Enumerated { values: child }, Self::Enumerated { values: parent }) => {
                child.iter().all(|c| parent.iter().any(|p| p == c))
            }
            (Self::Enumerated { .. }, Self::Exact { .. }) => false,
        }
    }

    pub fn canonicalize(&self) -> Self {
        match self {
            Self::Exact { value } => Self::Exact {
                value: value.clone(),
            },
            Self::Enumerated { values } => {
                let mut v = values.clone();
                v.sort();
                v.dedup();
                Self::Enumerated { values: v }
            }
        }
    }
}

/// A single capability: action + resource selector.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Capability {
    pub action: String,
    pub resource: ResourceSelector,
}

impl Capability {
    pub fn new(action: impl Into<String>, resource: ResourceSelector) -> Self {
        Self {
            action: action.into(),
            resource,
        }
    }

    pub fn canonicalize(&self) -> Self {
        Self {
            action: self.action.clone(),
            resource: self.resource.canonicalize(),
        }
    }

    /// Fail-closed attenuation check against a parent capability.
    pub fn is_attenuation_of(&self, parent: &Self) -> AttenuationResult {
        if self.action != parent.action {
            return AttenuationResult::Disproven;
        }
        if self.resource.is_subset_of(&parent.resource) {
            AttenuationResult::Proven
        } else {
            AttenuationResult::Disproven
        }
    }
}

/// Ordered set of capabilities with set algebra.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct CapabilitySet {
    pub capabilities: Vec<Capability>,
}

impl CapabilitySet {
    pub fn new(capabilities: Vec<Capability>) -> Self {
        Self { capabilities }
    }

    pub fn empty() -> Self {
        Self::default()
    }

    pub fn canonicalize(&self) -> Self {
        let mut caps: Vec<Capability> = self
            .capabilities
            .iter()
            .map(Capability::canonicalize)
            .collect();
        caps.sort_by(|a, b| {
            a.action
                .cmp(&b.action)
                .then_with(|| selector_sort_key(&a.resource).cmp(&selector_sort_key(&b.resource)))
        });
        caps.dedup_by(|a, b| a.action == b.action && a.resource == b.resource);
        Self { capabilities: caps }
    }

    pub fn is_subset_of(&self, other: &Self) -> bool {
        let self_c = self.canonicalize();
        let other_c = other.canonicalize();
        self_c.capabilities.iter().all(|c| {
            other_c
                .capabilities
                .iter()
                .any(|p| c.is_attenuation_of(p) == AttenuationResult::Proven)
        })
    }

    pub fn intersection(&self, other: &Self) -> Self {
        let self_c = self.canonicalize();
        let other_c = other.canonicalize();
        let mut out = Vec::new();
        for a in &self_c.capabilities {
            for b in &other_c.capabilities {
                if a.action != b.action {
                    continue;
                }
                if let Some(inter) = intersect_selectors(&a.resource, &b.resource) {
                    out.push(Capability {
                        action: a.action.clone(),
                        resource: inter,
                    });
                }
            }
        }
        Self::new(out).canonicalize()
    }

    /// Remove capabilities matching `action` and covered by `selector`.
    pub fn remove(&self, action: &str, selector: &ResourceSelector) -> Self {
        let self_c = self.canonicalize();
        let mut out = Vec::new();
        for cap in &self_c.capabilities {
            if cap.action != action {
                out.push(cap.clone());
                continue;
            }
            if cap.resource.is_subset_of(selector) {
                continue;
            }
            if let Some(remainder) = subtract_selector(&cap.resource, selector) {
                for r in remainder {
                    out.push(Capability {
                        action: cap.action.clone(),
                        resource: r,
                    });
                }
            }
        }
        Self::new(out).canonicalize()
    }

    pub fn digest(&self) -> Result<String, DomainError> {
        let v = serde_json::to_value(self.canonicalize())
            .map_err(|e| DomainError::Canonicalization(e.to_string()))?;
        Ok(digest_sha256(&canonicalize_json(&v)?))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AttenuationResult {
    Proven,
    Disproven,
    RequiresPolicyDecision,
}

fn selector_sort_key(sel: &ResourceSelector) -> String {
    match sel {
        ResourceSelector::Exact { value } => format!("exact:{value}"),
        ResourceSelector::Enumerated { values } => {
            format!("enum:{}", values.join(","))
        }
    }
}

fn intersect_selectors(a: &ResourceSelector, b: &ResourceSelector) -> Option<ResourceSelector> {
    match (a, b) {
        (ResourceSelector::Exact { value: va }, ResourceSelector::Exact { value: vb }) => {
            if va == vb {
                Some(ResourceSelector::Exact { value: va.clone() })
            } else {
                None
            }
        }
        (ResourceSelector::Exact { value }, ResourceSelector::Enumerated { values })
        | (ResourceSelector::Enumerated { values }, ResourceSelector::Exact { value }) => {
            if values.contains(value) {
                Some(ResourceSelector::Exact {
                    value: value.clone(),
                })
            } else {
                None
            }
        }
        (
            ResourceSelector::Enumerated { values: va },
            ResourceSelector::Enumerated { values: vb },
        ) => {
            let inter: Vec<String> = va.iter().filter(|v| vb.contains(v)).cloned().collect();
            if inter.is_empty() {
                None
            } else if inter.len() == 1 {
                Some(ResourceSelector::Exact {
                    value: inter[0].clone(),
                })
            } else {
                Some(ResourceSelector::Enumerated { values: inter }.canonicalize())
            }
        }
    }
}

fn subtract_selector(
    cap: &ResourceSelector,
    remove: &ResourceSelector,
) -> Option<Vec<ResourceSelector>> {
    if cap.is_subset_of(remove) {
        return None;
    }
    match (cap, remove) {
        (
            ResourceSelector::Enumerated { values: cap_vals },
            ResourceSelector::Enumerated { values: rem_vals },
        ) => {
            let remainder: Vec<String> = cap_vals
                .iter()
                .filter(|v| !rem_vals.contains(v))
                .cloned()
                .collect();
            if remainder.is_empty() {
                None
            } else {
                Some(vec![
                    ResourceSelector::Enumerated { values: remainder }.canonicalize()
                ])
            }
        }
        (
            ResourceSelector::Enumerated { values: cap_vals },
            ResourceSelector::Exact { value: rem },
        ) => {
            let remainder: Vec<String> = cap_vals.iter().filter(|v| *v != rem).cloned().collect();
            if remainder.is_empty() {
                None
            } else if remainder.len() == 1 {
                Some(vec![ResourceSelector::Exact {
                    value: remainder[0].clone(),
                }])
            } else {
                Some(vec![
                    ResourceSelector::Enumerated { values: remainder }.canonicalize()
                ])
            }
        }
        _ => Some(vec![cap.clone()]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    fn cap(action: &str, resource: &str) -> Capability {
        Capability::new(action, ResourceSelector::exact(resource))
    }

    #[test]
    fn exact_subset() {
        let child = ResourceSelector::exact("repo:a");
        let parent = ResourceSelector::enumerated(["repo:a", "repo:b"]);
        assert!(child.is_subset_of(&parent));
        assert!(!parent.is_subset_of(&child));
    }

    #[test]
    fn attenuation_proven() {
        let parent = cap("read", "repo:a");
        let child = cap("read", "repo:a");
        assert_eq!(child.is_attenuation_of(&parent), AttenuationResult::Proven);
    }

    #[test]
    fn attenuation_disproven_on_action() {
        let parent = cap("read", "repo:a");
        let child = cap("write", "repo:a");
        assert_eq!(
            child.is_attenuation_of(&parent),
            AttenuationResult::Disproven
        );
    }

    #[test]
    fn intersection_exact_enum() {
        let a = CapabilitySet::new(vec![cap("read", "repo:a")]);
        let b = CapabilitySet::new(vec![Capability::new(
            "read",
            ResourceSelector::enumerated(["repo:a", "repo:b"]),
        )]);
        let inter = a.intersection(&b);
        assert_eq!(inter.capabilities.len(), 1);
        assert_eq!(
            inter.capabilities[0].resource,
            ResourceSelector::exact("repo:a")
        );
    }

    #[test]
    fn remove_never_adds() {
        let set = CapabilitySet::new(vec![cap("read", "repo:a"), cap("read", "repo:b")]);
        let before = set.digest().unwrap();
        let after = set.remove("read", &ResourceSelector::exact("repo:a"));
        assert!(after.capabilities.len() <= set.capabilities.len());
        assert_ne!(after.digest().unwrap(), before);
    }

    #[test]
    fn digest_order_independent() {
        let a = CapabilitySet::new(vec![cap("read", "repo:b"), cap("read", "repo:a")]);
        let b = CapabilitySet::new(vec![cap("read", "repo:a"), cap("read", "repo:b")]);
        assert_eq!(a.digest().unwrap(), b.digest().unwrap());
    }

    fn arb_resource_selector() -> impl Strategy<Value = ResourceSelector> {
        prop_oneof![
            "[a-z]{1,8}".prop_map(ResourceSelector::exact),
            prop::collection::vec("[a-z]{1,8}", 1..5)
                .prop_map(|v| ResourceSelector::enumerated(v).canonicalize()),
        ]
    }

    fn arb_capability() -> impl Strategy<Value = Capability> {
        ("[a-z]{1,6}", arb_resource_selector())
            .prop_map(|(action, resource)| Capability::new(action, resource))
    }

    fn arb_capability_set() -> impl Strategy<Value = CapabilitySet> {
        prop::collection::vec(arb_capability(), 0..6)
            .prop_map(|caps| CapabilitySet::new(caps).canonicalize())
    }

    proptest! {
        #[test]
        fn subset_reflexive(set in arb_capability_set()) {
            prop_assert!(set.is_subset_of(&set));
        }

        #[test]
        fn intersection_is_subset_of_both(a in arb_capability_set(), b in arb_capability_set()) {
            let inter = a.intersection(&b);
            prop_assert!(inter.is_subset_of(&a));
            prop_assert!(inter.is_subset_of(&b));
        }

        #[test]
        fn remove_never_increases_size(set in arb_capability_set(), action in "[a-z]{1,6}", sel in arb_resource_selector()) {
            let removed = set.remove(&action, &sel);
            prop_assert!(removed.capabilities.len() <= set.capabilities.len());
        }

        #[test]
        fn digest_stable_under_permutation(caps in prop::collection::vec(arb_capability(), 1..5)) {
            let forward = CapabilitySet::new(caps.clone()).digest().unwrap();
            let mut reversed = caps;
            reversed.reverse();
            let backward = CapabilitySet::new(reversed).digest().unwrap();
            prop_assert_eq!(forward, backward);
        }
    }
}

#[cfg(kani)]
mod kani_proofs {
    use super::*;

    fn small_str() -> String {
        let bytes: [u8; 2] = kani::any();
        let a = (bytes[0] % 26) + b'a';
        let b = (bytes[1] % 26) + b'a';
        String::from_utf8(vec![a, b]).unwrap()
    }

    fn any_selector() -> ResourceSelector {
        if kani::any() {
            ResourceSelector::exact(small_str())
        } else {
            ResourceSelector::enumerated([small_str(), small_str()])
        }
    }

    #[kani::proof]
    fn subset_reflexive() {
        let sel = any_selector();
        assert!(sel.is_subset_of(&sel));
    }

    #[kani::proof]
    fn different_action_is_disproven() {
        let parent = Capability::new("read", ResourceSelector::exact("r"));
        let child = Capability::new("write", ResourceSelector::exact("r"));
        assert_eq!(child.is_attenuation_of(&parent), AttenuationResult::Disproven);
    }

    #[kani::proof]
    fn intersection_is_subset() {
        let a = CapabilitySet::new(vec![Capability::new("a", any_selector())]).canonicalize();
        let b = CapabilitySet::new(vec![Capability::new("a", any_selector())]).canonicalize();
        let inter = a.intersection(&b);
        assert!(inter.is_subset_of(&a));
        assert!(inter.is_subset_of(&b));
    }

    #[kani::proof]
    fn remove_never_increases() {
        let set = CapabilitySet::new(vec![Capability::new(small_str(), any_selector())]);
        let removed = set.remove("a", &any_selector());
        assert!(removed.capabilities.len() <= set.canonicalize().capabilities.len());
    }
}
