//! Tailnet caller identity via the tailscaled LocalAPI `whois` (ADR 0048 §8).
//!
//! When the daemon is reachable over Tailscale, a caller proves nothing by
//! presenting a token — the tailnet already authenticated the machine at the
//! WireGuard layer. This crate asks the local `tailscaled` *who* a remote
//! address is (`GET /localapi/v0/whois?addr=ip:port` over the tailscaled Unix
//! socket) and authorizes the answer against an explicit user/tag allowlist.
//! Identity comes from the platform, not from a presented secret — the SPIFFE
//! Workload API pattern, without adopting SPIFFE.
//!
//! Deliberately std-only for the transport: one GET over a Unix socket does
//! not justify an HTTP framework in the daemon's dependency budget. The
//! response is size-capped, JSON-parsed, and never followed anywhere. Every
//! failure mode — socket absent, non-200, malformed body, empty allowlists —
//! denies.

use serde::Deserialize;
use std::time::Duration;

/// Default tailscaled LocalAPI socket.
pub const DEFAULT_SOCKET_PATH: &str = "/var/run/tailscale/tailscaled.sock";

/// Bound on the whole whois exchange; LocalAPI answers are kilobytes at most.
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(2);

/// Hard cap on the response head + body. Anything larger is not a whois
/// answer worth parsing.
pub const MAX_RESPONSE_BYTES: usize = 64 * 1024;

/// What tailscaled says about a remote address. All fields tolerate absence:
/// a node can have no tags, and a tagged node has no user profile.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct WhoisIdentity {
    /// `Node.Name` — the node's MagicDNS name.
    pub node_name: Option<String>,
    /// `Node.Tags` — e.g. `tag:server`.
    pub tags: Vec<String>,
    /// `UserProfile.LoginName` — e.g. `user@example.com` or `github@github`.
    pub login_name: Option<String>,
}

impl WhoisIdentity {
    /// A stable label for rate-limit keying and logs. Falls back to the node
    /// name when the node is tagged and has no user profile.
    pub fn key(&self) -> Option<String> {
        self.login_name.clone().or_else(|| self.node_name.clone())
    }
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum AuthnError {
    #[error("tailscaled socket unavailable: {0}")]
    Socket(String),
    #[error("whois exchange failed: {0}")]
    Io(String),
    #[error("whois returned HTTP status {0}")]
    Status(u16),
    #[error("whois response exceeded {0} bytes")]
    TooLarge(usize),
    #[error("whois response malformed: {0}")]
    Malformed(String),
    #[error("tailscaled whois is not supported on this platform")]
    Unsupported,
}

/// Whois a `ip:port` against the default tailscaled socket.
#[cfg(unix)]
pub fn whois(addr: &str) -> Result<WhoisIdentity, AuthnError> {
    whois_via(
        std::path::Path::new(DEFAULT_SOCKET_PATH),
        addr,
        DEFAULT_TIMEOUT,
    )
}

/// Whois a `ip:port` against an explicit socket path with an explicit timeout.
///
/// One strict HTTP/1.1 GET with `Connection: close`; the response is read to
/// EOF under [`MAX_RESPONSE_BYTES`], the status must be exactly 200, and the
/// body must parse. Nothing is followed, retried, or upgraded.
#[cfg(unix)]
pub fn whois_via(
    socket_path: &std::path::Path,
    addr: &str,
    timeout: Duration,
) -> Result<WhoisIdentity, AuthnError> {
    use std::io::{Read, Write};
    use std::os::unix::net::UnixStream;

    let mut stream =
        UnixStream::connect(socket_path).map_err(|e| AuthnError::Socket(e.to_string()))?;
    stream
        .set_read_timeout(Some(timeout))
        .and_then(|()| stream.set_write_timeout(Some(timeout)))
        .map_err(|e| AuthnError::Io(e.to_string()))?;

    let request = format!(
        "GET /localapi/v0/whois?addr={} HTTP/1.1\r\n\
         Host: local-tailscaled.sock\r\n\
         User-Agent: opensesame-daemon\r\n\
         Accept: application/json\r\n\
         Connection: close\r\n\r\n",
        encode_query_value(addr)
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|e| AuthnError::Io(e.to_string()))?;

    let mut buf: Vec<u8> = Vec::with_capacity(4096);
    let mut chunk = [0u8; 8192];
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if buf.len() > MAX_RESPONSE_BYTES {
                    return Err(AuthnError::TooLarge(MAX_RESPONSE_BYTES));
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(AuthnError::Io(e.to_string())),
        }
    }
    parse_response(&buf)
}

/// Non-Unix stub: no tailscaled socket transport in v1 — fail closed.
#[cfg(not(unix))]
pub fn whois(addr: &str) -> Result<WhoisIdentity, AuthnError> {
    let _ = addr;
    Err(AuthnError::Unsupported)
}

