//! Exact bounded canonical ciphertext codec; no generic plaintext or owner authority.
use super::{refused, wire};
use base64::{engine::general_purpose::STANDARD, Engine};
use std::io;
pub(super) fn bytes_reply(bytes: Option<Vec<u8>>) -> io::Result<wire::Reply> {
    if bytes
        .as_ref()
        .is_some_and(|value| value.len() > wire::MAX_DATA_BYTES)
    {
        return Err(refused());
    }
    Ok(wire::Reply::Bytes {
        base64: bytes.map(|value| STANDARD.encode(value)),
    })
}
// Decode only bounded canonical ciphertext; the genuine private producer authenticates its fixed lane.
pub(super) fn ciphertext_input(value: Option<String>) -> io::Result<Option<Vec<u8>>> {
    let Some(text) = value else {
        return Ok(None);
    };
    if text.len() > 4 * wire::MAX_DATA_BYTES.div_ceil(3) {
        return Err(refused());
    }
    let bytes = STANDARD.decode(&text).map_err(|_| refused())?;
    if bytes.len() > wire::MAX_DATA_BYTES || STANDARD.encode(&bytes) != text {
        return Err(refused());
    }
    Ok(Some(bytes))
}
