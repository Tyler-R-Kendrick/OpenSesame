//! SW-INTEROP's own SPIRE 1.12.6 reference deployment.
//!
//! A `spire-server` and a `spire-agent` on loopback in a temporary
//! directory, join-token node attestation, the `unix` workload attestor and
//! an in-memory key manager. Everything dies with the harness.
//!
//! SW-SPIFFE runs its own reference deployment for the adapter's happy path
//! and for identity removal. This one exists for the case that needs a second
//! trust domain: **federated bundle removal**, which cannot be shown by
//! adding things.

#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use anyhow::{bail, Context as _, Result};
use opensesame_mtls_interop::proc::{free_port, run_bounded, Child};
use opensesame_mtls_interop::{fixture_binary, fixture_version};

pub const TRUST_DOMAIN: &str = "iop.test";
pub const AGENT_ID: &str = "spiffe://iop.test/iop-agent";
/// The other trust domain this deployment federates with.
pub const PARTNER_DOMAIN: &str = "partner.iop.test";

/// A running SPIRE server + agent.
pub struct Spire {
    pub version: String,
    pub agent_socket: PathBuf,
    server_socket: PathBuf,
    server_bin: PathBuf,
    agent_bin: PathBuf,
    // Declaration order is drop order. The two processes must die before the
    // temporary directory that holds their sockets, configuration and
    // datastore is removed — otherwise the server loses its own socket while
    // it is still running and reports "no such file or directory".
    _agent: Child,
    _server: Child,
    dir: tempfile::TempDir,
}

fn cli(binary: &Path, args: &[&str]) -> Result<String> {
    let (code, stdout, stderr) =
        run_bounded(Command::new(binary).args(args), Duration::from_secs(60))?;
    if code != Some(0) {
        bail!(
            "{} {} failed ({code:?}): {stderr}{stdout}",
            binary.display(),
            args.join(" ")
        );
    }
    Ok(stdout)
}

