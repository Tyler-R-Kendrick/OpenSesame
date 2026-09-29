//! The frames the hub sends, in ASP.NET `SignalR`'s `MessagePack` hub protocol:
//! each message is a `MessagePack` array behind a variable-length size prefix.
//! Only the handful of `MessagePack` forms these frames use are written here.

use chrono::{DateTime, Utc};

/// Bitwarden's `PushType`: what changed, so a client knows what to fetch.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Update {
    /// Something in the vault changed; sync it.
    SyncVault = 5,
    /// The account's security stamp changed; sign out.
    LogOut = 11,
    /// A new device asks to sign in; show the approval prompt.
    AuthRequest = 15,
    /// A device's request was answered.
    AuthRequestResponse = 16,
}

/// The handshake reply: an empty JSON object and the record separator.
pub const HANDSHAKE_REPLY: [u8; 3] = [b'{', b'}', 0x1e];

/// A `MessagePack` value, as far as the frames need.
enum Pack<'a> {
    Nil,
    Int(i64),
    Str(&'a str),
    Time(DateTime<Utc>),
    Array(Vec<Pack<'a>>),
    Map(Vec<(&'a str, Pack<'a>)>),
}

fn write_len(out: &mut Vec<u8>, len: usize, fix: u8, fix_max: usize, markers: [u8; 2]) {
    if len <= fix_max {
        out.push(fix | u8::try_from(len).unwrap_or(0));
    } else if let Ok(len) = u16::try_from(len) {
        out.push(markers[0]);
        out.extend_from_slice(&len.to_be_bytes());
    } else {
        out.push(markers[1]);
        out.extend_from_slice(&u32::try_from(len).unwrap_or(u32::MAX).to_be_bytes());
    }
}

fn write(out: &mut Vec<u8>, value: &Pack<'_>) {
    match value {
        Pack::Nil => out.push(0xc0),
        Pack::Int(n) => match u8::try_from(*n) {
            Ok(small) if small < 0x80 => out.push(small),
            _ => {
                out.push(0xd3);
                out.extend_from_slice(&n.to_be_bytes());
            }
        },
        Pack::Str(s) => {
            if s.len() < 32 {
                out.push(0xa0 | u8::try_from(s.len()).unwrap_or(0));
            } else {
                write_len(out, s.len(), 0xd9, 0, [0xda, 0xdb]);
            }
            out.extend_from_slice(s.as_bytes());
        }
        // The timestamp extension (type -1), 64-bit form: 30 bits of
        // nanoseconds above 34 bits of seconds.
        Pack::Time(at) => {
            let nanos = u64::from(at.timestamp_subsec_nanos());
            let seconds = u64::try_from(at.timestamp()).unwrap_or(0) & 0x3_ffff_ffff;
            out.extend_from_slice(&[0xd7, 0xff]);
            out.extend_from_slice(&((nanos << 34) | seconds).to_be_bytes());
        }
        Pack::Array(items) => {
            write_len(out, items.len(), 0x90, 15, [0xdc, 0xdd]);
            for item in items {
                write(out, item);
            }
        }
        Pack::Map(entries) => {
            write_len(out, entries.len(), 0x80, 15, [0xde, 0xdf]);
            for (key, item) in entries {
                write(out, &Pack::Str(key));
                write(out, item);
            }
        }
    }
}

/// A message behind `SignalR`'s size prefix: seven bits per byte, low first.
fn framed(message: &Pack<'_>) -> Vec<u8> {
    let mut body = Vec::new();
    write(&mut body, message);
    let mut out = Vec::with_capacity(body.len() + 5);
    let mut size = body.len();
    loop {
        let low = u8::try_from(size & 0x7f).unwrap_or(0);
        size >>= 7;
        out.push(if size > 0 { low | 0x80 } else { low });
        if size == 0 {
            break;
        }
    }
    out.extend_from_slice(&body);
    out
}

/// An invocation of the client's `ReceiveMessage` with one update for
/// `user_id`: `[1, {}, nil, "ReceiveMessage", [{ContextId, Type, Payload}]]`.
#[must_use]
pub fn update(kind: Update, user_id: &str, at: DateTime<Utc>) -> Vec<u8> {
    framed(&Pack::Array(vec![
        Pack::Int(1),
        Pack::Map(Vec::new()),
        Pack::Nil,
        Pack::Str("ReceiveMessage"),
        Pack::Array(vec![Pack::Map(vec![
            ("ContextId", Pack::Nil),
            ("Type", Pack::Int(kind as i64)),
            (
                "Payload",
                Pack::Map(vec![
                    ("UserId", Pack::Str(user_id)),
                    ("Date", Pack::Time(at)),
                ]),
            ),
        ])]),
    ]))
}

/// An update about a sign-in request: `Payload` is `{Id, UserId}`.
#[must_use]
pub fn request_update(kind: Update, user_id: &str, request_id: &str) -> Vec<u8> {
    framed(&Pack::Array(vec![
        Pack::Int(1),
        Pack::Map(Vec::new()),
        Pack::Nil,
        Pack::Str("ReceiveMessage"),
        Pack::Array(vec![Pack::Map(vec![
            ("ContextId", Pack::Nil),
            ("Type", Pack::Int(kind as i64)),
            (
                "Payload",
                Pack::Map(vec![
                    ("Id", Pack::Str(request_id)),
                    ("UserId", Pack::Str(user_id)),
                ]),
            ),
        ])]),
    ]))
}

/// What the asking device hears on the anonymous hub when its request is
/// answered. The method name is misspelled as Bitwarden's own server and
/// clients spell it.
#[must_use]
pub fn anonymous_response(user_id: &str, request_id: &str) -> Vec<u8> {
    framed(&Pack::Array(vec![
        Pack::Int(1),
        Pack::Map(Vec::new()),
        Pack::Nil,
        Pack::Str("AuthRequestResponseRecieved"),
        Pack::Array(vec![Pack::Map(vec![
            ("Type", Pack::Int(Update::AuthRequestResponse as i64)),
            (
                "Payload",
                Pack::Map(vec![
                    ("Id", Pack::Str(request_id)),
                    ("UserId", Pack::Str(user_id)),
                ]),
            ),
            ("UserId", Pack::Str(user_id)),
        ])]),
    ]))
}

/// A `SignalR` ping: `[6]`.
#[must_use]
pub fn ping() -> Vec<u8> {
    framed(&Pack::Array(vec![Pack::Int(6)]))
}

/// Whether a text frame is the `MessagePack` handshake a client opens with.
#[must_use]
pub fn is_handshake(text: &str) -> bool {
    let body = text.trim_end_matches('\u{1e}');
    serde_json::from_str::<serde_json::Value>(body).is_ok_and(|v| {
        v.get("protocol").and_then(serde_json::Value::as_str) == Some("messagepack")
            && v.get("version").and_then(serde_json::Value::as_i64) == Some(1)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone as _;

    #[test]
    fn a_ping_is_a_prefixed_one_element_array() {
        assert_eq!(ping(), vec![0x02, 0x91, 0x06]);
    }

    #[test]
    fn an_update_frames_the_invocation_bitwarden_clients_read() {
        let at = Utc.with_ymd_and_hms(2026, 9, 28, 12, 0, 0).unwrap();
        let frame = update(Update::SyncVault, "u1", at);
        let body = &frame[1..];
        assert_eq!(usize::from(frame[0]), body.len());
        assert_eq!(&body[..3], &[0x95, 0x01, 0x80]);
        assert_eq!(body[3], 0xc0);
        assert_eq!(&body[4..19], b"\xaeReceiveMessage");
        let tail = &body[body.len() - 10..];
        assert_eq!(&tail[..2], &[0xd7, 0xff]);
        let stamp = u64::from_be_bytes(tail[2..].try_into().unwrap());
        assert_eq!(
            stamp & 0x3_ffff_ffff,
            u64::try_from(at.timestamp()).unwrap()
        );
    }

    #[test]
    fn only_the_messagepack_handshake_is_accepted() {
        assert!(is_handshake(
            "{\"protocol\":\"messagepack\",\"version\":1}\u{1e}"
        ));
        assert!(!is_handshake("{\"protocol\":\"json\",\"version\":1}\u{1e}"));
    }
}
