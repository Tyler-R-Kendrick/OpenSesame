//! The manifest a ceremony shows, digests, and issues from.
//!
//! RFC 9396 already got this right: an `authorization_details` element carries
//! its own `actions` **and** its own `locations`, so a request for "read A" and
//! "write B" is two elements and never four pairs. The loss happened on the
//! way in, when a list of elements was unioned into two flat fields before it
//! reached a grant. A manifest keeps the elements, so what the approver read,
//! what the digest covers and what the enforcer checks are one object.
//!
//! Conversion is deliberately strict rather than forgiving. An element with
//! actions and no locations is refused instead of read as "anywhere": the
//! whole failure mode being fixed here is a resource scope that was decorative
//! because nobody said what it was.

use crate::permission::entry::PermissionEntry;
use crate::permission::set::{PermissionSet, MAX_SET_ENTRIES};
use crate::{canonicalize_json, digest_sha256, DomainError};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// One manifest item: an RFC 9396 detail type plus the authority it carries.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PermissionManifestItem {
    /// The RFC 9396 `type`. Carried through so the approval prompt, the
    /// digest and the receipt all name the same operation family.
    #[serde(rename = "type")]
    pub detail_type: String,
    pub entry: PermissionEntry,
}

/// An ordered manifest of correlated items.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PermissionManifest {
    pub items: Vec<PermissionManifestItem>,
}

fn invalid(index: usize, why: &str) -> DomainError {
    DomainError::PermissionEntryInvalid(format!("authorization_details[{index}]: {why}"))
}

fn string_list(
    value: Option<&Value>,
    index: usize,
    field: &str,
) -> Result<Vec<String>, DomainError> {
    let Some(value) = value else {
        return Err(invalid(index, &format!("names no {field}")));
    };
    let Some(items) = value.as_array() else {
        return Err(invalid(index, &format!("{field} is not an array")));
    };
    items
        .iter()
        .map(|item| {
            item.as_str()
                .map(str::to_string)
                .ok_or_else(|| invalid(index, &format!("{field} carries a non-string")))
        })
        .collect()
}

