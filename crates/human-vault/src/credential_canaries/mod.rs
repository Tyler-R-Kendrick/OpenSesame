//! Detection-only high-entropy identifiers. None of these types grant vault authority.
mod device_state;
mod observe;
mod owner_test;
mod protocol;
pub mod receiver;
mod records;
mod validator;

pub use device_state::{DeviceState, OwnerTestWitness, MAX_DEVICE_STATE_BYTES};
pub use observe::{CanaryResponse, Decision, Observation};
pub use protocol::{
    decode_presented_id, digest, encode_presented_id, mint_presented_id, parse_reference,
    reference, ArtifactContext, ArtifactKind, CanaryError, Phase,
};
pub use records::{Artifact, ArtifactState, CreatedArtifact, Event, Registry};
pub use validator::{controlled_mcp_response, InstalledValidator, ValidatorBinding};

pub const MAX_ARTIFACTS: usize = 16;
pub const MAX_EVENTS: usize = 64;
pub const MAX_REGISTRY_BYTES: usize = 32_768;

#[cfg(test)]
mod tests;
