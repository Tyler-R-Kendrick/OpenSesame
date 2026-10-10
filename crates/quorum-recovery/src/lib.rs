//! The native reader of a trusted-contacts recovery (ADR 0187).
//!
//! A circle's owner seals a payload in a **recovery bundle** and gives each
//! guardian one **SLIP-0039** share of the key that opens it, written with an
//! empty passphrase so that no `OpenSesame` code is needed to recombine them.
//! This crate is that "another tool", built from the same definitions the
//! browser uses (ADR 0139):
//!
//! - [`slip39`] — share decoding with the RS1024 checksum, group and member
//!   thresholds, the digest check, passphrase, iteration exponent and the
//!   extendable flag; and generation, so a round trip is testable here. Checked
//!   against all 45 official vectors in `spec/conformance/slip39/`.
//! - [`hpke`] — RFC 9180 base mode, DHKEM(X25519, HKDF-SHA256) with HKDF-SHA256
//!   and AES-128-GCM or ChaCha20-Poly1305, which seals a share to the person
//!   it is released to. Checked against every value of
//!   `spec/conformance/hpke-rfc9180-vectors.json`.
//! - [`policy`] and [`bundle`] — the owner's signed policy (canonical JSON,
//!   framed digest, Ed25519) and the bundle sealed under the recombined secret.
//! - [`recover`] — the two together.
//!
//! The crate does no I/O and reaches no network. Randomness is the caller's
//! [`rand::RngCore`]; secrets are held in [`Secret`], wiped on drop and never
//! printed. The committed fixture `spec/conformance/quorum-recovery-fixture.json`
//! is opened by this crate and by `packages/app-core/src/lib/quorum/`, each
//! against the other's output.

#![forbid(unsafe_code)]
// Types such as `bundle::BundleError` and `policy::PolicyError` are named for
// the concept they refuse; the module prefix is how callers tell them apart.
#![allow(clippy::module_name_repetitions)]
// Almost every public function here returns a `Result` or a value the caller
// must use anyway; `#[must_use]` on each adds noise without catching a bug.
#![allow(clippy::must_use_candidate)]

pub mod bundle;
pub mod canonical;
pub mod encoding;
pub mod hpke;
pub mod policy;
pub mod recover;
mod secret;
pub mod slip39;

pub use bundle::{BundleError, RecoveryBundle};
pub use policy::{verify_signed_policy, PolicyError, SignedPolicy};
pub use recover::{
    match_shares, recover, share_commitment, GuardianRef, RecoverError, Recovered, ShareMatch,
    MAX_RECOVERY_EXPONENT,
};
pub use secret::Secret;
