//! OpenSesame **host-core sdk** — host logic facade (ADR 0017).
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
pub mod daemon {
    pub const DEFAULT_LISTEN: &str = "127.0.0.1:18790";
    pub const ENV_LISTEN: &str = "OPENSESAME_AGENT_LISTEN";
    pub const ENV_LISTEN_ALIAS: &str = "OPENSESAME_DAEMON_LISTEN";
    /// When `1`, skip TCP and serve Unix socket only (`OPENSESAME_AGENT_SOCK` required).
    pub const ENV_UDS_ONLY: &str = "OPENSESAME_DAEMON_UDS_ONLY";
    /// When `1`, allow non-loopback TCP binds (explicit operator override).
    /// Shared by daemon, credential-agent, and gateway.
    pub const ENV_ALLOW_NONLOCAL: &str = "OPENSESAME_ALLOW_NONLOCAL";
    /// Legacy alias kept for daemon/operator docs.
    pub const ENV_ALLOW_NONLOCAL_DAEMON: &str = "OPENSESAME_DAEMON_ALLOW_NONLOCAL";

    /// True when `host` of `host:port` (or bare host) is loopback.
    pub fn listen_host_is_loopback(listen: &str) -> bool {
        let host = match listen.rsplit_once(':') {
            Some((h, port)) if !port.is_empty() && port.chars().all(|c| c.is_ascii_digit()) => {
                h.trim_start_matches('[').trim_end_matches(']')
            }
            _ => listen.trim_start_matches('[').trim_end_matches(']'),
        };
        matches!(host, "127.0.0.1" | "localhost" | "::1" | "0:0:0:0:0:0:0:1")
    }

    fn nonlocal_override_enabled() -> bool {
        [ENV_ALLOW_NONLOCAL, ENV_ALLOW_NONLOCAL_DAEMON]
            .iter()
            .any(|k| std::env::var(k).ok().as_deref() == Some("1"))
    }

    /// Refuse non-loopback TCP unless `OPENSESAME_ALLOW_NONLOCAL=1`
    /// (or legacy `OPENSESAME_DAEMON_ALLOW_NONLOCAL=1`).
    pub fn assert_tcp_listen_allowed(listen: &str) -> Result<(), String> {
        if nonlocal_override_enabled() || listen_host_is_loopback(listen) {
            return Ok(());
        }
        Err(format!(
            "TCP listen `{listen}` is not loopback; set {ENV_ALLOW_NONLOCAL}=1 to override"
        ))
    }

    pub fn uds_only_requested() -> bool {
        std::env::var(ENV_UDS_ONLY).ok().as_deref() == Some("1")
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::daemon::{
        assert_tcp_listen_allowed, listen_host_is_loopback, ENV_ALLOW_NONLOCAL,
        ENV_ALLOW_NONLOCAL_DAEMON,
    };

    #[test]
    fn wit_package_pinned() {
        assert!(super::wit_contract::PACKAGE.contains("host"));
    }

    #[test]
    fn loopback_listen_hosts() {
        assert!(listen_host_is_loopback("127.0.0.1:18790"));
        assert!(listen_host_is_loopback("localhost:18790"));
        assert!(listen_host_is_loopback("[::1]:18790"));
        assert!(!listen_host_is_loopback("0.0.0.0:18790"));
        assert!(!listen_host_is_loopback("192.168.1.10:18790"));
    }

    #[test]
    fn nonlocal_tcp_denied_without_override() {
        // Ensure override unset for this process check.
        std::env::remove_var(ENV_ALLOW_NONLOCAL);
        std::env::remove_var(ENV_ALLOW_NONLOCAL_DAEMON);
        assert!(assert_tcp_listen_allowed("127.0.0.1:18790").is_ok());
        assert!(assert_tcp_listen_allowed("0.0.0.0:18790").is_err());
    }

    fn repo_root() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
    }

    fn read_wit(rel: &str) -> String {
        std::fs::read_to_string(repo_root().join(rel))
            .unwrap_or_else(|e| panic!("cannot read {rel}: {e}"))
    }

    fn assert_no_secrets_or_arbitrary_sign(src: &str) {
        let code: String = src
            .lines()
            .map(|l| l.split("//").next().unwrap_or(""))
            .collect::<Vec<_>>()
            .join("\n")
            .to_lowercase();
        assert!(
            !code.contains("secrets.get"),
            "WIT must not expose secrets.get"
        );
        assert!(
            !code.contains("sign: func(") || code.contains("purpose:"),
            "sign must be purpose-bound if present"
        );
    }

    #[test]
    fn wit_task_contract() {
        let src = read_wit("wit/task/world.wit");
        assert_no_secrets_or_arbitrary_sign(&src);
        assert!(src.contains("authorize-and-invoke"));
        assert!(src.contains("restrict"));
        assert!(src.contains("terminate"));
        assert!(src.contains("task-handle"));
        assert!(src.contains("intent-handle"));
    }

    #[test]
    fn wit_proof_contract() {
        let src = read_wit("wit/proof/world.wit");
        assert_no_secrets_or_arbitrary_sign(&src);
        assert!(src.contains("execute-authorized-proof"));
        assert!(src.contains("task-run-id"));
        assert!(src.contains("intent-digest"));
    }

    #[test]
    fn wit_mediation_contract() {
        let src = read_wit("wit/mediation/world.wit");
        assert_no_secrets_or_arbitrary_sign(&src);
        assert!(src.contains("classify-result"));
        assert!(src.contains("acknowledge-transition"));
    }

    #[test]
    fn host_wit_unchanged_exports() {
        let src = read_wit("wit/host/world.wit");
        assert!(src.contains("export session"));
        assert!(src.contains("export invoke"));
        assert!(src.contains("opensesame:host@1.0.0"));
    }
}
