//! Bounded public-API oracles shared by libFuzzer and deterministic controls.
mod canary;
mod fixture;
mod outbox;
mod retired;
mod wire;
pub use canary::canary_registry;
pub use outbox::outbox_fsm;
pub use retired::retired_records;
pub use wire::observation_wire;
