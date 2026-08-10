//! MCP Authorization 2026-07-28 Bearer profile adapter.
//!
//! Bearer presentation only. Inbound tokens are never forwarded downstream.

pub mod error;
pub mod passthrough;
pub mod profile;
pub mod validation;

pub use error::*;
pub use passthrough::*;
pub use profile::*;
pub use validation::*;

#[cfg(test)]
mod tests;
