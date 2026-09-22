//! `OpenSesame` canonical domain model.
//!
//! Stable principal identity is independent of keys, hostnames, and provider IDs.

pub mod access_domain;
pub mod authentication_policy;
pub mod authority;
pub mod authority_context;
pub mod authorization_requirement;
pub mod availability;
/// Budget reservation, settlement, and inheritance.
///
/// Deliberately **not** glob re-exported below: `Limit`, `Limits`, `Meter` and
/// `Quantity` are meaningful names that would collide in the crate root, and a
/// budget is easier to reason about when the call site says `budget::` out
/// loud.
pub mod budget;
pub mod canonical;
pub mod capability;
pub mod claim;
pub mod cohort;
pub mod cohort_activation;
pub mod cohort_admission;
pub mod cohort_diff;
pub mod cohort_graph;
pub mod cohort_path;
pub mod cohort_resolution;
pub mod connection;
pub mod delegation_chain;
pub mod error;
pub mod frozen_intent;
pub mod grant;
pub mod grant_attenuation;
pub mod grant_budgets;
pub mod grant_lineage;
pub mod ids;
pub mod intent;
pub mod invocation;
pub mod mediation;
pub mod organization;
pub mod permission;
pub mod permission_entry;
pub mod proof;
pub mod protected_resource;
pub mod protocol_profile;
pub mod provider;
pub mod receipt;
pub mod session_coordination;
mod session_coordination_adversarial;
pub mod session_invite;
mod session_link_adversarial;
pub mod shared_session;
mod shared_session_adversarial;
pub mod task;
pub mod transport;
pub mod validated_grant_chain;
pub mod verification_evidence;

#[cfg(test)]
mod authority_adversarial_fixtures;
#[cfg(test)]
mod authority_adversarial_matrix;
#[cfg(test)]
mod canonical_adversarial;
#[cfg(test)]
mod cohort_activation_adversarial;
#[cfg(test)]
mod cohort_admission_adversarial;
#[cfg(test)]
mod cohort_adversarial;
#[cfg(test)]
mod cohort_diff_adversarial;
#[cfg(test)]
mod cohort_fixture;
#[cfg(test)]
mod cohort_path_adversarial;
#[cfg(test)]
mod fix_contractor;
#[cfg(test)]
mod fix_family;
#[cfg(test)]
mod fix_raid;
#[cfg(test)]
mod fix_workcell;
#[cfg(test)]
mod grant_adversarial;
#[cfg(test)]
mod grant_lineage_adversarial;
#[cfg(test)]
mod honest_attacks;
#[cfg(test)]
mod invocation_adversarial;

pub use access_domain::*;
pub use authentication_policy::*;
pub use authority::*;
pub use authority_context::*;
pub use authorization_requirement::*;
pub use availability::*;
pub use canonical::*;
pub use capability::*;
pub use claim::*;
pub use cohort::*;
pub use cohort_activation::*;
pub use cohort_admission::*;
pub use cohort_diff::*;
pub use cohort_graph::*;
pub use cohort_path::*;
pub use cohort_resolution::*;
pub use connection::*;
pub use delegation_chain::*;
pub use error::*;
pub use frozen_intent::*;
pub use grant::*;
pub use validated_grant_chain::*;
// superseded by permission:: — pub use permission_entry::*;
pub use ids::*;
pub use intent::*;
pub use invocation::*;
pub use mediation::*;
pub use organization::*;
// Named rather than glob: the module's bounds constants belong to the module,
// and `capability` already exports a differently-shaped `ResourceSelector`, so
// an explicit root surface is what keeps the two selector vocabularies from
// reading as one.
pub use permission::{
    assert_flat_grant_matches_entry, issue_flat, DynamicPermissionRule, PermissionEntry,
    PermissionManifest, PermissionManifestItem, PermissionRole, PermissionSet, ResourceScope,
    ResourceTemplate, RoleCatalog, ScopeSeparator,
};
pub use proof::*;
pub use protected_resource::*;
pub use protocol_profile::*;
pub use provider::*;
pub use receipt::*;
pub use session_coordination::*;
pub use session_invite::*;
pub use shared_session::*;
pub use task::*;
pub use transport::*;
pub use verification_evidence::*;
