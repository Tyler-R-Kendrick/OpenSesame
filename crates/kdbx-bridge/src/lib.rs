//! `KDBX4` (`KeePass`) ⇄ sealed-store bridge.
//!
//! Two directions, one frozen mapping (ADR 0052 §4.5, stated normatively in
//! this crate's `README.md`):
//!
//! * [`import_kdbx`] reads a KDBX database and merges it into a
//!   [`StoreRoot`] by store path, idempotently.
//! * [`export_kdbx`] writes the store (or a subtree of it) back out as a
//!   KDBX 4 database.
//!
//! [`map_kdbx`] is the pure read-and-map half of the import: it never touches
//! the store, which makes it the entry point for fuzzing and for the
//! cross-implementation conformance fixture under `fixtures/kdbx/`.
//!
//! ## Plane
//!
//! Both directions yield plaintext to their caller and are therefore
//! human-plane surfaces (constitution C2): they are driven by the CLI under
//! the same TTY/reveal ceremony as `opensesame pass show --reveal`, never
//! from the agent plane. Nothing here logs, and no error message carries a
//! field value.

#![forbid(unsafe_code)]
#![warn(missing_docs)]

mod export;
mod import;
mod limits;
pub mod map;

pub use export::{
    export_kdbx, zeroize_buffer, Argon2Params, ExportCipher, ExportOptions, ROOT_GROUP_NAME,
};
pub use import::{
    import_kdbx, map_kdbx, ImportOptions, ImportSummary, ItemWarning, MergeOutcome, SkipReason,
    SkippedItem,
};
pub use limits::{
    MAX_AES_KDF_ROUNDS, MAX_KDF_ITERATIONS, MAX_KDF_MEMORY_BYTES, MAX_KDF_PARALLELISM,
};
pub use map::{MapWarning, MappedItem};

use opensesame_sealed_store::StoreError;

/// The KDBX minor version this crate writes.
///
/// The `keepass` crate's KDBX4 writer accepts **only** `KDB4(1)` — a request
/// for `4.0` is rejected outright — so exports are `KDBX 4.1`. Both
/// `KeePass 2.x`, `KeePassXC`, and `kdbxweb` read `4.1`.
pub const EXPORT_KDBX_MINOR_VERSION: u16 = 1;

/// Errors from the KDBX bridge.
///
/// Variants classify the failure; they never carry secret material. The
/// `cause` strings come from the `keepass` crate's own `Display`, which
/// reports structure (header, HMAC, XML) and never key or field values.
#[derive(Debug, thiserror::Error)]
pub enum KdbxError {
    /// The bytes are not a `KeePass` database at all.
    #[error("not a KeePass database: {0}")]
    NotKdbx(String),

    /// A `KeePass` database, but not one this bridge reads or writes.
    #[error("unsupported KeePass database version: {0}")]
    UnsupportedVersion(String),

    /// No password and no keyfile were supplied.
    #[error("a password or a keyfile is required")]
    MissingCredentials,

    /// The supplied password/keyfile did not unlock the database.
    #[error("could not unlock the database: wrong password or keyfile")]
    Locked,

    /// The database unlocked but its contents are malformed.
    #[error("malformed KeePass database: {0}")]
    Malformed(String),

    /// Writing a KDBX database failed.
    #[error("could not write a KeePass database: {0}")]
    Write(String),

    /// The sealed store rejected a read or a write.
    #[error("sealed store: {0}")]
    Store(#[from] StoreError),
}