/// Non-Unix stub: no tailscaled socket transport in v1 — fail closed.
#[cfg(not(unix))]
pub fn whois_via(
    socket_path: &std::path::Path,
    addr: &str,
    timeout: Duration,
) -> Result<WhoisIdentity, AuthnError> {
    let _ = (socket_path, addr, timeout);
    Err(AuthnError::Unsupported)
}

/// Fail-closed authorization. Empty allowlists deny everyone — an operator
/// who configures neither users nor tags has configured a listener that
/// serves nobody. A caller passes when its login name is in `allowed_users`
/// or any of its node tags is in `allowed_tags`.
pub fn authorize(
    identity: &WhoisIdentity,
    allowed_users: &[String],
    allowed_tags: &[String],
) -> bool {
    if allowed_users.is_empty() && allowed_tags.is_empty() {
        return false;
    }
    if let Some(login) = &identity.login_name {
        if allowed_users.iter().any(|u| u == login) {
            return true;
        }
    }
    identity
        .tags
        .iter()
        .any(|tag| allowed_tags.iter().any(|allowed| allowed == tag))
}

/// Parse a comma-separated allowlist (`OPENSESAME_TAILSCALE_ALLOW_USERS` /
/// `OPENSESAME_TAILSCALE_ALLOW_TAGS`). Blank entries are dropped.
pub fn parse_csv(csv: &str) -> Vec<String> {
    csv.split(',')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .map(str::to_string)
        .collect()
}

/// Minimal percent-encoding for a single query value (`ip:port` — the `:`
/// must not ride the query raw).
fn encode_query_value(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

#[derive(Deserialize)]
struct WhoisResponse {
    #[serde(rename = "Node", default)]
    node: Option<Node>,
    #[serde(rename = "UserProfile", default)]
    user_profile: Option<UserProfile>,
}

#[derive(Deserialize)]
struct Node {
    #[serde(rename = "Name", default)]
    name: Option<String>,
    #[serde(rename = "Tags", default)]
    tags: Option<Vec<String>>,
}

#[derive(Deserialize)]
struct UserProfile {
    #[serde(rename = "LoginName", default)]
    login_name: Option<String>,
}

/// Parse one raw LocalAPI whois response (head + body). Public so the fuzz
/// harness and hermetic tests can drive the parsing boundary without a
/// socket; the transport above is the only network path and it feeds exactly
/// this function.
pub fn parse_response(raw: &[u8]) -> Result<WhoisIdentity, AuthnError> {
    let head_end = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .ok_or_else(|| AuthnError::Malformed("no header terminator".into()))?;
    let head = std::str::from_utf8(&raw[..head_end])
        .map_err(|_| AuthnError::Malformed("non-utf8 head".into()))?;
    let mut lines = head.split("\r\n");
    let status_line = lines.next().unwrap_or("");
    let status: u16 = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse().ok())
        .ok_or_else(|| AuthnError::Malformed(format!("bad status line: {status_line}")))?;
    if status != 200 {
        return Err(AuthnError::Status(status));
    }
    let chunked = lines.any(|line| {
        let lower = line.to_ascii_lowercase();
        lower.starts_with("transfer-encoding:") && lower.contains("chunked")
    });
    let body_raw = &raw[head_end + 4..];
    let body = if chunked {
        decode_chunked(body_raw)?
    } else {
        body_raw.to_vec()
    };
    let parsed: WhoisResponse =
        serde_json::from_slice(&body).map_err(|e| AuthnError::Malformed(e.to_string()))?;
    Ok(WhoisIdentity {
        node_name: parsed.node.as_ref().and_then(|n| n.name.clone()),
        tags: parsed.node.and_then(|n| n.tags).unwrap_or_default(),
        login_name: parsed.user_profile.and_then(|u| u.login_name),
    })
}

