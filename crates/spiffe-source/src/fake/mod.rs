//! Test doubles: a deterministic in-process SPIFFE Workload API server over a
//! unix socket, and a disposable trust domain that issues (and mis-issues)
//! SVIDs. Enabled by the `fake-workload-api` feature only.
//!
//! The fake speaks the real gRPC contract (`/SpiffeWorkloadAPI/FetchX509SVID`
//! and `/SpiffeWorkloadAPI/FetchX509Bundles` as server streams, requiring the
//! `workload.spiffe.io: true` header) so the production client path is
//! exercised unchanged. It is the unit oracle for snapshot replacement,
//! withdrawal, stream errors, disconnects and reconnects; it is not evidence
//! of SPIRE compatibility — `tests/spire_reference.rs` is.

pub mod issuer;
pub mod pb;
pub mod server;

pub use issuer::{Eku, FakeTrustDomain, IssuedSvid, SvidSpec};
pub use server::{FakeWorkloadApi, Script};
/// gRPC status, re-exported so tests can script stream errors.
pub use tonic::Status;
