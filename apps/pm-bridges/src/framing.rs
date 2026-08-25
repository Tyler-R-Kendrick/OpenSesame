//! Chrome/Firefox **native-messaging** stdio framing.
//!
//! The wire format is fixed by the browsers: a 32-bit **little-endian**
//! length prefix in native byte order (every supported platform is
//! little-endian, and both Chrome and Firefox hard-code LE in practice),
//! followed by exactly that many bytes of UTF-8 JSON. Both
//! browserpass-native and gopass-jsonapi use it verbatim, and the
//! keepassxc-proxy uses it on the browser-facing half of its pipe.
//!
//! Everything here is defensive: the length prefix is attacker-influenced
//! (an extension, or anything that can talk to the host's stdin), so a
//! bounded [`MAX_MESSAGE_BYTES`] cap is applied *before* a single byte is
//! allocated.

use std::io::{ErrorKind, Read, Write};

use crate::BridgeError;

/// Largest message we will read or write.
///
/// Chrome caps a message *from* an extension at 1 MiB and *to* an extension
/// at 64 MiB; 1 MiB is the tighter of the two and is far beyond anything a
/// password-manager protocol needs. Refusing early keeps a bogus prefix from
/// turning into a 4 GiB allocation.
pub const MAX_MESSAGE_BYTES: u32 = 1024 * 1024;

/// Outcome of a read attempt on a native-messaging stream.
#[derive(Debug)]
pub enum ReadOutcome {
    /// A complete, length-prefixed message.
    Message(Vec<u8>),
    /// The peer closed the pipe cleanly on a message boundary.
    Eof,
}

/// Encode `payload` as a framed native-messaging message.
///
/// Fails rather than truncating when the payload exceeds
/// [`MAX_MESSAGE_BYTES`] — a silently truncated frame would desynchronise
/// the stream for every message after it.
///
/// # Errors
///
/// Returns [`BridgeError::Protocol`] when `payload` exceeds the framing cap.
pub fn encode_frame(payload: &[u8]) -> Result<Vec<u8>, BridgeError> {
    let len = u32::try_from(payload.len())
        .ok()
        .filter(|len| *len <= MAX_MESSAGE_BYTES)
        .ok_or_else(|| {
            BridgeError::Protocol(format!(
                "outbound message of {} bytes exceeds the {MAX_MESSAGE_BYTES}-byte cap",
                payload.len()
            ))
        })?;
    let mut out = Vec::with_capacity(4 + payload.len());
    out.extend_from_slice(&len.to_le_bytes());
    out.extend_from_slice(payload);
    Ok(out)
}

/// Decode exactly one framed message from an in-memory buffer.
///
/// Returns the payload and the number of bytes consumed. A buffer holding
/// only part of a frame is a [`BridgeError::Protocol`] — callers that stream
/// should use [`read_message`] instead.
///
/// # Errors
///
/// Returns [`BridgeError::Protocol`] for an incomplete or oversized frame.
pub fn decode_frame(buf: &[u8]) -> Result<(Vec<u8>, usize), BridgeError> {
    if buf.len() < 4 {
        return Err(BridgeError::Protocol("truncated length prefix".into()));
    }
    let len = u32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]);
    if len > MAX_MESSAGE_BYTES {
        return Err(BridgeError::Protocol(format!(
            "inbound message of {len} bytes exceeds the {MAX_MESSAGE_BYTES}-byte cap"
        )));
    }
    let len = len as usize;
    let end = 4usize
        .checked_add(len)
        .ok_or_else(|| BridgeError::Protocol("length prefix overflows".into()))?;
    if buf.len() < end {
        return Err(BridgeError::Protocol("truncated message body".into()));
    }
    Ok((buf[4..end].to_vec(), end))
}

/// Read one framed message from `reader`, blocking until it is complete.
///
/// # Errors
///
/// Returns an I/O error or [`BridgeError::Protocol`] for an invalid frame.
pub fn read_message(reader: &mut impl Read) -> Result<ReadOutcome, BridgeError> {
    let mut header = [0u8; 4];
    match fill(reader, &mut header)? {
        0 => return Ok(ReadOutcome::Eof),
        4 => {}
        _ => return Err(BridgeError::Protocol("truncated length prefix".into())),
    }
    let len = u32::from_le_bytes(header);
    if len > MAX_MESSAGE_BYTES {
        return Err(BridgeError::Protocol(format!(
            "inbound message of {len} bytes exceeds the {MAX_MESSAGE_BYTES}-byte cap"
        )));
    }
    let mut body = vec![0u8; len as usize];
    if fill(reader, &mut body)? != body.len() {
        return Err(BridgeError::Protocol("truncated message body".into()));
    }
    Ok(ReadOutcome::Message(body))
}

/// Write one framed message to `writer` and flush it.
///
/// # Errors
///
/// Returns an I/O error or the framing error from [`encode_frame`].
pub fn write_message(writer: &mut impl Write, payload: &[u8]) -> Result<(), BridgeError> {
    let frame = encode_frame(payload)?;
    writer.write_all(&frame)?;
    writer.flush()?;
    Ok(())
}

