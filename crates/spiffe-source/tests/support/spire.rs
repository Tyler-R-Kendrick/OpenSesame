//! A real SPIRE server + agent in tempdirs on loopback, killed on drop.
//!
//! Binaries come from `scripts/mtls/mtls-fixtures.sh path spire-server|spire-agent`
//! (SW-TESTOPS; v1.12.6 linux-amd64 musl, archive sha256
//! `b1919bf6917f7ae74212d8008dcfe92b0f7238d6cb50efdd15f1a1205aebf538`).

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

pub const TRUST_DOMAIN: &str = "example.test";
pub const AGENT_ID: &str = "spiffe://example.test/agent/reference";
pub const SPIRE_VERSION: &str = "1.12.6";

pub struct Spire {
    pub dir: tempfile::TempDir,
    pub server_socket: PathBuf,
    pub agent_socket: PathBuf,
    server_bin: PathBuf,
    server: Child,
    agent: Child,
}

impl Drop for Spire {
    fn drop(&mut self) {
        let _ = self.agent.kill();
        let _ = self.server.kill();
        let _ = self.agent.wait();
        let _ = self.server.wait();
    }
}

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("repo root")
}

/// Resolve a SPIRE binary through the shared, sha256-pinned fixture script.
pub fn binary(tool: &str) -> Result<PathBuf, String> {
    let script = repo_root().join("scripts/mtls/mtls-fixtures.sh");
    let out = Command::new("bash")
        .arg(&script)
        .arg("path")
        .arg(tool)
        .output()
        .map_err(|e| format!("run {}: {e}", script.display()))?;
    let path = PathBuf::from(String::from_utf8_lossy(&out.stdout).trim());
    if out.status.success() && path.is_file() {
        Ok(path)
    } else {
        Err(format!(
            "mtls-fixtures.sh path {tool} failed: {}",
            String::from_utf8_lossy(&out.stderr)
        ))
    }
}

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .expect("bind")
        .local_addr()
        .expect("addr")
        .port()
}

fn spawn(bin: &Path, args: &[&str], log: &Path) -> Result<Child, String> {
    let out = std::fs::File::create(log).map_err(|e| e.to_string())?;
    let err = out.try_clone().map_err(|e| e.to_string())?;
    Command::new(bin)
        .args(args)
        .stdin(Stdio::null())
        .stdout(out)
        .stderr(err)
        .spawn()
        .map_err(|e| format!("spawn {}: {e}", bin.display()))
}

fn wait_until(
    what: &str,
    timeout: Duration,
    mut probe: impl FnMut() -> bool,
) -> Result<(), String> {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if probe() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    Err(format!("timed out after {timeout:?} waiting for {what}"))
}

fn run(bin: &Path, args: &[&str]) -> Result<String, String> {
    let out = Command::new(bin)
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(format!(
            "{} {:?}: {}{}",
            bin.display(),
            args,
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        ))
    }
}

pub fn current_uid() -> u32 {
    use std::os::unix::fs::MetadataExt as _;
    std::fs::metadata("/proc/self")
        .map(|m| m.uid())
        .expect("uid")
}

