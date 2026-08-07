//! OpenSesame **host-core sdk** — host logic facade (ADR 0017).
//!
//! WIT: `wit/host/world.wit`.

pub use opensesame_core as core;
pub use opensesame_broker as broker;
pub use opensesame_authz as authz;
pub use opensesame_authn as authn;
pub use opensesame_connector_host as connector_host;
pub use opensesame_env_spec as env_spec;
pub use opensesame_audit as audit;

pub mod wit_contract {
    pub const PACKAGE: &str = "opensesame:host@1.0.0";
}

/// Daemon listen defaults (HTTP loopback).
pub mod daemon {
    pub const DEFAULT_LISTEN: &str = "127.0.0.1:18790";
    pub const ENV_LISTEN: &str = "OPENSESAME_AGENT_LISTEN";
    pub const ENV_LISTEN_ALIAS: &str = "OPENSESAME_DAEMON_LISTEN";
}

#[cfg(test)]
mod tests {
    #[test]
    fn wit_package_pinned() {
        assert!(super::wit_contract::PACKAGE.contains("host"));
    }
}
