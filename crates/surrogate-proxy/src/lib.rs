//! The surrogate proxy adapter (ADR 0150 §6.1): the last hop that lets an
//! unmodified SDK or CLI hold `osr_…` instead of a credential.
//!
//! A run gets its own listener on `127.0.0.1`, its own in-memory CA, its own
//! proxy credential and its surrogates. The child is pointed at all of them
//! through its environment ([`RunHandle::child_env`]). Every request it sends
//! through the proxy is terminated, parsed and put to
//! [`SurrogateLedger::admit`](opensesame_invoke_through::SurrogateLedger::admit);
//! an admitted request becomes an invoke-through call, where the credential is
//! written into the provider's own site and the response is scrubbed of it on
//! the way back. The surrogate text never becomes the credential: it is
//! recognised, its header stripped, and the credential re-placed — never a
//! find-and-replace.
//!
//! What must hold, in the order it bites:
//!
//! 1. **Caller identity.** A `Proxy-Authorization: Basic` credential unique to
//!    the run, compared in constant time, on the run's own listener. The
//!    identity admission checks is the run instance's, never a string the
//!    client chose.
//! 2. **One destination.** The CONNECT authority, the TLS server name and the
//!    inner `Host` agree, or the tunnel or request is refused.
//! 3. **A bounded, whole body** (invoke-through's 256 KiB request cap) before
//!    the scan, so nothing forwardable escapes it.
//! 4. **Admission** by the ledger's fences; a refusal goes to the embedder's
//!    [`RefusalSink`] and the client learns one message.
//! 5. **Only the provider's forwardable headers** reach the upstream, beside
//!    the credential invoke-through places.
//! 6. **Un-surrogated traffic** is refused unless the run named its host as
//!    passthrough, and plain HTTP is never forwarded at all.
//! 7. **Fail closed.** A client that pins certificates or rejects the run CA
//!    fails its handshake; nothing falls back to a blind tunnel or a
//!    credential.
//!
//! The CA's key stays in memory inside this crate and is never returned. The
//! CA certificate goes only to the child, through its own trust variables; no
//! system or user trust store is touched, and upstream trust stays
//! invoke-through's.

mod auth;
mod broker;
mod ca;
mod config;
pub mod env;
mod listener;
mod passthrough;
pub mod plugin;
mod ports;
mod respond;
mod runs;
mod target;
mod tunnel;

pub use ca::CertError;
pub use config::{ProxyConfig, DEFAULT_CA_VALIDITY};
pub use passthrough::PassthroughClient;
pub use ports::{Clock, ProviderSources, ReceiptSink, RefusalSink, SystemClock, TokenSources};
pub use runs::{RunError, RunHandle, RunSpec, SurrogateGrant, SurrogateRuns};
