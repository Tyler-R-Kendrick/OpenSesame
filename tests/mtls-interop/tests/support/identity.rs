//! Starting the shipped Identity-plane TLS listener out of process.
//!
//! `harness/identity-listener.mts` boots `apps/control-plane`'s real
//! `createTransportListener` under `tsx`, with exactly the deployment-plane
//! environment `apps/control-plane/src/transport/config.ts` documents. The
//! listener prints its bound port and then serves until it is killed; a
//! process that cannot start is an error with its stderr attached, never a
//! skipped test.

#![allow(dead_code)]

use std::path::Path;
use std::process::Command;
use std::time::{Duration, Instant};

use anyhow::{bail, Context as _, Result};
use opensesame_mtls_interop::proc::Child;
use opensesame_mtls_interop::repo_root;

/// A running Identity listener.
pub struct IdentityListener {
    pub port: u16,
    _child: Child,
}

/// How the listener should be configured.
pub struct IdentitySpec<'a> {
    pub policy: &'a str,
    pub cert: &'a Path,
    pub key: &'a Path,
    pub client_ca: Option<&'a Path>,
    pub bindings: &'a Path,
    /// Where the harness's stdout/stderr go.
    pub log_dir: &'a Path,
}

impl IdentityListener {
    /// Boot the harness and wait for its port line.
    ///
    /// # Errors
    ///
    /// `tsx` is missing, the process exited, or no port line appeared in
    /// time.
    pub fn start(spec: &IdentitySpec<'_>) -> Result<Self> {
        let root = repo_root();
        let tsx = root.join("apps/control-plane/node_modules/.bin/tsx");
        if !tsx.is_file() {
            bail!(
                "tsx is not installed at {} — the Identity harness cannot run",
                tsx.display()
            );
        }
        let script = root.join("tests/mtls-interop/harness/identity-listener.mts");
        let stdout_log = spec.log_dir.join("identity-listener.log");
        let mut command = Command::new(&tsx);
        command
            .current_dir(&root)
            .arg(&script)
            // The container's NODE_OPTIONS is invalid for a bare node; the
            // repository's own convention is to replace it outright.
            .env("NODE_OPTIONS", "--max-old-space-size=8192")
            .env("OPENSESAME_TLS_LISTEN", "127.0.0.1:0")
            .env("OPENSESAME_TLS_POLICY", spec.policy)
            .env("OPENSESAME_TLS_CERT_FILE", spec.cert)
            .env("OPENSESAME_TLS_KEY_FILE", spec.key)
            .env("OPENSESAME_SERVICE_BINDINGS_FILE", spec.bindings);
        if let Some(ca) = spec.client_ca {
            command.env("OPENSESAME_TLS_CLIENT_CA_FILE", ca);
        }
        let mut child = Child::spawn("identity-listener", &mut command, &stdout_log)?;
        let deadline = Instant::now() + Duration::from_secs(90);
        while Instant::now() < deadline {
            if let Some(port) = port_of(&child.log()) {
                return Ok(Self {
                    port,
                    _child: child,
                });
            }
            if child.exited() {
                bail!("identity listener exited:\n{}", child.log());
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        bail!("identity listener never printed a port:\n{}", child.log())
    }
}

fn port_of(log: &str) -> Option<u16> {
    log.lines()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line.trim()).ok())
        .find_map(|value| {
            value
                .get("port")
                .and_then(serde_json::Value::as_u64)
                .and_then(|p| u16::try_from(p).ok())
        })
}

/// Write a one-binding `ServiceBindingSet` document for the harness.
///
/// The Identity listener files its peers under the `client_ca` trust profile
/// (`OPENSESAME_TLS_CLIENT_TRUST_PROFILE`'s default), so that is the profile
/// the binding must name.
///
/// # Errors
///
/// The file could not be written.
pub fn write_bindings(path: &Path, spiffe_id: &str, operations: &[&str]) -> Result<()> {
    let document = serde_json::json!({
        "revision": 1,
        "bindings": [{
            "id": "bridge",
            "revision": 1,
            "enabled": true,
            "revoked": false,
            "scope": "deployment",
            "trust_profile": { "name": "client_ca" },
            "peer": { "spiffe_id": spiffe_id },
            "service_principal": "svc:bridge",
            "purpose": "nats_auth_bridge",
            "allowed_operations": operations,
            "allowed_audiences": ["host"],
            "not_after": null,
            "denied_thumbprints": []
        }]
    });
    std::fs::write(path, serde_json::to_vec_pretty(&document)?)
        .with_context(|| format!("write {}", path.display()))?;
    Ok(())
}