fn wait_until(what: &str, bound: Duration, mut ready: impl FnMut() -> bool) -> Result<()> {
    let deadline = Instant::now() + bound;
    while Instant::now() < deadline {
        if ready() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    bail!("{what} did not become ready within {bound:?}")
}

impl Spire {
    /// Boot the deployment.
    ///
    /// # Errors
    ///
    /// A fixture is missing, or a process did not become healthy.
    pub fn start() -> Result<Self> {
        let server_bin = fixture_binary("spire-server")?;
        let agent_bin = fixture_binary("spire-agent")?;
        let version = fixture_version("spire-server")?;
        let dir = tempfile::Builder::new().prefix("iop-spire-").tempdir()?;
        let root = dir.path().to_path_buf();
        let port = free_port()?;
        let server_socket = root.join("server.sock");
        let agent_socket = root.join("agent.sock");
        std::fs::write(
            root.join("server.conf"),
            server_conf(port, &server_socket, &root),
        )?;
        let server = Child::spawn(
            "spire-server",
            Command::new(&server_bin)
                .arg("run")
                .arg("-config")
                .arg(root.join("server.conf")),
            &root.join("server.log"),
        )?;
        let ss = server_socket.to_string_lossy().into_owned();
        wait_until("spire-server", Duration::from_secs(90), || {
            cli(&server_bin, &["healthcheck", "-socketPath", &ss]).is_ok()
        })
        .with_context(|| server.log())?;
        let token = cli(
            &server_bin,
            &[
                "token",
                "generate",
                "-socketPath",
                &ss,
                "-spiffeID",
                AGENT_ID,
            ],
        )?;
        let token = token
            .lines()
            .find_map(|l| l.trim().strip_prefix("Token:"))
            .map(str::trim)
            .context("no join token")?
            .to_owned();
        std::fs::write(
            root.join("agent.conf"),
            agent_conf(port, &agent_socket, &root),
        )?;
        let agent = Child::spawn(
            "spire-agent",
            Command::new(&agent_bin)
                .arg("run")
                .arg("-config")
                .arg(root.join("agent.conf"))
                .arg("-joinToken")
                .arg(&token),
            &root.join("agent.log"),
        )?;
        let as_ = agent_socket.to_string_lossy().into_owned();
        wait_until("spire-agent", Duration::from_secs(90), || {
            cli(&agent_bin, &["healthcheck", "-socketPath", &as_]).is_ok()
        })
        .with_context(|| agent.log())?;
        Ok(Self {
            version,
            agent_socket,
            server_socket,
            server_bin,
            agent_bin,
            _agent: agent,
            _server: server,
            dir,
        })
    }

    fn server(&self, args: &[&str]) -> Result<String> {
        let socket = self.server_socket.to_string_lossy().into_owned();
        let mut full = vec![args[0], args[1], "-socketPath", &socket];
        full.extend_from_slice(&args[2..]);
        cli(&self.server_bin, &full)
    }

    /// Register a workload entry for the current uid; returns its id.
    ///
    /// # Errors
    ///
    /// The CLI refused, or printed no entry id.
    pub fn create_entry(&self, spiffe_id: &str, federates_with: Option<&str>) -> Result<String> {
        let selector = format!("unix:uid:{}", current_uid());
        let mut args = vec![
            "entry",
            "create",
            "-parentID",
            AGENT_ID,
            "-spiffeID",
            spiffe_id,
            "-selector",
            &selector,
            "-x509SVIDTTL",
            "600",
        ];
        let partner = federates_with.map(|d| format!("spiffe://{d}"));
        if let Some(partner) = partner.as_deref() {
            args.push("-federatesWith");
            args.push(partner);
        }
        let out = self.server(&args)?;
        out.lines()
            .find_map(|l| l.trim().strip_prefix("Entry ID"))
            .map(|v| v.trim_start_matches([' ', ':']).trim().to_owned())
            .with_context(|| format!("no entry id in: {out}"))
    }

    /// Remove an entry.
    ///
    /// # Errors
    ///
    /// The CLI refused.
    pub fn delete_entry(&self, entry_id: &str) -> Result<()> {
        self.server(&["entry", "delete", "-entryID", entry_id])
            .map(|_| ())
    }

    /// Install a foreign trust domain's bundle (a disposable self-signed
    /// root in PEM form) so entries may federate with it.
    ///
    /// # Errors
    ///
    /// The CLI refused.
    pub fn set_bundle(&self, domain: &str, pem: &Path) -> Result<()> {
        let socket = self.server_socket.to_string_lossy().into_owned();
        let id = format!("spiffe://{domain}");
        let path = pem.to_string_lossy().into_owned();
        cli(
            &self.server_bin,
            &[
                "bundle",
                "set",
                "-socketPath",
                &socket,
                "-id",
                &id,
                "-format",
                "pem",
                "-path",
                &path,
            ],
        )
        .map(|_| ())
    }

    /// Remove a foreign trust domain's bundle.
    ///
    /// # Errors
    ///
    /// The CLI refused.
    pub fn delete_bundle(&self, domain: &str) -> Result<()> {
        let socket = self.server_socket.to_string_lossy().into_owned();
        let id = format!("spiffe://{domain}");
        cli(
            &self.server_bin,
            &[
                "bundle",
                "delete",
                "-socketPath",
                &socket,
                "-id",
                &id,
                // `delete` would also remove every registration entry that
                // federates with this bundle — including the workload's own —
                // and the test would then be watching for the disappearance
                // of something it had itself deleted. `dissociate` removes
                // the bundle and unlinks it from the entries, which is what a
                // federation being revoked actually looks like.
                "-mode",
                "dissociate",
            ],
        )
        .map(|_| ())
    }

    /// The independent oracle: what the **agent's own CLI** reports the
    /// Workload API is handing this uid right now. A different
    /// implementation from the Rust `spiffe` SDK the adapter uses.
    ///
    /// # Errors
    ///
    /// The CLI refused.
    pub fn agent_fetch(&self) -> Result<String> {
        let socket = self.agent_socket.to_string_lossy().into_owned();
        cli(
            &self.agent_bin,
            &["api", "fetch", "x509", "-socketPath", &socket],
        )
    }

    /// Wait until `predicate` sees what it is looking for in the agent's
    /// own view of the Workload API.
    ///
    /// # Errors
    ///
    /// The deadline passed; the last observation is attached.
    pub fn wait_for_fetch(
        &self,
        what: &str,
        bound: Duration,
        predicate: impl Fn(&str) -> bool,
    ) -> Result<String> {
        let deadline = Instant::now() + bound;
        let mut last = String::new();
        while Instant::now() < deadline {
            last = self.agent_fetch().unwrap_or_default();
            if predicate(&last) {
                return Ok(last);
            }
            std::thread::sleep(Duration::from_millis(500));
        }
        bail!(
            "{what} never happened within {bound:?}\nlast fetch:\n{last}\n{}",
            self.logs()
        )
    }

    /// Both process logs.
    #[must_use]
    pub fn logs(&self) -> String {
        let read = |n: &str| std::fs::read_to_string(self.dir.path().join(n)).unwrap_or_default();
        format!(
            "--- server.log ---\n{}\n--- agent.log ---\n{}",
            read("server.log"),
            read("agent.log")
        )
    }

    /// The temporary directory everything lives in.
    #[must_use]
    pub fn dir(&self) -> &Path {
        self.dir.path()
    }
}

fn current_uid() -> u32 {
    use std::os::unix::fs::MetadataExt as _;
    std::fs::metadata("/proc/self")
        .map(|m| m.uid())
        .unwrap_or(0)
}

fn server_conf(port: u16, socket: &Path, root: &Path) -> String {
    format!(
        r#"
server {{
    bind_address = "127.0.0.1"
    bind_port = "{port}"
    socket_path = "{socket}"
    trust_domain = "{TRUST_DOMAIN}"
    data_dir = "{data}"
    log_level = "INFO"
    ca_ttl = "2h"
    default_x509_svid_ttl = "20m"
}}
plugins {{
    DataStore "sql" {{ plugin_data {{ database_type = "sqlite3" connection_string = "{data}/datastore.sqlite3" }} }}
    KeyManager "memory" {{ plugin_data {{}} }}
    NodeAttestor "join_token" {{ plugin_data {{}} }}
}}
"#,
        socket = socket.display(),
        data = root.join("server-data").display()
    )
}

fn agent_conf(port: u16, socket: &Path, root: &Path) -> String {
    format!(
        r#"
agent {{
    data_dir = "{data}"
    log_level = "INFO"
    trust_domain = "{TRUST_DOMAIN}"
    server_address = "127.0.0.1"
    server_port = {port}
    socket_path = "{socket}"
    insecure_bootstrap = true
}}
plugins {{
    KeyManager "memory" {{ plugin_data {{}} }}
    NodeAttestor "join_token" {{ plugin_data {{}} }}
    WorkloadAttestor "unix" {{ plugin_data {{}} }}
}}
"#,
        data = root.join("agent-data").display(),
        socket = socket.display()
    )
}
