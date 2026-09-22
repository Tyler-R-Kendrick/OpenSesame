//! Host service identity: the secure listener, service-caller admission,
//! service bindings, and the operator diagnostics over them (ADR 0130,
//! SW-SERVICE).
//!
//! Two kinds of operation are modeled here and they are never merged:
//!
//! - A **service-only operation** (`nats.callout.decide`,
//!   `worker.providers.list`, `transport.probe`, ...) is authorized for the
//!   *service principal* an admitted peer's binding names, via
//!   [`admission::require_service_caller`]. No human session is involved and
//!   none is invented: an authenticated bridge or worker peer never becomes
//!   `Caller::Operator`, never selects an organization, and never reaches an
//!   operator route (`routes/*` keep gating on `resolve_caller`, which does
//!   not read transport evidence at all).
//! - A **delegated operation** acts for a person or agent. It is authorized
//!   by [`admission::require_delegated_caller`]: the service peer must be
//!   admitted *and* a real Host session must be presented, and the binding
//!   must be scoped to that session's organization. Certificate A plus a
//!   session for tenant B is refused, whatever either is entitled to alone.
//!
//! There is deliberately no `service_or_operator` helper: mTLS is not an
//! alternate operator login (AUTHENTICATION-IS-NOT-AUTHORIZATION), and the
//! UDS / loopback operator paths keep their previous trust scope unchanged
//! (AT-TLS-LOCAL).
//!
//! Files named `lifecycle*`, `trust*` and `revocation*` in this directory
//! belong to the certificate-lifecycle owner; `managed.rs` is the seam
//! between the two (see [`ManagedIdentityResolver`]).

pub mod admission;
pub mod bindings;
pub mod boot;
pub mod config;
pub mod managed;
pub mod probe;
pub mod routes;
pub mod runtime;
pub mod status;

#[cfg(test)]
mod admission_tests;
#[cfg(test)]
mod authority_tests;
#[cfg(test)]
mod bindings_tests;
#[cfg(test)]
mod boot_tests;
#[cfg(test)]
mod config_tests;
#[cfg(test)]
mod probe_tests;
#[cfg(test)]
mod routes_tests;
#[cfg(test)]
pub(crate) mod test_support;

pub use managed::ManagedIdentityResolver;
pub use runtime::TransportRuntime;

/// The Host's secure listener id, as stamped into `ListenerProvenance`.
pub const HOST_TLS_LISTENER: &str = "host-tls";
/// The Host's plain listener id.
pub const HOST_PLAIN_LISTENER: &str = "host-plain";