/// Decode an HTTP/1.1 chunked body. No trailers, no extensions beyond a
/// tolerated `;ext` on the size line, total still under the response cap.
fn decode_chunked(mut rest: &[u8]) -> Result<Vec<u8>, AuthnError> {
    let malformed = || AuthnError::Malformed("bad chunked body".into());
    let mut out = Vec::new();
    loop {
        let line_end = rest
            .windows(2)
            .position(|w| w == b"\r\n")
            .ok_or_else(malformed)?;
        let size_text = std::str::from_utf8(&rest[..line_end]).map_err(|_| malformed())?;
        let size_text = size_text.split(';').next().unwrap_or("").trim();
        let size = usize::from_str_radix(size_text, 16).map_err(|_| malformed())?;
        rest = &rest[line_end + 2..];
        if size == 0 {
            break;
        }
        if rest.len() < size + 2 || &rest[size..size + 2] != b"\r\n" {
            return Err(malformed());
        }
        out.extend_from_slice(&rest[..size]);
        if out.len() > MAX_RESPONSE_BYTES {
            return Err(AuthnError::TooLarge(MAX_RESPONSE_BYTES));
        }
        rest = &rest[size + 2..];
    }
    Ok(out)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::os::unix::net::UnixListener;
    use std::path::PathBuf;

    /// Serve one fixed response on a throwaway UDS, returning its path.
    fn stub_server(response: &'static str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "tailscale-authn-test-{}-{:?}.sock",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_file(&path);
        let listener = UnixListener::bind(&path).expect("bind stub");
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            let mut buf = [0u8; 4096];
            // Read the request head; the test asserts on the response only.
            let _ = stream.read(&mut buf);
            stream.write_all(response.as_bytes()).expect("write");
        });
        path
    }

    fn whois_stub(path: &std::path::Path) -> Result<WhoisIdentity, AuthnError> {
        whois_via(path, "100.64.0.7:51522", Duration::from_secs(2))
    }

    const HAPPY: &str = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 132\r\n\r\n{\"Node\":{\"Name\":\"host.tailnet.ts.net.\",\"Tags\":[\"tag:server\",\"tag:prod\"]},\"UserProfile\":{\"LoginName\":\"alice@example.com\"}}";

    #[test]
    fn happy_path_parses_node_and_profile() {
        let path = stub_server(HAPPY);
        let id = whois_stub(&path).expect("whois");
        assert_eq!(id.node_name.as_deref(), Some("host.tailnet.ts.net."));
        assert_eq!(id.tags, vec!["tag:server", "tag:prod"]);
        assert_eq!(id.login_name.as_deref(), Some("alice@example.com"));
        assert_eq!(id.key().as_deref(), Some("alice@example.com"));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn missing_socket_fails_closed() {
        let path = std::env::temp_dir().join("tailscale-authn-no-such-sock.sock");
        let err = whois_stub(&path).expect_err("must fail");
        assert!(matches!(err, AuthnError::Socket(_)));
    }

    #[test]
    fn non_200_fails_closed() {
        let path = stub_server("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
        let err = whois_stub(&path).expect_err("must fail");
        assert_eq!(err, AuthnError::Status(403));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn malformed_json_fails_closed() {
        let path = stub_server("HTTP/1.1 200 OK\r\nContent-Length: 9\r\n\r\nnot json!");
        let err = whois_stub(&path).expect_err("must fail");
        assert!(matches!(err, AuthnError::Malformed(_)));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn missing_user_profile_is_tolerated() {
        let path = stub_server(
            "HTTP/1.1 200 OK\r\nContent-Length: 66\r\n\r\n{\"Node\":{\"Name\":\"tagged.ts.net.\",\"Tags\":[\"tag:ci\"]}}",
        );
        let id = whois_stub(&path).expect("whois");
        assert_eq!(id.login_name, None);
        assert_eq!(id.tags, vec!["tag:ci"]);
        // A tagged node still passes on its tag.
        assert!(authorize(&id, &[], &["tag:ci".to_string()]));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn chunked_body_is_decoded() {
        let path = stub_server(
            "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n23\r\n{\"UserProfile\":{\"LoginName\":\"bob\"}}\r\n0\r\n\r\n",
        );
        let id = whois_stub(&path).expect("whois");
        assert_eq!(id.login_name.as_deref(), Some("bob"));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn oversized_response_fails_closed() {
        // The stub response itself exceeds the cap before any parsing.
        let big = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: 70000\r\n\r\n{}",
            " ".repeat(70_000)
        );
        let leaked: &'static str = Box::leak(big.into_boxed_str());
        let path = stub_server(leaked);
        let err = whois_stub(&path).expect_err("must fail");
        assert_eq!(err, AuthnError::TooLarge(MAX_RESPONSE_BYTES));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn authorize_matches_user_or_tag() {
        let id = WhoisIdentity {
            node_name: Some("host.ts.net.".into()),
            tags: vec!["tag:server".into()],
            login_name: Some("alice@example.com".into()),
        };
        assert!(authorize(&id, &["alice@example.com".into()], &[]));
        assert!(authorize(&id, &[], &["tag:server".into()]));
        assert!(!authorize(&id, &["carol@example.com".into()], &[]));
        assert!(!authorize(&id, &[], &["tag:other".into()]));
    }

    #[test]
    fn authorize_empty_allowlists_deny() {
        let id = WhoisIdentity {
            node_name: None,
            tags: vec!["tag:server".into()],
            login_name: Some("alice@example.com".into()),
        };
        assert!(!authorize(&id, &[], &[]));
        assert!(!authorize(&WhoisIdentity::default(), &[], &[]));
    }

    #[test]
    fn parse_csv_trims_and_drops_blanks() {
        assert_eq!(parse_csv("a, b ,,c"), vec!["a", "b", "c"]);
        assert_eq!(parse_csv(""), Vec::<String>::new());
    }

    #[test]
    fn query_encoding_escapes_the_port_separator() {
        assert_eq!(encode_query_value("100.64.0.7:51522"), "100.64.0.7%3A51522");
    }
}