/// Fill `buf`, returning how many bytes were read before EOF. `0` on a
/// message boundary is a clean shutdown; anything in between is a truncation
/// the caller reports in context.
fn fill(reader: &mut impl Read, buf: &mut [u8]) -> Result<usize, BridgeError> {
    let mut filled = 0usize;
    while filled < buf.len() {
        match reader.read(&mut buf[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(e) if e.kind() == ErrorKind::Interrupted => {}
            Err(e) => return Err(BridgeError::Io(e)),
        }
    }
    Ok(filled)
}

/// Read a framed message and parse it as JSON.
///
/// # Errors
///
/// Returns a framing, I/O, or JSON protocol error.
pub fn read_json<T: serde::de::DeserializeOwned>(
    reader: &mut impl Read,
) -> Result<Option<T>, BridgeError> {
    match read_message(reader)? {
        ReadOutcome::Eof => Ok(None),
        ReadOutcome::Message(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|e| BridgeError::Protocol(format!("malformed JSON request: {e}"))),
    }
}

/// Serialize `value` as JSON and write it as a framed message.
///
/// # Errors
///
/// Returns a serialization, framing, or I/O error.
pub fn write_json<T: serde::Serialize>(
    writer: &mut impl Write,
    value: &T,
) -> Result<(), BridgeError> {
    let bytes = serde_json::to_vec(value)
        .map_err(|e| BridgeError::Protocol(format!("unserializable response: {e}")))?;
    write_message(writer, &bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_a_message() {
        let payload = br#"{"action":"list"}"#;
        let frame = encode_frame(payload).expect("encode");
        let payload_len = u32::try_from(payload.len()).expect("test payload fits u32");
        assert_eq!(&frame[..4], &payload_len.to_le_bytes());
        let (decoded, consumed) = decode_frame(&frame).expect("decode");
        assert_eq!(decoded, payload);
        assert_eq!(consumed, frame.len());
    }

    #[test]
    fn round_trips_through_a_stream() {
        let mut out = Vec::new();
        write_message(&mut out, b"first").unwrap();
        write_message(&mut out, b"second").unwrap();
        let mut cursor = std::io::Cursor::new(out);
        let ReadOutcome::Message(a) = read_message(&mut cursor).unwrap() else {
            panic!("expected a message");
        };
        let ReadOutcome::Message(b) = read_message(&mut cursor).unwrap() else {
            panic!("expected a message");
        };
        assert_eq!(a, b"first");
        assert_eq!(b, b"second");
        assert!(matches!(
            read_message(&mut cursor).unwrap(),
            ReadOutcome::Eof
        ));
    }

    #[test]
    fn empty_payload_is_a_valid_frame() {
        let frame = encode_frame(b"").unwrap();
        assert_eq!(frame, vec![0, 0, 0, 0]);
        let (decoded, consumed) = decode_frame(&frame).unwrap();
        assert!(decoded.is_empty());
        assert_eq!(consumed, 4);
    }

    #[test]
    fn rejects_oversize_encode() {
        let payload = vec![0u8; MAX_MESSAGE_BYTES as usize + 1];
        let err = encode_frame(&payload).unwrap_err();
        assert!(matches!(err, BridgeError::Protocol(_)));
    }

    #[test]
    fn rejects_oversize_prefix_without_allocating() {
        let mut frame = u32::MAX.to_le_bytes().to_vec();
        frame.extend_from_slice(b"tiny");
        let err = decode_frame(&frame).unwrap_err();
        assert!(err.to_string().contains("exceeds"));

        let mut cursor = std::io::Cursor::new(frame);
        let err = read_message(&mut cursor).unwrap_err();
        assert!(err.to_string().contains("exceeds"));
    }

    #[test]
    fn rejects_truncated_prefix() {
        let err = decode_frame(&[1, 2, 3]).unwrap_err();
        assert!(err.to_string().contains("truncated length prefix"));
    }

    #[test]
    fn rejects_truncated_body() {
        let mut frame = 16u32.to_le_bytes().to_vec();
        frame.extend_from_slice(b"only-four");
        let err = decode_frame(&frame).unwrap_err();
        assert!(err.to_string().contains("truncated message body"));

        let mut cursor = std::io::Cursor::new(frame);
        let err = read_message(&mut cursor).unwrap_err();
        assert!(err.to_string().contains("truncated message body"));
    }

    #[test]
    fn eof_on_a_boundary_is_not_an_error() {
        let mut cursor = std::io::Cursor::new(Vec::new());
        assert!(matches!(
            read_message(&mut cursor).unwrap(),
            ReadOutcome::Eof
        ));
    }

    #[test]
    fn partial_prefix_at_eof_is_an_error() {
        let mut cursor = std::io::Cursor::new(vec![1u8, 2, 3]);
        let err = read_message(&mut cursor).unwrap_err();
        assert!(matches!(err, BridgeError::Protocol(_)));
    }

    #[test]
    fn json_helpers_round_trip() {
        #[derive(serde::Serialize, serde::Deserialize, PartialEq, Debug)]
        struct Msg {
            action: String,
        }
        let mut buf = Vec::new();
        write_json(
            &mut buf,
            &Msg {
                action: "echo".into(),
            },
        )
        .unwrap();
        let mut cursor = std::io::Cursor::new(buf);
        let got: Option<Msg> = read_json(&mut cursor).unwrap();
        assert_eq!(
            got,
            Some(Msg {
                action: "echo".into()
            })
        );
        let none: Option<Msg> = read_json(&mut cursor).unwrap();
        assert!(none.is_none());
    }

    #[test]
    fn malformed_json_is_a_protocol_error_not_a_panic() {
        let mut buf = Vec::new();
        write_message(&mut buf, b"{not json").unwrap();
        let mut cursor = std::io::Cursor::new(buf);
        let got: Result<Option<serde_json::Value>, _> = read_json(&mut cursor);
        assert!(got.is_err());
    }
}
