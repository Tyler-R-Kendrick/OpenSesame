//! Correlated permissions: an action is authorized *on* a resource, or not at
//! all.
//!
//! Authority in this repository was two lists and two checks — is the action in
//! `actions`, is the resource in `resources` — asked independently. Nothing in
//! that shape can tell "read A and write B" from "read or write, on A or B", so
//! an issuer who approved the first was enforcing the second and `write A` was
//! granted by accident. The types here fix the shape rather than the call site,
//! because every future call site would have had the same hole available.
//!
//! - [`ResourceScope`] — a selector is an exact id or a subtree bounded at a
//!   separator. A bare prefix and a regular expression are parse errors, so no
//!   matcher downstream decides what a pattern meant.
//! - [`PermissionEntry`] — actions together with the resources they apply to.
//!   One entry is a cross product *on purpose*; a check must find both halves
//!   of a pair in the same entry.
//! - [`PermissionSet`] — several entries. Converts from the flat pair exactly
//!   (one entry, no guessing) and refuses to convert back when the flat form
//!   would gain a pair ([`PermissionSet::flatten_lossless`]).
//! - [`RoleCatalog`] — named bundles of entries that concatenate, so holding
//!   two roles never crosses them.
//! - [`DynamicPermissionRule`] — a resource decided at claim time under a
//!   ceiling declared at issue time.
//! - [`PermissionManifest`] — the RFC 9396 `authorization_details` form, which
//!   already correlates; kept intact from prompt to digest to enforcement.
//!
//! ADR 0046 made `authorization_details` the delegation constraint, the
//! approval prompt and the enforcement predicate at once. These types are what
//! makes those three the same object rather than three readings of two lists.

pub mod dynamic;
pub mod entry;
pub mod grant_bridge;
pub mod manifest;
pub mod role;
pub mod scope;
pub mod set;

#[cfg(test)]
mod adversarial;

pub use dynamic::{
    DynamicPermissionRule, ResourceTemplate, MAX_BINDING_LENGTH, MAX_TEMPLATE_PLACEHOLDERS,
};
pub use entry::{
    PermissionEntry, PermissionEntryWire, MAX_ACTION_LENGTH, MAX_ENTRY_ACTIONS, MAX_ENTRY_SCOPES,
};
pub use grant_bridge::{assert_flat_grant_matches_entry, issue_flat};
pub use manifest::{PermissionManifest, PermissionManifestItem};
pub use role::{PermissionRole, RoleCatalog, MAX_CATALOG_ROLES, MAX_ROLE_NAME_LENGTH};
pub use scope::{parse_scopes, ResourceScope, ScopeSeparator, MAX_RESOURCE_LENGTH};
pub use set::{PermissionSet, MAX_SET_ENTRIES};
