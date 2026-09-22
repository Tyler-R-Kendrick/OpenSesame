//! Policy enforcement: `OpenFGA` relationships + contextual constraints via AuthZEN-shaped API.
//!
//! The decision path is typed end to end: a closed condition algebra
//! ([`condition`], [`condition_set`]), requirements that only verified evidence
//! can satisfy ([`evidence`]), one combining rule ([`combine`]), typed refusals
//! ([`error`]) and an explanation projected from them ([`explain`]).

pub mod authority_use;
pub mod authzen;
pub mod callout;
pub mod combine;
pub mod condition;
pub mod condition_set;
pub mod duress;
pub mod enforcement_gate;
pub mod engine;
pub mod error;
pub mod evaluate;
pub mod evidence;
pub mod explain;
pub mod issuance;
pub mod model;

pub use authority_use::*;
pub use authzen::*;
pub use callout::*;
pub use combine::*;
pub use condition::*;
pub use condition_set::*;
pub use enforcement_gate::*;
pub use engine::*;
pub use error::*;
pub use evaluate::*;
pub use evidence::*;
pub use explain::*;
pub use issuance::*;
pub use model::*;

#[cfg(test)]
mod adversarial;
#[cfg(test)]
mod authority_use_contract;
#[cfg(test)]
mod enforcement_gate_contract;
#[cfg(test)]
mod engine_contract;
