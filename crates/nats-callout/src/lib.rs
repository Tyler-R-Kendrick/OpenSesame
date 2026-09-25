//! NATS auth callout (ADR-26) for the authority plane: the wire protocol, and
//! the bridge that turns a server-signed `authorization_request` into a Host
//! decision and back into a signed `authorization_response`.
//!
//! **Trust boundary, stated once.** The bridge attests exactly one fact the
//! Host cannot see for itself: *this request arrived on the bridge's
//! authenticated NATS connection, on the protected `$SYS.REQ.USER.AUTH`
//! subject.* Everything else — the server signature, the time window, the
//! audience, the one-time user nkey, the request digest, and the end user's
//! upstream token — is re-verified by the Host from the raw request JWT the
//! bridge forwards. The bridge is a high-trust component; it is not
//! compromise-resistant, and a compromised bridge can at most replay real
//! server requests it has already seen, never mint allow decisions.
//!
//! Module map
//! - [`model`] — the `authorization_request` claim types (serde, secrets
//!   redacted in `Debug`).
//! - [`jwt`] — decode + verify a request (`ed25519-nkey`, window, audience,
//!   issuer/subject key kinds) and the low-level JWT encode used by
//!   [`response`].
//! - [`digest`] — the immutable request identity.
//! - [`evidence`] — what the request carries about the *end user*: an
//!   upstream token, or the server-verified TLS chain. `client_tls.certs`
//!   is never evidence.
//! - [`response`] — signed `authorization_response` / user JWT encoding.
//! - [`xkey`] — the `xkv1` envelope when the server has an xkey.
//! - [`host_client`] — the Host decision contract and its mTLS HTTP client.
//! - [`bridge`] — the request→decision→response core.
//! - [`service`] — the NATS micro service that serves it (discovery, stats,
//!   queue-group load balancing, bounded concurrency).
//! - [`config`] — deployment-plane environment for the bridge binary.

#![forbid(unsafe_code)]

pub mod bridge;
pub mod config;
pub mod digest;
pub mod error;
pub mod evidence;
#[doc(hidden)]
pub mod fixtures;
pub mod host_client;
pub mod jwt;
pub mod model;
pub mod response;
pub mod service;
pub mod xkey;

pub use bridge::BridgeCore;
pub use digest::RequestDigest;
pub use error::CalloutError;
pub use evidence::ExtractedEvidence;
pub use host_client::{
    check_echo, ClientRef, DecisionSource, HostDecisionRequest, HostDecisionResponse, HostEvidence,
    ServerRef,
};
pub use jwt::{decode_request, Expectations, VerifiedRequest};
pub use model::{AuthorizationRequestClaims, ClientInfo, ClientTls, ConnectOpts, ServerId};
pub use response::{ResponseSigner, UserGrant};

/// Re-exported so the Host route can read listener provenance without a
/// second transport dependency line in its manifest.
pub mod transport {
    pub use opensesame_transport_security::{ListenerProvenance, PeerExtension};
}

/// The protected subject every NATS server publishes callouts on.
pub const AUTH_SUBJECT: &str = "$SYS.REQ.USER.AUTH";
/// Queue group the bridge instances share.
pub const QUEUE_GROUP: &str = "opensesame-nats-auth-bridge";
/// Header nats-server sets to its public xkey when the request is sealed.
pub const SERVER_XKEY_HEADER: &str = "Nats-Server-Xkey";
/// Largest request payload the bridge will look at (a callout with a chain is
/// a few KiB; 64 KiB leaves room for long chains without inviting abuse).
pub const MAX_REQUEST_BYTES: usize = 64 * 1024;
