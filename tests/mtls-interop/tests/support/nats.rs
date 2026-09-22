//! A pinned `nats-server` with certificate-mapped users, plus a raw NATS
//! client built out of `openssl s_client`.
//!
//! The raw client is the point. NATS' client protocol is line-oriented text
//! over TLS, so `openssl s_client` can speak it directly — which gives a
//! consumer that shares no code at all with `async-nats`, the crate the Host
//! publishes with. SW-NATS proved its own client against this server; what it
//! could not do is watch a *different* runtime receive what that client
//! published, or watch the server refuse that runtime the destinations its
//! certificate does not name.

#![allow(dead_code)]

use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use anyhow::{bail, Context as _, Result};
use opensesame_mtls_interop::pki::{Ca, Leaf, LeafSpec, Pki};
use opensesame_mtls_interop::proc::{free_port, Child};
use opensesame_mtls_interop::{fixture_binary, fixture_version};

/// The reference identity the broker's certificate carries.
pub const SERVER_DNS: &str = "localhost";
/// The subject tree both mapped users may touch.
pub const EVENTS: &str = "iop.events";
/// A subject tree neither mapped user may touch.
pub const FORBIDDEN: &str = "iop.system";

/// A running broker plus its disposable PKI.
pub struct Broker {
    pub port: u16,
    pub version: String,
    pub pki: Pki,
    pub ca: Ca,
    pub publisher: Leaf,
    pub consumer: Leaf,
    config: PathBuf,
    binary: PathBuf,
    child: Child,
}

impl Broker {
    /// Boot the pinned server with `verify_and_map` and two mapped users.
    ///
    /// # Errors
    ///
    /// The fixture is missing, or the broker did not listen in time.
    pub fn start() -> Result<Self> {
        let binary = fixture_binary("nats-server")?;
        let version = fixture_version("nats-server")?;
        let pki = Pki::new()?;
        let ca = pki.root("iop-nats-root")?;
        let server = ca.issue(&LeafSpec::server("broker", SERVER_DNS))?;
        let publisher = ca.issue(&LeafSpec::client_dns("publisher", "publisher.iop.test"))?;
        let consumer = ca.issue(&LeafSpec::client_dns("consumer", "consumer.iop.test"))?;
        let port = free_port()?;
        let config = write_config(pki.dir(), port, &server, &ca.cert)?;
        let child = spawn(&binary, &config, pki.dir(), port)?;
        Ok(Self {
            port,
            version,
            pki,
            ca,
            publisher,
            consumer,
            config,
            binary,
            child,
        })
    }

    /// Kill and restart the broker on the same port and configuration, so a
    /// client must re-handshake and be re-authorized from scratch.
    ///
    /// # Errors
    ///
    /// The broker did not come back.
    pub fn restart(&mut self) -> Result<()> {
        self.child.stop();
        // Give the kernel a moment to release the socket.
        std::thread::sleep(Duration::from_millis(300));
        self.child = spawn(&self.binary, &self.config, self.pki.dir(), self.port)?;
        Ok(())
    }

    /// Everything the broker has logged.
    #[must_use]
    pub fn log(&self) -> String {
        self.child.log()
    }

    /// Speak the NATS client protocol over TLS with `openssl s_client`,
    /// presenting `client`, sending `lines`, and reading for `dwell`.
    ///
    /// Returns everything the server sent. The child is always killed.
    ///
    /// # Errors
    ///
    /// `openssl` could not be started.
    pub fn raw_session(&self, client: &Leaf, lines: &[&str], dwell: Duration) -> Result<String> {
        let mut args = vec![
            "s_client".to_string(),
            "-connect".to_string(),
            format!("127.0.0.1:{}", self.port),
            "-servername".to_string(),
            SERVER_DNS.to_string(),
            "-CAfile".to_string(),
            self.ca.cert.to_string_lossy().into_owned(),
            "-cert".to_string(),
            client.chain.to_string_lossy().into_owned(),
            "-key".to_string(),
            client.key.to_string_lossy().into_owned(),
            "-verify_return_error".to_string(),
            "-quiet".to_string(),
        ];
        if let Some(extra) = client.intermediates.as_ref() {
            args.push("-cert_chain".to_string());
            args.push(extra.to_string_lossy().into_owned());
        }
        let mut child = Command::new("/usr/bin/openssl")
            .args(&args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .context("spawn openssl s_client for NATS")?;
        {
            let mut stdin = child.stdin.take().context("s_client stdin")?;
            for line in lines {
                // A write failure means the child already went away (a TLS
                // refusal, say). That is a *result*, not a harness error, so
                // it must not mask the transcript that explains it.
                if stdin.write_all(line.as_bytes()).is_err()
                    || stdin.write_all(b"\r\n").is_err()
                    || stdin.flush().is_err()
                {
                    break;
                }
                std::thread::sleep(Duration::from_millis(60));
            }
            // Leaving stdin open would block the read below; `-quiet` implies
            // `-ign_eof`, so closing it does not end the TLS session.
        }
        std::thread::sleep(dwell);
        let _ = child.kill();
        let out = child.wait_with_output()?;
        Ok(format!(
            "{}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        ))
    }
}

/// The `CONNECT` line a raw client sends. No credentials: the certificate is
/// the credential under `verify_and_map`.
#[must_use]
pub fn connect_line() -> String {
    r#"CONNECT {"verbose":false,"pedantic":false,"tls_required":true,"name":"iop-raw","lang":"openssl","version":"3.0"}"#.to_string()
}

fn spawn(binary: &Path, config: &Path, dir: &Path, port: u16) -> Result<Child> {
    let mut child = Child::spawn(
        "nats-server",
        Command::new(binary).arg("-c").arg(config),
        &dir.join(format!("nats-{port}.log")),
    )?;
    child.wait_for_port(port, Duration::from_secs(45))?;
    Ok(child)
}

fn write_config(dir: &Path, port: u16, server: &Leaf, ca: &Path) -> Result<PathBuf> {
    let config = dir.join("nats.conf");
    std::fs::write(
        &config,
        format!(
            r#"listen: 127.0.0.1:{port}
server_name: iop-broker
tls {{
  cert_file: "{cert}"
  key_file: "{key}"
  ca_file: "{ca}"
  verify_and_map: true
  # TLS-first. Without it nats-server speaks plaintext INFO before upgrading,
  # and a client that starts TLS immediately — `openssl s_client`, and the
  # production client with OPENSESAME_NATS_TLS_FIRST — is met with
  # "wrong version number".
  handshake_first: true
  timeout: 5
}}
authorization {{
  users = [
    {{
      user: "publisher.iop.test"
      permissions: {{
        publish: {{ allow: ["{EVENTS}.>"] }}
        subscribe: {{ allow: ["_INBOX.>"] }}
      }}
    }}
    {{
      user: "consumer.iop.test"
      permissions: {{
        subscribe: {{ allow: ["{EVENTS}.>"] }}
        publish: {{ deny: [">"] }}
      }}
    }}
  ]
}}
"#,
            cert = server.chain.display(),
            key = server.key.display(),
            ca = ca.display(),
        ),
    )?;
    Ok(config)
}

/// Fail with the broker's log attached.
///
/// # Errors
///
/// Always; this is a failure helper.
pub fn fail(broker: &Broker, what: &str, transcript: &str) -> Result<()> {
    bail!(
        "{what}\n--- server transcript ---\n{transcript}\n--- broker log ---\n{}",
        broker.log()
    )
}
