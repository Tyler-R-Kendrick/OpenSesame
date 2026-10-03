//! The installed plugin as a real process: a settings file pinning the built
//! binary, the binary spawned with piped stdio, and a child-side client that
//! knows only what the reply's environment told it.

#![allow(dead_code)] // each suite uses a different subset

pub mod login_stub;

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use opensesame_plugin_settings::{notices_path, sha256_file, PluginSettings};
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, ServerName};
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

pub const BIN: &str = env!("CARGO_BIN_EXE_opensesame-surrogate-proxy");
pub const ID: &str = "surrogate-proxy";

/// A config directory with a settings file.
pub struct Install {
    pub dir: tempfile::TempDir,
    pub settings: PathBuf,
}

impl Install {
    /// Installed with the built binary's own pin, switched `enabled`.
    pub fn pinned(enabled: bool) -> Self {
        Self::with_pin(&sha256_file(Path::new(BIN)).unwrap(), enabled)
    }

    pub fn with_pin(pin: &str, enabled: bool) -> Self {
        let install = Self::empty();
        let mut settings = PluginSettings::default();
        settings.record_install(ID, "0.1.0", pin, BIN).unwrap();
        settings.set_enabled(ID, enabled).unwrap();
        settings.save(&install.settings).unwrap();
        install
    }

    /// Nothing installed at all.
    pub fn empty() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let settings = dir.path().join("plugins.json");
        Self { dir, settings }
    }

    pub fn notices(&self) -> PathBuf {
        notices_path(&self.settings, ID).unwrap()
    }

    pub fn spawn(&self, extra_env: &[(&str, &str)]) -> Plugin {
        self.spawn_with(extra_env, Stdio::null())
    }

    /// Spawned with its stderr written to [`Install::stderr_log`], so a test
    /// can scan everything the plugin said.
    pub fn spawn_logged(&self) -> Plugin {
        let log = std::fs::File::create(self.stderr_log()).unwrap();
        self.spawn_with(&[], Stdio::from(log))
    }

    pub fn stderr_log(&self) -> PathBuf {
        self.dir.path().join("plugin-stderr.log")
    }

    fn spawn_with(&self, extra_env: &[(&str, &str)], stderr: Stdio) -> Plugin {
        let mut command = Command::new(BIN);
        command
            .env("OPENSESAME_PLUGINS_FILE", &self.settings)
            .env_remove("OPENSESAME_PLUGIN_SURROGATE_PROXY")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(stderr);
        for (key, value) in extra_env {
            command.env(key, value);
        }
        let mut child = command.spawn().unwrap();
        let stdin = child.stdin.take();
        let stdout = BufReader::new(child.stdout.take().unwrap());
        let (sender, lines) = mpsc::channel();
        std::thread::spawn(move || {
            stdout
                .lines()
                .map_while(Result::ok)
                .try_for_each(|line| sender.send(line))
        });
        Plugin {
            child,
            stdin,
            lines,
        }
    }

    pub fn spec(&self, run_id: &str, ttl_secs: u64) -> Value {
        serde_json::json!({
            "run_id": run_id,
            "ttl_secs": ttl_secs,
            "entries": [
                {
                    "env_var": "GITHUB_TOKEN",
                    "provider_id": "github",
                    "connection_ref": "conn://local/github",
                    "site": "authorization",
                    "methods": ["GET", "POST"],
                    "path_prefixes": ["/user", "/repos/acme"],
                },
                {
                    "env_var": "WORKOS_API_KEY",
                    "provider_id": "workos",
                    "connection_ref": "conn://local/workos",
                    "site": "authorization",
                    "methods": ["GET"],
                    "path_prefixes": ["/"],
                },
            ],
            "notices_path": self.notices(),
        })
    }
}

pub struct Plugin {
    pub child: Child,
    pub stdin: Option<ChildStdin>,
    /// Every line the plugin writes on stdout, read on a thread so a test
    /// waiting for one that never comes fails instead of hanging.
    pub lines: Receiver<String>,
}

impl Plugin {
    pub fn send(&mut self, spec: &Value) {
        let stdin = self.stdin.as_mut().unwrap();
        let mut line = serde_json::to_vec(spec).unwrap();
        line.push(b'\n');
        stdin.write_all(&line).unwrap();
        stdin.flush().unwrap();
    }

    /// The next stdout line as JSON, or `Null` if none comes within 20s.
    pub fn reply(&mut self) -> Value {
        self.lines
            .recv_timeout(Duration::from_secs(20))
            .ok()
            .and_then(|line| serde_json::from_str(&line).ok())
            .unwrap_or(Value::Null)
    }

