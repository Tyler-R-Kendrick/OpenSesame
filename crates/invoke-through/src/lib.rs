//! Invoke-through (ADR 0048 D6/D7): the daemon brokers an upstream call
//! against a credential that never leaves the machine — acquired fresh from
//! the provider's own CLI (`gh auth token`), held in a [`SecretString`],
//! placed into exactly one sensitive Authorization header, and zeroized on
//! drop. The caller sees the upstream response and a structured receipt;
//! nothing else.
//!
//! The fences, in the order they bite:
//!
//! 1. **Egress allowlist before connecting** ([`egress`]) — a static table
//!    derived from the connection-broker catalog, exact host match, https
//!    only (plain HTTP exists solely for loopback test stubs).
//! 2. **No redirects** — a 3xx is a response, never a chase; the credential
//!    can never be ridden onto a host the allowlist did not name.
//! 3. **Memory-resident token** ([`TokenSource`]) — never cached, persisted,
//!    logged, or present in any error or receipt surface.
//! 4. **Capped bodies** both ways, allowlisted headers both ways.
//!
//! Dependency budget (ADR 0048 D5/D8): secrecy, zeroize, hyper, hyper-util,
//! hyper-rustls (webpki roots, no native cert store), http/bytes, serde,
//! thiserror. No reqwest, no cookie store.

pub mod egress;
mod error;
mod invoke;
mod source;

pub use egress::{rule_for, AuthStyle, EgressRule, EGRESS_RULES};
pub use error::InvokeError;
pub use invoke::{
    InvokeRequest, InvokeResponse, Invoker, PreparedRequest, ReceiptMeta, DEFAULT_REQUEST_BODY_CAP,
    DEFAULT_RESPONSE_BODY_CAP, DEFAULT_TIMEOUT,
};
pub use source::{source_tool, SourceToolSpec, TokenSource};
