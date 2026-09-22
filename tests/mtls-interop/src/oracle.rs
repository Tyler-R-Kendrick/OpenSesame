//! `/usr/bin/openssl s_client` as a third, independent TLS oracle.
//!
//! rustls (Host, worker, connectors) and Node/OpenSSL (Identity) are the two
//! runtimes under test. `s_client` is a third stack with its own chain
//! builder, its own name checker and its own alert vocabulary, so when it
//! agrees with both of them a refusal is a property of the *certificate*, not
//! of one library's opinion.
//!
//! The important distinction this module draws is the one the directive asks
//! for: a **handshake refusal** (no application bytes ever flow) is not the
//! same fact as a **post-handshake authorization denial** (a complete
//! handshake, then a `403`). [`Outcome`] keeps them apart by construction.

use std::path::Path;
use std::process::Command;
use std::time::Duration;

use anyhow::Result;

/// What an `s_client` attempt actually did.
#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    /// The handshake completed and the peer answered this HTTP status.
    Http(u16),
    /// The handshake completed but no HTTP status was parsed.
    HandshakeOnly,
    /// The handshake never completed; `diagnostic` is OpenSSL's own wording.
    Refused { diagnostic: String },
}

impl Outcome {
    /// Did TLS itself refuse, before any application byte?
    #[must_use]
    pub fn is_handshake_refusal(&self) -> bool {
        matches!(self, Self::Refused { .. })
    }

    /// The HTTP status, when the handshake completed.
    #[must_use]
    pub fn status(&self) -> Option<u16> {
        match self {
            Self::Http(code) => Some(*code),
            _ => None,
        }
    }

    /// OpenSSL's diagnostic for a refusal.
    #[must_use]
    pub fn diagnostic(&self) -> &str {
        match self {
            Self::Refused { diagnostic } => diagnostic,
            _ => "",
        }
    }
}

/// How to dial with `s_client`.
pub struct SClient<'a> {
    pub port: u16,
    pub servername: &'a str,
    pub ca_file: &'a Path,
    /// The leaf-first bundle; only its first certificate is offered, so
    /// `client_intermediates` carries the rest.
    pub client_chain: Option<&'a Path>,
    pub client_key: Option<&'a Path>,
    /// Issuers between the leaf and the root (`-cert_chain`).
    pub client_intermediates: Option<&'a Path>,
    /// Sent once the handshake is up; a bare `GET` is enough for a status.
    pub request: &'a str,
}

/// Every phrase OpenSSL uses when *it* refused, or the peer alerted.
const REFUSAL_MARKERS: [&str; 10] = [
    "alert",
    "verify error",
    "handshake failure",
    "certificate required",
    "certificate expired",
    "certificate verify failed",
    "unknown ca",
    "bad certificate",
    "no peer certificate available",
    "wrong version number",
];

/// Drive `openssl s_client` once and classify what happened.
///
/// # Errors
///
/// `openssl` could not be spawned.
pub fn s_client(spec: &SClient<'_>) -> Result<Outcome> {
    let target = format!("127.0.0.1:{}", spec.port);
    let ca = spec.ca_file.to_string_lossy().into_owned();
    let mut args = vec![
        "s_client".to_string(),
        "-connect".to_string(),
        target,
        "-servername".to_string(),
        spec.servername.to_string(),
        "-CAfile".to_string(),
        ca,
        "-verify_return_error".to_string(),
        "-verify".to_string(),
        "5".to_string(),
        "-quiet".to_string(),
        "-no_ign_eof".to_string(),
    ];
    if let (Some(chain), Some(key)) = (spec.client_chain, spec.client_key) {
        args.push("-cert".to_string());
        args.push(chain.to_string_lossy().into_owned());
        args.push("-key".to_string());
        args.push(key.to_string_lossy().into_owned());
        if let Some(extra) = spec.client_intermediates {
            args.push("-cert_chain".to_string());
            args.push(extra.to_string_lossy().into_owned());
        }
    }
    let mut command = Command::new("/usr/bin/openssl");
    command.args(&args);
    command.env("OPENSSL_CONF", "/dev/null");
    let request = spec.request.to_string();
    let (_code, stdout, stderr) = run_with_stdin(&mut command, &request, Duration::from_secs(20))?;
    Ok(classify(&stdout, &stderr))
}

fn classify(stdout: &str, stderr: &str) -> Outcome {
    if let Some(line) = stdout.lines().find(|l| l.starts_with("HTTP/")) {
        if let Some(code) = line.split_whitespace().nth(1).and_then(|c| c.parse().ok()) {
            return Outcome::Http(code);
        }
    }
    let lower = stderr.to_lowercase();
    if let Some(marker) = REFUSAL_MARKERS.iter().find(|m| lower.contains(*m)) {
        let diagnostic = stderr
            .lines()
            .find(|l| l.to_lowercase().contains(*marker))
            .unwrap_or(stderr)
            .trim()
            .to_string();
        return Outcome::Refused { diagnostic };
    }
    if stdout.is_empty() && !stderr.is_empty() {
        return Outcome::Refused {
            diagnostic: stderr.trim().to_string(),
        };
    }
    Outcome::HandshakeOnly
}

/// `run_bounded` with something written to the child's stdin first.
fn run_with_stdin(
    command: &mut Command,
    input: &str,
    bound: Duration,
) -> Result<(Option<i32>, String, String)> {
    use std::io::Write as _;
    use std::process::Stdio;
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(input.as_bytes());
    }
    let deadline = std::time::Instant::now() + bound;
    loop {
        if child.try_wait()?.is_some() {
            break;
        }
        if std::time::Instant::now() >= deadline {
            let _ = child.kill();
            break;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    let out = child.wait_with_output()?;
    Ok((
        out.status.code(),
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    ))
}

/// A minimal HTTP/1.1 request `s_client` can post over the completed session.
#[must_use]
pub fn get(path: &str, host: &str) -> String {
    format!("GET {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n")
}

/// Is the third-party oracle present at all? A missing `openssl` is a
/// `not_executed` result, never a pass.
#[must_use]
pub fn is_available() -> bool {
    Path::new("/usr/bin/openssl").exists()
}
