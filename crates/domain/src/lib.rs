//! OpenSesame canonical domain model.
//!
//! Stable principal identity is independent of keys, hostnames, and provider IDs.

pub mod availability;
pub mod authority;
pub mod authority_context;
pub mod authorization_requirement;
pub mod canonical;
pub mod capability;
pub mod delegation_chain;
pub mod error;
pub mod frozen_intent;
pub mod grant;
pub mod ids;
pub mod intent;
pub mod invocation;
pub mod mediation;
pub mod proof;
pub mod protocol_profile;
pub mod protected_resource;
pub mod receipt;
pub mod claim;
pub mod connection;
pub mod authentication_policy;
pub mod task;
pub mod verification_evidence;

#[cfg(test)]
mod canonical_adversarial;
#[cfg(test)]
mod grant_adversarial;
#[cfg(test)]
mod invocation_adversarial;

pub use availability::*;
pub use authority::*;
pub use authority_context::*;
pub use authorization_requirement::*;
pub use canonical::*;
pub use capability::*;
pub use delegation_chain::*;
pub use error::*;
pub use frozen_intent::*;
pub use grant::*;
pub use ids::*;
pub use intent::*;
pub use invocation::*;
pub use mediation::*;
pub use proof::*;
pub use protocol_profile::*;
pub use protected_resource::*;
pub use receipt::*;
pub use claim::*;
pub use connection::*;
pub use authentication_policy::*;
pub use task::*;
pub use verification_evidence::*;