    /// Every line still unread, once the process has exited.
    pub fn rest(&mut self) -> String {
        let mut rest = String::new();
        while let Ok(line) = self.lines.recv_timeout(Duration::from_secs(2)) {
            rest.push_str(&line);
            rest.push('\n');
        }
        rest
    }

    /// Wait up to `limit` for the process to exit; its code, or `None`.
    pub fn exit_within(&mut self, limit: Duration) -> Option<i32> {
        let deadline = Instant::now() + limit;
        while Instant::now() < deadline {
            if let Some(status) = self.child.try_wait().unwrap() {
                return status.code();
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let _ = self.child.kill();
        None
    }
}

impl Drop for Plugin {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// `127.0.0.1:port` and `Basic …` from an `http://user:secret@host:port` URL.
pub fn proxy_parts(proxy_url: &str) -> (String, String) {
    let rest = proxy_url.trim_start_matches("http://");
    let (userinfo, addr) = rest.split_once('@').unwrap();
    (
        addr.to_owned(),
        format!("Basic {}", STANDARD.encode(userinfo)),
    )
}

/// CONNECT `host:443` through the proxy, TLS as `host` trusting only the CA
/// file, send `request`, and return the status line's code and the body.
pub async fn through_proxy(reply: &Value, host: &str, request: &str) -> Option<(u16, String)> {
    let (status, _, body) = through_proxy_at(reply, host, 443, request).await?;
    Some((status, body))
}

/// [`through_proxy`] to any port, returning the status, the response head
/// and the body.
pub async fn through_proxy_at(
    reply: &Value,
    host: &str,
    port: u16,
    request: &str,
) -> Option<(u16, String, String)> {
    let (addr, auth) = proxy_parts(reply["proxy_url"].as_str()?);
    let mut stream = TcpStream::connect(&addr).await.ok()?;
    let connect = format!(
        "CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\nProxy-Authorization: {auth}\r\n\r\n"
    );
    stream.write_all(connect.as_bytes()).await.ok()?;
    let head = read_head(&mut stream).await;
    if !head.starts_with("HTTP/1.1 200") {
        return None;
    }
    let ca = std::fs::read(reply["ca_pem_path"].as_str()?).ok()?;
    let der = CertificateDer::from_pem_slice(&ca).ok()?;
    let mut roots = rustls::RootCertStore::empty();
    roots.add(der).ok()?;
    let mut config = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .ok()?
    .with_root_certificates(roots)
    .with_no_client_auth();
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    let name = ServerName::try_from(host.to_owned()).ok()?;
    let mut tls = tokio_rustls::TlsConnector::from(Arc::new(config))
        .connect(name, stream)
        .await
        .ok()?;
    tls.write_all(request.as_bytes()).await.ok()?;
    let mut raw = Vec::new();
    let _ = tls.read_to_end(&mut raw).await;
    let text = String::from_utf8_lossy(&raw).into_owned();
    let status = text.split_whitespace().nth(1)?.parse().ok()?;
    let (head, body) = text.split_once("\r\n\r\n")?;
    Some((status, head.to_owned(), body.to_owned()))
}

async fn read_head(stream: &mut TcpStream) -> String {
    let mut buf = Vec::new();
    let mut byte = [0_u8; 1];
    while !buf.ends_with(b"\r\n\r\n") {
        if stream.read(&mut byte).await.unwrap_or(0) == 0 {
            break;
        }
        buf.push(byte[0]);
    }
    String::from_utf8_lossy(&buf).into_owned()
}

/// Wait up to ten seconds for `path` to contain `needle`; its text either way.
pub fn wait_for(path: &Path, needle: &str) -> String {
    let deadline = Instant::now() + Duration::from_secs(10);
    let tripwires = path.with_file_name(opensesame_plugin_settings::TRIPWIRES_FILE);
    loop {
        // Noise lands beside the path, evidence in the tripwires file.
        let mut text = std::fs::read_to_string(path).unwrap_or_default();
        text.push_str(&std::fs::read_to_string(&tripwires).unwrap_or_default());
        if text.contains(needle) || Instant::now() > deadline {
            return text;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// Wait up to five seconds for `path` (or the tripwires file beside it) to
/// have at least one line.
pub fn wait_for_lines(path: &Path) -> String {
    let deadline = Instant::now() + Duration::from_secs(5);
    let tripwires = path.with_file_name(opensesame_plugin_settings::TRIPWIRES_FILE);
    loop {
        let mut text = std::fs::read_to_string(path).unwrap_or_default();
        text.push_str(&std::fs::read_to_string(&tripwires).unwrap_or_default());
        if !text.is_empty() || Instant::now() > deadline {
            return text;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}
