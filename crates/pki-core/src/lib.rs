//! Provider-agnostic X.509 engine for the `OpenSesame` certificate manager
//! (ADR 0066 domain model, ADR 0067 revocation).
//!
//! A pure library: no HTTP surface, no database, no `axum`. Everything the
//! certificate-manager routes, the CLI, the ACME/EST/SCEP servers and the
//! renewal actor need in order to *make* or *read* certificate material lives
//! here, so exactly one implementation of each rule exists and every caller
//! gets the same bounds and the same error taxonomy.
//!
//! # Layout
//!
//! | Module | Responsibility |
//! |---|---|
//! | [`types`] | The serde documents shared with storage and the API |
//! | [`keys`] | Key-pair generation and PKCS#8 encoding |
//! | [`signer`] | The custody-agnostic [`Signer`] trait |
//! | [`ca`] | Root and intermediate authority generation and validation |
//! | [`csr`] | Bounded CSR parsing and generation |
//! | [`leaf`] | End-entity issuance |
//! | [`policy`] | The three-state policy evaluator and its presets |
//! | [`revocation`] | CRL and OCSP construction and parsing |
//! | [`bundle`] | Chain normalization, PKCS#12, fingerprints |
//!
//! # Secrecy invariant
//!
//! Private material is carried only by [`keys::KeyPair`],
//! [`ca::GeneratedCa`], [`signer::SealedKeySigner`] and
//! [`bundle::Pkcs12Entry`]. None of those implements `Clone` or `Serialize`,
//! all of them redact `Debug`, and no [`PkiError`] variant interpolates secret
//! bytes into its message. The single private-material accessor in the crate
//! is [`keys::KeyPair::private_key_pkcs8_pem`], which returns a zeroizing
//! string. Everything else — certificates, chains, CSRs, CRLs, OCSP responses,
//! fingerprints and policy documents — is public material and is freely
//! serializable.

#![forbid(unsafe_code)]
#![warn(missing_docs)]
// The public surface is dominated by small value accessors; annotating each
// with `#[must_use]` adds noise without catching a real bug class here.
#![allow(clippy::must_use_candidate)]
// Types such as `policy::PolicyRules` and `csr::CsrFacts` are named for the
// domain concept they model; the module prefix is how callers disambiguate.
#![allow(clippy::module_name_repetitions)]

pub mod bundle;
pub mod ca;
pub mod csr;
pub mod error;
pub mod keys;
pub mod leaf;
mod params;
pub mod policy;
pub mod revocation;
pub mod signer;
pub mod types;
mod x509;

pub use error::PkiError;
pub use keys::KeyPair;
pub use policy::{PolicyCandidate, PolicyViolation};
pub use signer::{SealedKeySigner, Signer};
pub use types::{
    BasicConstraintRule, BasicConstraints, CaRule, Constraint, ConstraintMode, DcRule,
    ExtendedKeyUsage, FieldRule, KeyAlgorithm, KeyUsage, PolicyPreset, PolicyRules,
    ProfileDefaults, RuleMode, SanEntry, SanRule, SanRules, SignatureAlgorithm, SubjectDn,
    SubjectRules,
};
