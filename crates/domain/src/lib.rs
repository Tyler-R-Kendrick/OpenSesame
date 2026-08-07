//! OpenSesame canonical domain model.
//!
//! Stable principal identity is independent of keys, hostnames, and provider IDs.

pub mod availability;
pub mod authority;
pub mod canonical;
pub mod error;
pub mod grant;
pub mod ids;
pub mod intent;
pub mod invocation;
pub mod receipt;
pub mod claim;
pub mod connection;
pub mod authentication_policy;

#[cfg(test)]
mod canonical_adversarial;
#[cfg(test)]
mod grant_adversarial;
#[cfg(test)]
mod invocation_adversarial;

pub use availability::*;
pub use authority::*;
pub use canonical::*;
pub use error::*;
pub use grant::*;
pub use ids::*;
pub use intent::*;
pub use invocation::*;
pub use receipt::*;
pub use claim::*;
pub use connection::*;
pub use authentication_policy::*;
