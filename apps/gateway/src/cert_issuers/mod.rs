//! Transport-neutral certificate issuer primitives.
//!
//! Issuance inputs contain names and policy only. Certificate, leaf-key, CA,
//! and ACME account material are outputs or sealed inputs, never user-supplied
//! ceremony fields. Secret-bearing values intentionally do not implement
//! `Clone` or `Serialize`, and their `Debug` output is redacted.

mod acme;
mod cloudflare_dns;
mod cloudflare_origin;
mod model;
mod registry;

pub use acme::{
    AcmeAccount, AcmeAccountCredentials, AcmeEnvironment, AcmeProvider, Dns01Failure, Dns01Lease,
    Dns01Provisioner, Dns01Record, ExternalAccountBinding,
};
pub use cloudflare_dns::CloudflareDns01;
pub use cloudflare_origin::{
    CloudflareOriginApiResponse, CloudflareOriginRequest, CloudflareOriginValidity,
};
pub use model::{
    CertificateRequest, CertificateRequestInput, ChallengeKind, GeneratedLeafRequest,
    IssuedCertificate, IssuerKind, TrustClass,
};
pub use registry::{
    dns_shape_for_provider, issuer_for_provider, issuers_by_priority, BrokeredDns01,
    DnsProviderShape, ExternalIssuerDescriptor, IssuerProtocol, EXTERNAL_ISSUERS,
};
