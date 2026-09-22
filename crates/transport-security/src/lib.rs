//! Native TLS for the authority plane: verification, secure listeners, and
//! outbound clients for the optional mTLS / workload-identity profiles
//! (ADR 0130).
//!
//! Everything cryptographic is delegated to maintained libraries: `rustls`
//! runs the handshake and verifies handshake signatures, `rustls-webpki`
//! builds and validates chains (time, constraints, usages, revocation), and
//! `x509-parser` only *reads* a leaf that has already been verified. Nothing
//! here is a TLS stack, a "verify signature only" callback, or a way to turn
//! hostname checking off.
//!
//! The crate never appears in a browser or Wasm build: it is a dependency of
//! native binaries only (`tests/dependency_fence.rs` parses the workspace
//! manifests to keep it that way).
//!
//! Module map
//! - [`identity`] — [`TlsIdentity`]: a chain plus a key that has been proven
//!   to match its leaf; `Debug` never shows the key.
//! - [`trust`] — [`TrustBundle`]: the anchors and CRLs used to verify a
//!   *peer*, kept separate from the chain presented as *our* identity.
//! - [`verify_spiffe`] — the SPIFFE server-identity profile verifier.
//! - [`client`] — [`client_config`] / [`reqwest_builder`].
//! - [`server`] / [`listener`] — [`ServerProfile`] and [`SecureListener`].
//! - [`generations`] — atomic credential/trust generations.
//! - [`provenance`] / [`guard`] — request extensions and the per-request
//!   freshness guard.
//! - [`env`] — deployment-plane environment loaders.
//! - [`testkit`] (feature `testkit`) — disposable PKI for tests.

#![forbid(unsafe_code)]
// Pedantic lint that fires on `server::ServerProfile`, `client::ClientProfile`
// and friends; the module-qualified names are the readable ones here.
#![allow(clippy::module_name_repetitions)]

pub mod client;
pub mod env;
pub mod error;
pub mod generations;
pub mod guard;
pub mod identity;
pub mod leaf;
pub mod listener;
pub mod provenance;
pub mod server;
pub mod trust;
pub mod verify_spiffe;

mod bounded;
mod idle_io;
mod server_conn;

#[cfg(feature = "testkit")]
pub mod testkit;

pub use client::{client_config, dial_name, reqwest_builder, ClientProfile, ServerNamePolicy};
pub use env::{NativeIdentitySpec, NativeTrustSpec, TransportEnv};
pub use error::classify_tls_error;
pub use generations::{Generation, GenerationCandidate, TransportGenerations};
pub use guard::{enforce_current_generation, PeerDenyHook};
pub use identity::{ChainUsage, TlsIdentity};
pub use leaf::{LeafUsage, ParsedLeaf};
pub use listener::{ListenerCounters, SecureListener};
pub use provenance::{plain_provenance_layer, ListenerProvenance, PeerExtension, ProvenanceLayer};
pub use server::{server_config, DenyThumbprint, ListenerLimits, ServerProfile};
pub use trust::TrustBundle;
pub use verify_spiffe::SpiffeServerVerifier;

/// Bytes that must never be printed, logged, or kept longer than needed: a
/// private-key PEM on its way into [`TlsIdentity::from_pem`].
pub type SecretBytes = secrecy::SecretBox<Vec<u8>>;

/// Maximum certificates in a presented chain (leaf plus intermediates) that
/// any verifier in this crate will consider. Longer chains are rejected
/// before path building starts.
pub const MAX_CHAIN_DEPTH: usize = 5;

/// The one crypto provider this crate uses. Every `ClientConfig` and
/// `ServerConfig` is built with `builder_with_provider(provider())`, so the
/// process-wide rustls default is never consulted.
#[must_use]
pub fn provider() -> std::sync::Arc<rustls::crypto::CryptoProvider> {
    std::sync::Arc::new(rustls::crypto::aws_lc_rs::default_provider())
}
