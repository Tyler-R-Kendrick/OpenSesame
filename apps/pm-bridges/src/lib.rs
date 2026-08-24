//! Local-IPC bridges that let **foreign password-manager clients** drive the
//! `OpenSesame` sealed store (ADR 0053).
//!
//! # Why these binaries may hand back plaintext
//!
//! Every surface in this crate answers a *local* caller with a credential in
//! the clear. That is legitimate only under the three-part human/device-plane
//! test (constitution C2), and each bridge satisfies all three structurally:
//!
//! 1. **Same local user session.** A native-messaging host is `fork`/`exec`ed
//!    by the user's own browser and speaks only over the stdio pipe it
//!    inherited; a UDS server binds a socket under `$XDG_RUNTIME_DIR`, which
//!    is `0700` and owned by the user. There is no network listener anywhere
//!    in this crate.
//! 2. **One-time explicit human approval per caller identity.** For the
//!    native-messaging hosts the approval *is* `opensesame bridge install …`
//!    — the manifest a browser needs before it will ever launch the binary.
//!    For the `KeePassXC` bridge it is the pairing ceremony: `associate` is
//!    refused unless a human opened a time-boxed window with
//!    `opensesame bridge keepassxc pair` and confirmed the incoming key's
//!    fingerprint.
//! 3. **Never reachable from the agent plane.** Nothing here is exposed as an
//!    MCP tool, a WIT import, or a `ConnectionRef` operation. The mental
//!    anchor is `opensesame pass show --reveal` with a protocol adapter
//!    bolted on the front.
//!
//! # Failure discipline (inherited from `apps/credential-helpers`)
//!
//! A bridge that cannot answer exits non-zero, prints **nothing** on stdout
//! beyond a well-formed protocol error, and puts only a failure *class* on
//! stderr. Secret material never reaches stderr, a log line, argv, or an
//! error message.
//!
//! # Module map
//!
//! - [`framing`] — Chrome/Firefox native-messaging stdio framing.
//! - [`store`] — [`store::StoreAccess`], the one way a bridge touches the
//!   sealed store, plus the pure URL→entry search predicates.
//! - [`pairing`] — on-disk pairing state (**public keys and metadata only**)
//!   and the pairing-window state machine.
//! - [`conflict`] — singleton-endpoint ownership probing (C7).
//! - [`manifest`] — native-messaging host manifests and their per-browser
//!   install locations.
//! - `keepassxc` — the keepassxc-protocol server core (feature `keepassxc`).

pub mod conflict;
pub mod framing;
pub mod manifest;
pub mod pairing;
pub mod store;
pub mod testing;

#[cfg(feature = "keepassxc")]
pub mod keepassxc;

use thiserror::Error;

/// Failure classes — safe for stderr by construction. No variant carries
/// secret material, and none is constructed from decrypted entry bytes.
#[derive(Debug, Error)]
pub enum BridgeError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("protocol: {0}")]
    Protocol(String),
    #[error("store: {0}")]
    Store(String),
    #[error("store is locked")]
    Locked,
    #[error("not configured: {0}")]
    Unconfigured(&'static str),
    #[error("entry not found")]
    NotFound,
    #[error("denied: {0}")]
    Denied(&'static str),
    /// A singleton endpoint is owned by someone else; the message names them.
    #[error("{0}")]
    Conflict(String),
}

impl From<opensesame_sealed_store::StoreError> for BridgeError {
    fn from(value: opensesame_sealed_store::StoreError) -> Self {
        BridgeError::Store(value.to_string())
    }
}

/// Seconds since the Unix epoch, or `0` if the clock is before it.
#[must_use]
pub fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}
