//! Runs the pinned reference ingress (`ops/ingress/Caddyfile`) as a child
//! process against a disposable PKI. The binary comes from
//! `scripts/mtls-fixtures.sh path caddy`, which fetches and sha256-verifies it.

use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use opensesame_transport_security::testkit::{DisposableCa, IssuedLeaf};
use tempfile::TempDir;

use super::Pki;

pub const INGRESS_NAME: &str = "ingress.test";

pub fn fixtures_enabled() -> bool {
    std::env::var("OPENSESAME_MTLS_FIXTURES").as_deref() == Ok("1")
}

pub fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("repository root")
}

pub fn caddy_binary() -> PathBuf {
    let output = Command::new("bash")
        .arg(repo_root().join("scripts/mtls-fixtures.sh"))
        .args(["path", "caddy"])
        .output()
        .expect("run scripts/mtls-fixtures.sh");
    assert!(
        output.status.success(),
        "mtls-fixtures.sh path caddy failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    PathBuf::from(String::from_utf8_lossy(&output.stdout).trim())
}

pub fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .expect("bind")
        .local_addr()
        .expect("addr")
        .port()
}

/// The hop-1 server identity and the CA originating clients trust for it.
pub struct Edge {
    pub ca: DisposableCa,
    pub server: IssuedLeaf,
}

impl Edge {
    pub fn new() -> Self {
        let ca = DisposableCa::new("edge-ca");
        let server = ca.issue_server(INGRESS_NAME);
        Self { ca, server }
    }
}

pub struct Caddy {
    child: Child,
    pub addr: SocketAddr,
    pub health: SocketAddr,
    dir: TempDir,
}

impl Drop for Caddy {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Starts Caddy with `ingress_identity` as its hop-2 client certificate.
pub fn start(pki: &Pki, edge: &Edge, ingress_identity: &IssuedLeaf, origin: SocketAddr) -> Caddy {
    let dir = opensesame_transport_security::testkit::tempdir();
    let (server_cert, server_key) = edge.server.write_to(dir.path());
    let clientdir = dir.path().join("client");
    std::fs::create_dir_all(&clientdir).expect("client dir");
    let (client_cert, client_key) = ingress_identity.write_to(&clientdir);
    let originating_trust = dir.path().join("originating-root.pem");
    std::fs::write(&originating_trust, pki.originating_root.ca_pem()).expect("write trust");
    let origin_trust = dir.path().join("origin-ca.pem");
    std::fs::write(&origin_trust, pki.origin_ca.ca_pem()).expect("write origin trust");
    let port = free_port();
    let health_port = free_port();
    let log = std::fs::File::create(dir.path().join("caddy.log")).expect("log file");
    let child = Command::new(caddy_binary())
        .args(["run", "--config"])
        .arg(repo_root().join("ops/ingress/Caddyfile"))
        .args(["--adapter", "caddyfile"])
        .env("OPENSESAME_INGRESS_BIND", "127.0.0.1")
        .env("OPENSESAME_INGRESS_PORT", port.to_string())
        .env("OPENSESAME_INGRESS_CERT", &server_cert)
        .env("OPENSESAME_INGRESS_KEY", &server_key)
        .env("OPENSESAME_ORIGINATING_TRUST", &originating_trust)
        .env("OPENSESAME_ORIGIN_ADDR", origin.to_string())
        .env("OPENSESAME_ORIGIN_TRUST", &origin_trust)
        .env("OPENSESAME_ORIGIN_NAME", super::ORIGIN_NAME)
        .env("OPENSESAME_INGRESS_CLIENT_CERT", &client_cert)
        .env("OPENSESAME_INGRESS_CLIENT_KEY", &client_key)
        .env("OPENSESAME_INGRESS_HEALTH_PORT", health_port.to_string())
        .env("XDG_DATA_HOME", dir.path())
        .env("XDG_CONFIG_HOME", dir.path())
        .stdin(Stdio::null())
        .stdout(Stdio::from(log.try_clone().expect("log clone")))
        .stderr(Stdio::from(log))
        .spawn()
        .expect("spawn caddy");
    let mut caddy = Caddy {
        child,
        addr: SocketAddr::from(([127, 0, 0, 1], port)),
        health: SocketAddr::from(([127, 0, 0, 1], health_port)),
        dir,
    };
    caddy.wait_ready();
    caddy
}

impl Caddy {
    fn wait_ready(&mut self) {
        let deadline = Instant::now() + Duration::from_secs(20);
        while Instant::now() < deadline {
            if let Some(status) = self.child.try_wait().expect("try_wait") {
                let log =
                    std::fs::read_to_string(self.dir.path().join("caddy.log")).unwrap_or_default();
                panic!("caddy exited early with {status}: {log}");
            }
            if TcpStream::connect_timeout(&self.health, Duration::from_millis(200)).is_ok()
                && TcpStream::connect_timeout(&self.addr, Duration::from_millis(200)).is_ok()
            {
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let log = std::fs::read_to_string(self.dir.path().join("caddy.log")).unwrap_or_default();
        panic!("caddy did not become ready: {log}");
    }

    pub fn log(&self) -> String {
        std::fs::read_to_string(self.dir.path().join("caddy.log")).unwrap_or_default()
    }
}
