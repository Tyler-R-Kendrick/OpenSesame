//! RFC 9440 originating-client evidence for the `trusted_ingress` transport profile.
//!
//! A TLS-terminating reverse proxy that authenticated a client can forward the
//! client's certificate to the origin in the `Client-Cert` field and its
//! issuing chain in `Client-Cert-Chain`. A certificate is public, so those
//! fields prove nothing on their own: this crate only turns them into an
//! identity when the request arrived on a listener whose policy is
//! `trusted_ingress`, over a TLS connection whose peer is an explicitly bound
//! ingress, and after the forwarded chain has been re-validated against the
//! originating-client trust bundle. Everywhere else the fields are stripped.
//!
//! What the origin can and cannot know: re-validating the chain constrains
//! which certificates it will accept, but it cannot repeat the original
//! handshake. Possession of the private key was proven to the ingress, not to
//! the origin, so the resulting evidence is labelled
//! `EvidenceSource::TrustedIngressAssertion` and carries the ingress's own
//! verified identity beside it.
//!
//! The parser half (`parse_client_cert_fields`) is mirrored line for line by
//! `@opensesame/ingress-evidence`; the JSON corpus under `fixtures/` is run by
//! both.

#![forbid(unsafe_code)]

pub mod admission;
mod chain;
mod error;
mod fields;
pub mod layer;
mod limits;
pub mod verify;

pub use admission::{BindingSetAdmission, DenyAllIngress, IngressAdmission};
pub use chain::{parse_client_cert_fields, ForwardedChain};
pub use error::{Field, IngressError};
pub use fields::has_client_cert_fields;
pub use layer::{originating_peer_layer, OriginatingPeerExtension, OriginatingPeerLayer};
pub use limits::IngressLimits;
pub use verify::verify_originating;

#[cfg(test)]
#[path = "corpus_tests.rs"]
mod corpus_tests;

#[cfg(test)]
#[path = "parser_tests.rs"]
mod parser_tests;
