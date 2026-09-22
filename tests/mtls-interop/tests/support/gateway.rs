//! Starting the **real** `opensesame-gateway` binary.
//!
//! `apps/gateway/src/transport/boot.rs` is the only place the Host decides
//! whether a secure listener exists, and it is reachable only from `main`.
//! SW-SERVICE could unit-test the profile it builds; nothing but the process
//! itself can show that a misconfigured `mtls_required` deployment *refuses
//! to serve at all* rather than quietly answering on plaintext.
//!
//! The binary is built on demand when it is absent, with a bound; a build
//! that fails is a failure, never a skip.

#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use anyhow::{bail, Result};
use opensesame_mtls_interop::proc::{free_port, run_bounded, Child};
use opensesame_mtls_interop::repo_root;

/// Where the debug binary lives, building it if needed.
///
/// # Errors
///
/// The build failed or produced nothing.
pub fn binary() -> Result<PathBuf> {
    let path = repo_root().join("target/debug/opensesame-gateway");
    if path.is_file() {
        return Ok(path);
    }
    let (code, _out, err) = run_bounded(
        Command::new("cargo").current_dir(repo_root()).args([
            "+1.88.0",
            "build",
            "-p",
            "opensesame-gateway",
        ]),
        Duration::from_secs(2400),
    )?;
    if code != Some(0) || !path.is_file() {
        bail!("could not build opensesame-gateway ({code:?}): {err}");
    }
    Ok(path)
}

/// The two ports a Host process listens on.
pub struct Ports {
    pub plain: u16,
    pub tls: u16,
}

/// A running (or refused) Host process.
pub struct Gateway {
    pub ports: Ports,
    child: Child,
}

/// How to configure the secure listener.
pub struct GatewaySpec<'a> {
    pub policy: &'a str,
    pub cert: &'a Path,
    pub key: &'a Path,
    pub client_trust: &'a Path,
    pub bindings: &'a Path,
    pub log_dir: &'a Path,
}

fn secret() -> String {
    // 32 bytes of process-local entropy for a throwaway operator token; it
    // never leaves this process tree and the database is in memory.
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{nanos:0>32x}{:0>32x}", std::process::id())
}

impl Gateway {
    /// Spawn the Host with a secure listener configured.
    ///
    /// # Errors
    ///
    /// The binary could not be built or spawned.
    pub fn spawn(spec: &GatewaySpec<'_>) -> Result<Self> {
        let binary = binary()?;
        let ports = Ports {
            plain: free_port()?,
            tls: free_port()?,
        };
        let mut command = Command::new(binary);
        command
            .current_dir(repo_root())
            // Loopback everywhere: `classify` must see a LocalOnly exposure
            // or the development profile is refused outright.
            .env("OPENSESAME_ENV", "development")
            .env("OPENSESAME_ALLOW_DEV_DEFAULTS", "1")
            .env("OPENSESAME_RESOURCE", "http://127.0.0.1:8787")
            .env("OPENSESAME_ISSUER", "http://127.0.0.1:8788")
            .env("OPENSESAME_OPERATOR_TOKEN", secret())
            .env("OPENSESAME_CLAIM_PEPPER", secret())
            .env("OPENSESAME_DB", "sqlite::memory:")
            .env("OPENSESAME_LISTEN", format!("127.0.0.1:{}", ports.plain))
            .env("OPENSESAME_TLS_LISTEN", format!("127.0.0.1:{}", ports.tls))
            .env("OPENSESAME_TLS_POLICY", spec.policy)
            .env("OPENSESAME_TLS_IDENTITY_SOURCE", "pem")
            .env("OPENSESAME_TLS_CERT_FILE", spec.cert)
            .env("OPENSESAME_TLS_KEY_FILE", spec.key)
            .env("OPENSESAME_TLS_TRUST_FILE", spec.client_trust)
            .env("OPENSESAME_TLS_TRUST_KIND", "private_root")
            .env("OPENSESAME_SERVICE_BINDINGS_FILE", spec.bindings);
        let child = Child::spawn(
            "opensesame-gateway",
            &mut command,
            &spec.log_dir.join("gateway.log"),
        )?;
        Ok(Self { ports, child })
    }

    /// Wait until both listeners accept.
    ///
    /// # Errors
    ///
    /// Either listener did not come up in time, or the process exited.
    pub fn wait_ready(&mut self, bound: Duration) -> Result<()> {
        self.child.wait_for_port(self.ports.plain, bound)?;
        self.child.wait_for_port(self.ports.tls, bound)
    }

    /// Did the process refuse to start? Returns its output.
    #[must_use]
    pub fn refused_to_start(&mut self, bound: Duration) -> Option<String> {
        let deadline = std::time::Instant::now() + bound;
        while std::time::Instant::now() < deadline {
            if self.child.exited() {
                return Some(self.child.log());
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        None
    }

    /// Everything the process logged.
    #[must_use]
    pub fn log(&self) -> String {
        self.child.log()
    }

    /// Is a port accepting connections right now?
    #[must_use]
    pub fn port_open(port: u16) -> bool {
        format!("127.0.0.1:{port}")
            .parse()
            .ok()
            .is_some_and(|addr| {
                std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok()
            })
    }
}
