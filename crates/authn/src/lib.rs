//! Authentication flows: device authorization, loopback PKCE, workload, CIBA selection.

pub mod device;
pub mod discovery;
pub mod flow;
pub mod pkce;
pub mod session;
pub mod token;

pub use device::*;
pub use discovery::*;
pub use flow::*;
pub use pkce::*;
pub use session::*;
pub use token::*;

#[cfg(test)]
mod adversarial;
