//! SPAKE2 enrollment of the daemon root trust key.
//!
//! Ciphersuite SPAKE2-P256-SHA256-HKDF-HMAC ([RFC 9382](https://www.rfc-editor.org/rfc/rfc9382)).
//! The operator route mints a one-time enrollment secret and the daemon's
//! message. The enrolling client proves it knows that secret and submits a
//! P-256 root SPKI. The daemon writes the U2 trust store and marks the root
//! key enrolled only after key confirmation. The secret is not on the finish
//! request. Host prompts and TTY enrollment are a later unit.

mod protocol;
mod spake2;

pub(crate) use protocol::Sessions;
pub use protocol::{
    generate_root_signing_key, root_spki_der, EnrollmentConfirm, RootEnrollBegin, RootEnrollClient,
    RootEnrollFinish, RootEnrollRequest, ROOT_ENROLL_BEGIN_PATH, ROOT_ENROLL_FINISH_PATH,
    ROOT_ENROLL_TTL_SECS,
};

use thiserror::Error;

/// Why root-trust enrollment was refused.
#[derive(Clone, Debug, PartialEq, Eq, Error)]
pub enum RootEnrollError {
    /// The enrollment secret was empty, too long, or reduced to the zero scalar.
    #[error("enrollment secret must be 16 to 128 bytes")]
    InvalidSecret,
    /// A SPAKE2 message was not an uncompressed P-256 point.
    #[error("enrollment message was not a P-256 point")]
    InvalidMessage,
    /// Key confirmation did not match the transcript.
    #[error("enrollment confirmation did not match")]
    InvalidConfirm,
    /// The root key was not a P-256 `SubjectPublicKeyInfo`.
    #[error("root trust key was not a P-256 SPKI")]
    InvalidSpki,
    /// No pending session has this id.
    #[error("no such enrollment session")]
    UnknownSession,
    /// The pending session is past its lifetime.
    #[error("the enrollment session expired")]
    Expired,
    /// The next enrollment epoch would not fit in a `u64`.
    #[error("the enrollment epoch is exhausted")]
    EpochExhausted,
}
