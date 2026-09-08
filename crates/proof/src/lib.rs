//! RFC 9449 `DPoP` validation and constrained key custody for `OpenSesame`.

pub mod custody;
pub mod error;
pub mod http_message_signature;
pub mod jwk;
pub mod replay;
pub mod validator;

pub use custody::*;
pub use error::*;
pub use http_message_signature::*;
pub use jsonwebtoken::EncodingKey as ProofSigningKey;
pub use jwk::*;
pub use replay::*;
pub use validator::*;

#[cfg(test)]
mod adversarial;
