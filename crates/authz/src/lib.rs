//! Policy enforcement: OpenFGA relationships + contextual constraints via AuthZEN-shaped API.

pub mod authzen;
pub mod authority_use;
pub mod engine;
pub mod model;

pub use authzen::*;
pub use authority_use::*;
pub use engine::*;
pub use model::*;

#[cfg(test)]
mod adversarial;
