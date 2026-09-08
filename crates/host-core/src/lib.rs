//! `OpenSesame` **host-core sdk** — host logic facade (ADR 0017).
//!
//! WIT: `wit/host/world.wit`.

pub use opensesame_audit as audit;
pub use opensesame_authn as authn;
pub use opensesame_authz as authz;
pub use opensesame_broker as broker;
pub use opensesame_connector_host as connector_host;
pub use opensesame_core as core;
pub use opensesame_env_spec as env_spec;

pub mod wit_contract {
    pub const PACKAGE: &str = "opensesame:host@1.0.0";
}

/// Daemon listen defaults (HTTP loopback) and bind policy helpers.
pub mod daemon;
pub mod deployment_mode;

/// Operator bearer check shared by the local host binaries.
///
/// Loopback is not a boundary here: a co-resident process reaches the daemon as
/// easily as the toolbar does, so every mutating local route wants this.
pub mod operator;

/// Browser CORS allowlist + baseline response headers (`OPENSESAME_CORS_ORIGINS`).
pub mod http_security;

/// Property / Adversarial / Chaos / conTract oracles shared by Host tests.
///
/// See `docs/validation/pact.md`. These helpers kill the same classes of
/// mutants (check-then-set, source-order inversion, partition drops) so each
/// plane does not invent a one-off assertion style.
pub mod pact;

#[cfg(test)]
mod tests;

#[cfg(test)]
mod http_security_layer_tests;
