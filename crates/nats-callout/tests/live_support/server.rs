//! The pinned nats-server, configured for **config-mode** auth callout
//! (`authorization { auth_callout { issuer, account, auth_users } }`) on a
//! TLS client listener.
//!
//! Operator mode (an operator JWT, an account signing key, `allowed_accounts`)
//! has different issuer/audience rules and is deliberately **not** exercised
//! here; nothing in this file should be read as evidence about it.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use super::pki::Pki;

/// The account the bridge itself lives in, where `$SYS.REQ.USER.AUTH` is
/// delivered.
pub const AUTH_ACCOUNT: &str = "AUTH";
/// The account admitted users are placed in (the user JWT's `aud`).
pub const APP_ACCOUNT: &str = "APP";

/// A loopback port nothing is listening on yet.
///
/// # Panics
///
/// When no port can be bound.
#[must_use]
pub fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .expect("bind")
        .local_addr()
        .expect("addr")
        .port()
}

pub struct NatsServer {
    child: Child,
    pub client_port: u16,
    pub server_public_key: String,
}

/// Render the config-mode auth-callout configuration. With `xkey` set, the
/// server seals every request to that curve key (`xkv1`) and refuses an
/// unsealed reply — the mode `crates/nats-callout/src/xkey.rs` implements.
#[must_use]
pub fn config_text(
    pki: &Pki,
    client_port: u16,
    monitor_port: u16,
    issuer_account: &str,
    bridge_user: &str,
    xkey: Option<&str>,
) -> String {
    let cert = pki.nats_cert.display();
    let key = pki.nats_key.display();
    let xkey_line = xkey
        .map(|k| format!("    xkey: \"{k}\"\n"))
        .unwrap_or_default();
    format!(
        "listen: 127.0.0.1:{client_port}\n\
         http: 127.0.0.1:{monitor_port}\n\
         tls {{\n  cert_file: \"{cert}\"\n  key_file: \"{key}\"\n  timeout: 5\n}}\n\
         accounts {{\n  {AUTH_ACCOUNT}: {{\n    users: [ {{ nkey: {bridge_user} }} ]\n  }}\n  \
         {APP_ACCOUNT}: {{ }}\n}}\n\
         authorization {{\n  timeout: 5\n  auth_callout {{\n    \
         issuer: \"{issuer_account}\"\n    account: {AUTH_ACCOUNT}\n    \
         auth_users: [ {bridge_user} ]\n{xkey_line}  }}\n}}\n"
    )
}

impl NatsServer {
    /// Write the configuration into `dir` and start the pinned binary.
    ///
    /// # Panics
    ///
    /// When `OPENSESAME_MTLS_BIN_NATS_SERVER` is unset, the process will not
    /// start, or it does not report a server key within ten seconds.
    #[must_use]
    pub fn start(
        dir: &Path,
        pki: &Pki,
        issuer_account: &str,
        bridge_user: &str,
        xkey: Option<&str>,
    ) -> Self {
        let binary = PathBuf::from(
            std::env::var("OPENSESAME_MTLS_BIN_NATS_SERVER")
                .expect("OPENSESAME_MTLS_BIN_NATS_SERVER"),
        );
        let client_port = free_port();
        let monitor_port = free_port();
        let config = dir.join("nats.conf");
        std::fs::write(
            &config,
            config_text(
                pki,
                client_port,
                monitor_port,
                issuer_account,
                bridge_user,
                xkey,
            ),
        )
        .expect("write nats.conf");
        let child = Command::new(&binary)
            .arg("-c")
            .arg(&config)
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn nats-server");
        let server_public_key = wait_for_key(monitor_port);
        Self {
            child,
            client_port,
            server_public_key,
        }
    }

    /// `tls://localhost:<port>` — the host name must be the one the
    /// listener's leaf carries, because async-nats derives the TLS server
    /// name from the URL rather than from the client configuration.
    #[must_use]
    pub fn url(&self) -> String {
        format!("tls://{}:{}", super::pki::NATS_DNS, self.client_port)
    }

    /// Stop the process.
    pub fn stop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for NatsServer {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Poll `/varz` until the server reports its public nkey (`server_id`, which
/// nats-server sets to the server key pair's public key). The deadline is
/// generous: the live tests spawn one server per test and run in parallel, so
/// a loaded machine can take a while to report.
fn wait_for_key(monitor_port: u16) -> String {
    let deadline = Instant::now() + Duration::from_secs(30);
    let url = format!("http://127.0.0.1:{monitor_port}/varz");
    while Instant::now() < deadline {
        if let Some(id) = server_key(&url) {
            return id;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    panic!("nats-server did not report a server key on {url}");
}

/// One `/varz` read, or `None` while the server is still coming up.
fn server_key(url: &str) -> Option<String> {
    let body = ureq_get(url).ok()?;
    let value: serde_json::Value = serde_json::from_str(&body).ok()?;
    value
        .get("server_id")
        .and_then(serde_json::Value::as_str)
        .filter(|id| id.starts_with('N'))
        .map(str::to_owned)
}

/// A one-line blocking HTTP GET — the monitoring endpoint is plain loopback
/// HTTP and pulling a client crate in for it is not worth it.
fn ureq_get(url: &str) -> std::io::Result<String> {
    use std::io::{Read as _, Write as _};
    let rest = url.trim_start_matches("http://");
    let (authority, path) = rest.split_once('/').unwrap_or((rest, ""));
    let mut socket = std::net::TcpStream::connect(authority)?;
    socket.set_read_timeout(Some(Duration::from_secs(2)))?;
    write!(
        socket,
        "GET /{path} HTTP/1.0\r\nHost: {authority}\r\nConnection: close\r\n\r\n"
    )?;
    let mut raw = String::new();
    socket.read_to_string(&mut raw)?;
    Ok(raw
        .split_once("\r\n\r\n")
        .map(|(_, body)| body.to_owned())
        .unwrap_or_default())
}
