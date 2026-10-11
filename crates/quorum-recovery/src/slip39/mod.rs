//! SLIP-0039: Shamir's Secret Sharing for mnemonic codes — the interoperable
//! format a trusted-contacts recovery export uses, so any conforming tool can
//! combine the shares without `OpenSesame` (ADR 0187).
//!
//! This is the native consumer of `spec/conformance/slip39/` (45 vectors and
//! the wordlist, read from the one copy there). It does no I/O: randomness is
//! the caller's [`rand::RngCore`], and a passphrase is a parameter.
//!
//! Two levels, as the standard has them: a group threshold over groups, and a
//! member threshold inside each group. A plain k-of-n is one group.

mod cipher;
mod combine;
mod error;
mod gf256;
mod rs1024;
mod shamir;
mod share;
mod wordlist;

pub use cipher::MAX_ITERATION_EXPONENT;
pub use combine::{
    combine, describe, generate, CombineOptions, GenerateParams, GroupSpec, ShareHeader,
};
pub use error::Slip39Error;
pub use share::{decode_share, encode_share, Share, MIN_MNEMONIC_WORDS};
pub use wordlist::words as wordlist;
