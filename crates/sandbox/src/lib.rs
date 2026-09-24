//! `OpenSesame` **sandbox** — bounded, brokered execution for general authority.
//!
//! This crate runs untrusted code on behalf of a principal without giving it
//! anything ambient. It is the general-authority sibling of
//! `opensesame-connector-host`'s component runtime: same posture, different
//! shape. Connectors are published components with a manifest, a pinned
//! digest, and a fixed WIT world; a sandboxed run is arbitrary guest code
//! whose entire authority is derived from a grant chain at spawn time.
//!
//! # The five properties
//!
//! - **Profile** ([`SandboxProfile`], [`profile`]) — what a run may reach and
//!   consume, derived only from an [`opensesame_domain::ValidatedGrantChain`].
//!   There is no other constructor, no `Default`, and no `Deserialize`, so a
//!   profile cannot be wished into existence or replayed off the wire.
//! - **Spawn** ([`runtime`]) — a fresh Wasmtime store per run, with fuel, an
//!   epoch deadline, and a memory cap set before the guest executes an
//!   instruction. A payload that is not a wasm core module is **refused**:
//!   an ELF, a Mach-O, a PE or a `#!` script has no containment story here,
//!   and running it anyway would be worse than refusing it.
//! - **Boundary** ([`Broker`], [`boundary`]) — the guest's whole world is one
//!   import module holding at most four host functions. There is no
//!   filesystem, environment, socket, clock or entropy import to link, so
//!   ambient authority is denied by construction rather than by a check
//!   somebody could forget. Imports outside that module are refused at link
//!   time, before instantiation.
//! - **Revoke** ([`RevocationLedger`], [`revoke`]) — a generation fence that
//!   both closes the boundary and traps a running guest, so revocation
//!   reaches work already in flight and not just the next request.
//! - **Test** (`tests/`) — hostile guests compiled from WAT and run on the
//!   real engine: WASI importers, fuel burners, memory bombs, out-of-bounds
//!   pointers, emit floods, and a revocation landing mid-loop.
//!
//! # What is deliberately absent
//!
//! No `get_secret`, no credential in guest memory, and no token bytes: a
//! guest that acquires a token gets an opaque integer handle. That is the
//! same rule the connector host enforces (ADR 0005), stated in an ABI
//! rather than in a WIT world.
//!
//! # Feature flags
//!
//! The Wasmtime dependency sits behind `wasm-runtime`, default-off, so the
//! policy types can be depended on by trees that must not link a JIT. The
//! `fixtures` feature exposes grant-chain builders for tests.

#![forbid(unsafe_code)]

pub mod boundary;
pub mod budget;
pub mod capability;
pub mod error;
pub mod format;
pub mod profile;
pub mod revoke;

#[cfg(any(test, feature = "fixtures"))]
pub mod fixtures;

#[cfg(feature = "wasm-runtime")]
pub mod runtime;

pub use boundary::{Broker, DenyAll, ImportKind, Refusal, RunContext};
pub use budget::ResourceBudget;
pub use capability::{AmbientKind, BrokeredCapability, BROKERED_MODULE, ENTRY_POINT, GUEST_MEMORY};
pub use error::SandboxError;
pub use format::GuestFormat;
pub use profile::{AmbientDenial, SandboxProfile};
pub use revoke::{RevocationFence, RevocationLedger};

#[cfg(feature = "wasm-runtime")]
pub use runtime::{KillSwitch, RunOutcome, Sandbox};

/// The WIT package this crate's authority model is stated against.
///
/// The brokered ABI here is core-wasm rather than a component world, but the
/// authority it carries is `opensesame:core`'s: opaque handles, brokered
/// invocation, no materialization.
pub mod wit_contract {
    /// The shared IR package (`spec/wit/core/world.wit`).
    pub const PACKAGE: &str = "opensesame:core@1.0.0";
}

#[cfg(test)]
mod contract {
    use super::{
        wit_contract, AmbientDenial, BrokeredCapability, GuestFormat, ResourceBudget,
        BROKERED_MODULE,
    };

    #[test]
    fn the_crate_states_the_core_contract_it_enforces() {
        assert_eq!(wit_contract::PACKAGE, "opensesame:core@1.0.0");
    }

    #[test]
    fn the_public_surface_offers_no_way_to_materialize_a_secret() {
        // A capability whose name suggests a credential would be the whole
        // posture undone; this is the sweep that would catch one appearing.
        for capability in BrokeredCapability::ALL {
            let name = capability.import_name();
            assert!(
                !["get-secret", "secret", "credential", "token"].contains(&name),
                "{name} would hand the guest a value"
            );
        }
        // `token-acquire` is allowed to exist, but it answers with a handle.
        assert!(BrokeredCapability::ALL.contains(&BrokeredCapability::TokenAcquire));
    }

    #[test]
    fn defaults_are_bounded_rather_than_unlimited() {
        let ceiling = ResourceBudget::CEILING;
        assert!(ceiling.fuel() > 0 && ceiling.fuel() < u64::MAX);
        assert!(!ceiling.deadline().is_zero());
        assert!(ceiling.max_memory_bytes() > 0);
        assert!(ceiling.max_memory_bytes() < usize::MAX);
    }

    #[test]
    fn the_crate_agrees_with_itself_about_what_it_runs() {
        assert!(GuestFormat::WasmModule.is_runnable());
        assert_eq!(BROKERED_MODULE, "opensesame:sandbox");
        assert!(AmbientDenial::TOTAL.is_total());
    }
}
