//! Policy enforcement: OpenFGA relationships + contextual constraints via AuthZEN-shaped API.

pub mod authority_use;
pub mod authzen;
pub mod engine;
pub mod model;

pub use authority_use::*;
pub use authzen::*;
pub use engine::*;
pub use model::*;

#[cfg(test)]
mod adversarial;
