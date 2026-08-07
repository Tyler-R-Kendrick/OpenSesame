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
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn wit_package_pinned() {
        assert!(super::wit_contract::PACKAGE.contains("host"));
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
