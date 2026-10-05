//! Tailnet device management through the daemon (ADR 0169).
//!
//! Tailscale's control-plane API cannot be read from a page (it answers no
//! CORS), and the credential that drives it can admit a stranger's machine to
//! the network. So the daemon holds that credential and makes every call, and
//! a page manages devices through the daemon with a bearer bound to its origin
//! and a role.
//!
//! - [`AdminStore`] — the directory the daemon and `opensesame tailnet`
//!   share: which tailnet, the credential (a `0600` file), the pairings and
//!   the audit trail. Read whole on every call, so the CLI and the daemon see
//!   each other's changes without a restart.
//! - [`RolePairings`] — one-time codes for an origin and a role, traded once
//!   for a bearer; SHA-256 digests only.
//! - [`Upstream`] — the one road to `api.tailscale.com`: invoke-through for
//!   every device and key call, one fixed POST for the OAuth access token.
//! - [`ops`] — the operations themselves, validated before anything is sent
//!   and answered in this crate's own shape, never Tailscale's.
//! - [`AuditLog`] — one line per change, no values.

mod audit;
mod config;
mod error;
pub mod ops;
mod pairing;
mod pairing_code;
mod paths;
mod upstream;
pub mod validate;
pub mod wire;

pub use audit::{AuditEntry, AuditLog, AUDIT_KEEP, AUDIT_READ};
pub use config::{AdminStore, Credential, CredentialKind, TailnetConfig};
pub use error::AdminError;
pub use pairing::{Paired, PairedView, PendingView, RolePairings};
pub use pairing_code::{format_pairing_code, Role, CODE_PREFIX, CODE_TTL_SECS};
pub use paths::{admin_dir_from, default_admin_dir, DIR_ENV};
pub use upstream::{Upstream, API_BASE, API_HOST, EGRESS_RULE};
