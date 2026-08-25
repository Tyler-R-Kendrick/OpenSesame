//! Two ways to reach the [`Session`], both **default off** (C7).
//!
//! # 1. stdio native-messaging host — the recommended install
//!
//! The browser `exec`s this binary and speaks length-prefixed JSON on the
//! pipe. There is no shared name to contend for, so `KeePassXC` and this bridge
//! can be installed side by side; whichever manifest is present under the
//! host name `org.keepassxc.keepassxc_browser` wins, and swapping is a file
//! copy. This sidesteps the socket singleton entirely.
//!
//! # 2. UDS server — the compatibility path
//!
//! `$XDG_RUNTIME_DIR/org.keepassxc.KeePassXC.BrowserServer` is what the
//! *stock* `keepassxc-proxy` connects to. Serving it lets an existing proxy
//! install work unchanged — but the name is a singleton, so the server
//! probes first and refuses, naming the live owner, rather than stealing it.
//! `--takeover` removes only a **verified-dead** socket.
//!
//! On this socket the frames are bare JSON documents, not length-prefixed:
//! the proxy strips the native-messaging header before forwarding. A
//! streaming JSON reader handles both one-object-per-write and coalesced
//! writes.

use std::io::{Read, Write};
use std::path::Path;

use serde_json::Value;

use crate::conflict::{probe_unix_socket, takeover_if_dead, SocketState};
use crate::framing::{self, ReadOutcome};
use crate::keepassxc::Session;
use crate::BridgeError;

/// Largest bare-JSON request accepted on the UDS transport.
pub const MAX_UDS_MESSAGE: usize = 1024 * 1024;

/// Serve the native-messaging protocol on a reader/writer pair until EOF.
///
/// # Errors
///
/// Returns a framing, protocol, or I/O error that prevents continued service.
pub fn serve_stdio(
    session: &mut Session,
    reader: &mut impl Read,
    writer: &mut impl Write,
) -> Result<(), BridgeError> {
    loop {
        let raw = match framing::read_message(reader) {
            Ok(ReadOutcome::Eof) => return Ok(()),
            Ok(ReadOutcome::Message(bytes)) => bytes,
            // A desynchronised pipe cannot be resynchronised: the length
            // prefix is the only frame boundary there is. Stop reading.
            Err(error) => return Err(error),
        };
        let response = session.handle(&raw);
        framing::write_json(writer, &response)?;
    }
}

/// Serve one already-connected UDS client until it disconnects.
///
/// # Errors
///
/// Returns an I/O or protocol error, including oversized requests.
pub fn serve_uds_connection(
    session: &mut Session,
    stream: &mut (impl Read + Write),
) -> Result<(), BridgeError> {
    let mut buffer: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        let read = match stream.read(&mut chunk) {
            Ok(0) => return Ok(()),
            Ok(n) => n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(BridgeError::Io(e)),
        };
        buffer.extend_from_slice(&chunk[..read]);
        if buffer.len() > MAX_UDS_MESSAGE {
            return Err(BridgeError::Protocol("request exceeds the size cap".into()));
        }
        // Drain every complete JSON document the peer has sent so far.
        while let Some((value, consumed)) = next_json(&buffer) {
            buffer.drain(..consumed);
            let raw = serde_json::to_vec(&value)
                .map_err(|e| BridgeError::Protocol(format!("unserializable request: {e}")))?;
            let response = session.handle(&raw);
            let bytes = serde_json::to_vec(&response)
                .map_err(|e| BridgeError::Protocol(format!("unserializable response: {e}")))?;
            stream.write_all(&bytes)?;
            stream.flush()?;
        }
    }
}

/// Pull the first complete JSON value out of `buffer`, if there is one.
fn next_json(buffer: &[u8]) -> Option<(Value, usize)> {
    let start = buffer.iter().position(|b| !b.is_ascii_whitespace())?;
    let mut stream = serde_json::Deserializer::from_slice(&buffer[start..]).into_iter::<Value>();
    match stream.next()? {
        Ok(value) => Some((value, start + stream.byte_offset())),
        // Distinguish "not yet complete" from "definitely broken": only the
        // former should wait for more bytes, but treating both as "wait" is
        // safe because the size cap bounds how long we can wait.
        Err(_) => None,
    }
}

/// Bind the singleton socket, refusing rather than stealing a live one.
///
/// The refusal carries the owner's identity, because "address in use" is a
/// useless thing to tell someone whose passwords just stopped autofilling.
///
/// # Errors
///
/// Returns a conflict error for an occupied path or an I/O error while binding.
#[cfg(unix)]
pub fn bind_uds(
    path: &Path,
    takeover: bool,
) -> Result<std::os::unix::net::UnixListener, BridgeError> {
    use std::os::unix::net::UnixListener;

    let state = if takeover {
        takeover_if_dead(path)?
    } else {
        probe_unix_socket(path)
    };
    if state != SocketState::Free {
        return Err(BridgeError::Conflict(state.diagnostic(path)));
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let listener = UnixListener::bind(path)?;
    restrict_socket(path);
    Ok(listener)
}

/// The socket must not be reachable by other users on the machine (C2(a)).
#[cfg(unix)]
fn restrict_socket(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn next_json_splits_concatenated_documents() {
        let buffer = br#"{"a":1}{"b":2}"#;
        let (first, consumed) = next_json(buffer).unwrap();
        assert_eq!(first["a"], 1);
        let (second, _) = next_json(&buffer[consumed..]).unwrap();
        assert_eq!(second["b"], 2);
    }

    #[test]
    fn next_json_skips_leading_whitespace() {
        let (value, consumed) = next_json(b"  \n {\"a\":1}").unwrap();
        assert_eq!(value["a"], 1);
        assert_eq!(consumed, 11);
    }

    #[test]
    fn next_json_waits_for_an_incomplete_document() {
        assert!(next_json(br#"{"a":"#).is_none());
        assert!(next_json(b"").is_none());
        assert!(next_json(b"   ").is_none());
    }
}
