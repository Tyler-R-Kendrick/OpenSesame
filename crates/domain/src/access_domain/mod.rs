//! Access domains: a realm-bound forest of authority containers.
//!
//! An [`AccessDomain`] is a named place authority lives — the thing an operator
//! points at when they say "everything under Platform › Production". Domains
//! form a *forest*: several roots, each a tree, every node with at most one
//! parent. It is the general-authority shape that org/project alone could not
//! express, because a project is one level and real estates are nested.
//!
//! The one structural rule everything else rests on is that **a forest never
//! crosses a realm**. A [`Realm`] is the org/project boundary ADR 0038 already
//! established: `(organization, project)`, plus the project's kind. An
//! [`AccessDomainForest`] is created *for* a realm and refuses any node that
//! belongs to another one, so there is no code path — not insert, not
//! reparent — that moves a domain from one project into another.
//!
//! That refusal is not tidiness, it is what keeps two earlier decisions true:
//!
//! 1. **Vault project crypto binding.** `crates/human-vault` seals a
//!    `project_id` into every envelope's AEAD associated data (ADR 0038). A
//!    domain that carried a [`VaultBinding`] into a different project would
//!    name ciphertext whose associated data no longer matches — a silent
//!    decrypt failure at best. Since a binding takes its project from the
//!    realm and the realm cannot change, the binding cannot drift.
//! 2. **Personal projects do not share.** ADR 0038's personal project refuses
//!    membership entirely. A personal realm therefore admits control for at
//!    most one principal ([`ControlIndex::insert`]), so nesting domains inside
//!    a personal project organizes one person's estate and can never become a
//!    second, quieter sharing model.
//!
//! The module is pure: no clock of its own, no I/O, no storage. Every function
//! that depends on time takes the caller's reading, and every invariant is
//! re-checked at the mutation chokepoint rather than trusted from the input —
//! a forest handed to a caller has already passed them all.
//!
//! Layout:
//!
//! - [`realm`] — the org/project boundary and the project kinds.
//! - [`node`] — one domain, its slug rules, its accessors.
//! - [`forest`] — the index: roots, children, ancestors, paths, subtrees, and
//!   the acyclicity proof.
//! - [`mutate`] — create, rename, reparent, remove, prune.
//! - [`control`] — who administers a domain, and how control inherits down a
//!   subtree without ever widening.
//! - [`temporal`] — TTL-bound domains and the rule that a child never outlives
//!   its parent.
//! - [`bridge`] — the seams onto `AuthorityHandle`, vault bindings, the
//!   existing role ladders, and the frozen wire strings the TypeScript plane
//!   mirrors.

pub mod bridge;
pub mod control;
pub mod forest;
pub mod mutate;
pub mod node;
pub mod realm;
pub mod temporal;

#[cfg(test)]
mod control_tests;
#[cfg(test)]
mod proptests;
#[cfg(test)]
mod tests;

pub use bridge::{
    assert_handle_in_realm, handle_in_realm, VaultBinding, DOMAIN_INHERITANCE_WIRE,
    DOMAIN_LIFETIME_WIRE, DOMAIN_PROJECT_KIND_WIRE, DOMAIN_ROLE_WIRE, DOMAIN_SCOPE_WIRE,
};
pub use control::{
    ControlAssignment, ControlIndex, ControlScope, DomainRole, EffectiveControl, InheritanceMode,
};
pub use forest::{AccessDomainForest, MAX_DOMAIN_DEPTH};
pub use node::{AccessDomain, MAX_DOMAIN_DISPLAY_NAME_CHARS, MAX_DOMAIN_SLUG_CHARS};
pub use realm::{ProjectKind, Realm};
pub use temporal::{DomainLifetime, MAX_TEMPORARY_DOMAIN_LIFETIME};