impl PermissionManifest {
    /// Read a manifest out of an RFC 9396 `authorization_details` array.
    ///
    /// # Errors
    ///
    /// Returns [`DomainError::PermissionEntryInvalid`] for an element with no
    /// `type`, no `actions` or no `locations`, for a non-array or non-string
    /// member, or for more than [`MAX_SET_ENTRIES`] elements; propagates
    /// [`DomainError::ResourceSelectorInvalid`] from selector parsing.
    ///
    /// `identifier` is accepted as a single-location shorthand because RFC 9396
    /// defines it, but it is added to `locations` rather than treated as a
    /// separate axis — one resource list per element, or the correlation is
    /// back to being two lists.
    pub fn from_authorization_details(details: &[Value]) -> Result<Self, DomainError> {
        if details.is_empty() {
            return Err(DomainError::PermissionEntryInvalid(
                "authorization_details is empty".into(),
            ));
        }
        if details.len() > MAX_SET_ENTRIES {
            return Err(DomainError::PermissionEntryInvalid(format!(
                "authorization_details carries {} elements, over the {MAX_SET_ENTRIES} bound",
                details.len()
            )));
        }
        let mut items = Vec::with_capacity(details.len());
        for (index, detail) in details.iter().enumerate() {
            let object = detail
                .as_object()
                .ok_or_else(|| invalid(index, "is not an object"))?;
            let detail_type = object
                .get("type")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| invalid(index, "has no type"))?
                .to_string();
            let actions = string_list(object.get("actions"), index, "actions")?;
            let mut locations = string_list(object.get("locations"), index, "locations")?;
            if let Some(identifier) = object.get("identifier") {
                let identifier = identifier
                    .as_str()
                    .ok_or_else(|| invalid(index, "identifier is not a string"))?;
                locations.push(identifier.to_string());
            }
            let entry = PermissionEntry::new(&actions, &locations)?;
            items.push(PermissionManifestItem { detail_type, entry });
        }
        Ok(Self { items })
    }

    /// The authority this manifest carries, with correlation intact.
    ///
    /// # Errors
    ///
    /// Propagates [`PermissionSet::new`].
    pub fn to_permission_set(&self) -> Result<PermissionSet, DomainError> {
        PermissionSet::new(self.items.iter().map(|item| item.entry.clone()).collect())
    }

    /// Render back to `authorization_details`, element per item.
    #[must_use]
    pub fn to_authorization_details(&self) -> Vec<Value> {
        self.items
            .iter()
            .map(|item| {
                serde_json::json!({
                    "type": item.detail_type,
                    "actions": item.entry.actions(),
                    "locations": item.entry.resource_patterns(),
                })
            })
            .collect()
    }

    /// Canonical digest of the manifest as approved.
    ///
    /// # Errors
    ///
    /// Propagates [`DomainError::Canonicalization`].
    pub fn digest(&self) -> Result<String, DomainError> {
        let value = Value::Array(self.to_authorization_details());
        Ok(digest_sha256(&canonicalize_json(&value)?))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn details() -> Vec<Value> {
        vec![
            json!({
                "type": "connector_operation",
                "actions": ["repository.read"],
                "locations": ["repo:acme/catalog"],
            }),
            json!({
                "type": "connector_operation",
                "actions": ["repository.write"],
                "locations": ["repo:acme/docs"],
            }),
        ]
    }

    #[test]
    fn two_details_stay_two_entries() {
        let manifest = PermissionManifest::from_authorization_details(&details()).unwrap();
        let set = manifest.to_permission_set().unwrap();
        assert_eq!(set.entries().len(), 2);
        assert!(set.permits("repository.read", "repo:acme/catalog"));
        assert!(set.permits("repository.write", "repo:acme/docs"));
        assert!(!set.permits("repository.write", "repo:acme/catalog"));
    }

    #[test]
    fn a_manifest_cannot_be_flattened_into_one_grant() {
        let set = PermissionManifest::from_authorization_details(&details())
            .unwrap()
            .to_permission_set()
            .unwrap();
        assert!(matches!(
            set.flatten_lossless(),
            Err(DomainError::PermissionCorrelationLost(_))
        ));
        // The honest issuance is one flat record per element.
        assert_eq!(set.split_flat().len(), 2);
    }

    #[test]
    fn a_detail_must_say_what_it_is_for() {
        for detail in [
            json!({"type": "connector_operation", "actions": ["read"]}),
            json!({"type": "connector_operation", "locations": ["repo:acme/catalog"]}),
            json!({"actions": ["read"], "locations": ["repo:acme/catalog"]}),
            json!({"type": "", "actions": ["read"], "locations": ["repo:acme/catalog"]}),
            json!({"type": "x", "actions": "read", "locations": ["repo:acme/catalog"]}),
            json!({"type": "x", "actions": [1], "locations": ["repo:acme/catalog"]}),
            json!({"type": "x", "actions": ["read"], "locations": ["repo:acme*"]}),
            json!("not an object"),
        ] {
            assert!(
                PermissionManifest::from_authorization_details(&[detail.clone()]).is_err(),
                "{detail} must not parse"
            );
        }
        assert!(PermissionManifest::from_authorization_details(&[]).is_err());
    }

    #[test]
    fn identifier_is_a_location_not_a_second_axis() {
        let manifest = PermissionManifest::from_authorization_details(&[json!({
            "type": "connector_operation",
            "actions": ["repository.read"],
            "locations": ["repo:acme/catalog"],
            "identifier": "repo:acme/docs",
        })])
        .unwrap();
        let set = manifest.to_permission_set().unwrap();
        assert!(set.permits("repository.read", "repo:acme/docs"));
        assert_eq!(set.entries().len(), 1);
    }

    #[test]
    fn rendering_round_trips_and_the_digest_follows_correlation() {
        let manifest = PermissionManifest::from_authorization_details(&details()).unwrap();
        let rendered = manifest.to_authorization_details();
        let again = PermissionManifest::from_authorization_details(&rendered).unwrap();
        assert_eq!(manifest, again);
        assert_eq!(manifest.digest().unwrap(), again.digest().unwrap());

        let crossed = PermissionManifest::from_authorization_details(&[json!({
            "type": "connector_operation",
            "actions": ["repository.read", "repository.write"],
            "locations": ["repo:acme/catalog", "repo:acme/docs"],
        })])
        .unwrap();
        assert_ne!(manifest.digest().unwrap(), crossed.digest().unwrap());
    }
}