fn server_conf(port: u16, server_socket: &Path, root: &Path) -> String {
    format!(
        r#"
server {{
    bind_address = "127.0.0.1"
    bind_port = "{port}"
    socket_path = "{server_socket}"
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
        server_socket = server_socket.display(),
        data = root.join("server-data").display()
    )
}

fn agent_conf(port: u16, agent_socket: &Path, root: &Path) -> String {
    format!(
        r#"
agent {{
    data_dir = "{data}"
    log_level = "INFO"
    trust_domain = "{TRUST_DOMAIN}"
    server_address = "127.0.0.1"
    server_port = {port}
    socket_path = "{agent_socket}"
    insecure_bootstrap = true
}}
plugins {{
    KeyManager "memory" {{ plugin_data {{}} }}
    NodeAttestor "join_token" {{ plugin_data {{}} }}
    WorkloadAttestor "unix" {{ plugin_data {{}} }}
}}
"#,
        data = root.join("agent-data").display(),
        agent_socket = agent_socket.display()
    )
}

/// Start the server, wait for its health check, and mint a join token.
fn start_server(
    server_bin: &Path,
    root: &Path,
    port: u16,
    socket: &Path,
) -> Result<(Child, String), String> {
    std::fs::write(root.join("server.conf"), server_conf(port, socket, root))
        .map_err(|e| e.to_string())?;
    let conf = root.join("server.conf").to_string_lossy().into_owned();
    let child = spawn(
        server_bin,
        &["run", "-config", &conf],
        &root.join("server.log"),
    )?;
    let ss = socket.to_string_lossy().into_owned();
    wait_until("spire-server healthcheck", Duration::from_secs(60), || {
        run(server_bin, &["healthcheck", "-socketPath", &ss]).is_ok()
    })?;
    let out = run(
        server_bin,
        &[
            "token",
            "generate",
            "-socketPath",
            &ss,
            "-spiffeID",
            AGENT_ID,
        ],
    )?;
    let token = out
        .lines()
        .find_map(|l| l.trim().strip_prefix("Token:"))
        .map(|t| t.trim().to_owned())
        .ok_or_else(|| format!("no token in: {out}"))?;
    Ok((child, token))
}

/// Start the agent with the join token and wait for its health check.
fn start_agent(
    agent_bin: &Path,
    root: &Path,
    port: u16,
    socket: &Path,
    token: &str,
) -> Result<Child, String> {
    std::fs::write(root.join("agent.conf"), agent_conf(port, socket, root))
        .map_err(|e| e.to_string())?;
    let conf = root.join("agent.conf").to_string_lossy().into_owned();
    let child = spawn(
        agent_bin,
        &["run", "-config", &conf, "-joinToken", token],
        &root.join("agent.log"),
    )?;
    let as_ = socket.to_string_lossy().into_owned();
    wait_until("spire-agent healthcheck", Duration::from_secs(60), || {
        run(agent_bin, &["healthcheck", "-socketPath", &as_]).is_ok()
    })?;
    Ok(child)
}

impl Spire {
    pub fn start() -> Result<Self, String> {
        let server_bin = binary("spire-server")?;
        let agent_bin = binary("spire-agent")?;
        let dir = tempfile::Builder::new()
            .prefix("os-spire-")
            .tempdir()
            .map_err(|e| e.to_string())?;
        let root = dir.path().to_path_buf();
        let port = free_port();
        let server_socket = root.join("server.sock");
        let agent_socket = root.join("agent.sock");
        let (server, token) = start_server(&server_bin, &root, port, &server_socket)?;
        let mut me = Self {
            dir,
            server_socket,
            agent_socket,
            server_bin,
            server,
            agent: Command::new("true").spawn().map_err(|e| e.to_string())?,
        };
        match start_agent(&agent_bin, &root, port, &me.agent_socket, &token) {
            Ok(agent) => me.agent = agent,
            Err(e) => return Err(format!("{e}\n{}", me.logs())),
        }
        Ok(me)
    }

    /// Register `spiffe_id` for the current uid under the reference agent;
    /// returns the entry id.
    pub fn create_entry(&self, spiffe_id: &str) -> Result<String, String> {
        let ss = self.server_socket.to_string_lossy().into_owned();
        let selector = format!("unix:uid:{}", current_uid());
        let out = run(
            &self.server_bin,
            &[
                "entry",
                "create",
                "-socketPath",
                &ss,
                "-parentID",
                AGENT_ID,
                "-spiffeID",
                spiffe_id,
                "-selector",
                &selector,
                "-x509SVIDTTL",
                "600",
            ],
        )?;
        out.lines()
            .find_map(|l| l.trim().strip_prefix("Entry ID"))
            .map(|v| v.trim_start_matches([' ', ':']).trim().to_owned())
            .ok_or_else(|| format!("no entry id in: {out}"))
    }

    pub fn delete_entry(&self, entry_id: &str) -> Result<(), String> {
        let ss = self.server_socket.to_string_lossy().into_owned();
        run(
            &self.server_bin,
            &["entry", "delete", "-socketPath", &ss, "-entryID", entry_id],
        )
        .map(|_| ())
    }

    /// Independent oracle: what the agent's own CLI says it issues to this
    /// uid (SPIFFE IDs, one per line).
    pub fn agent_fetch_ids(&self) -> Result<Vec<String>, String> {
        let agent_bin = binary("spire-agent")?;
        let as_ = self.agent_socket.to_string_lossy().into_owned();
        let out = run(&agent_bin, &["api", "fetch", "x509", "-socketPath", &as_])?;
        Ok(out
            .lines()
            .filter_map(|l| l.trim().strip_prefix("SPIFFE ID:"))
            .map(|v| v.trim().to_owned())
            .collect())
    }

    pub fn logs(&self) -> String {
        let read = |n: &str| std::fs::read_to_string(self.dir.path().join(n)).unwrap_or_default();
        format!(
            "--- server.log ---\n{}\n--- agent.log ---\n{}",
            read("server.log"),
            read("agent.log")
        )
    }
}
