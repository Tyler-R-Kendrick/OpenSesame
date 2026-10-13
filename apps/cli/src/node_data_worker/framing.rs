//! Dedicated bounded stdio framing; the browser bridge's smaller cap remains unchanged.
use super::wire::MAX_FRAME_BYTES;
use std::io::{self, Read, Write};
fn invalid() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "invalid Node DATA frame")
}
pub(super) fn read(input: &mut impl Read) -> io::Result<Option<Vec<u8>>> {
    let mut header = [0; 4];
    let mut filled = 0;
    while filled < header.len() {
        match input.read(&mut header[filled..]) {
            Ok(0) if filled == 0 => return Ok(None),
            Ok(0) => return Err(invalid()),
            Ok(count) => filled += count,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error),
        }
    }
    let size = usize::try_from(u32::from_le_bytes(header)).map_err(|_| invalid())?;
    if size == 0 || size > MAX_FRAME_BYTES {
        return Err(invalid());
    }
    let mut bytes = vec![0; size];
    input.read_exact(&mut bytes)?;
    Ok(Some(bytes))
}
pub(super) fn write(output: &mut impl Write, bytes: &[u8]) -> io::Result<()> {
    if bytes.is_empty() || bytes.len() > MAX_FRAME_BYTES {
        return Err(invalid());
    }
    let size = u32::try_from(bytes.len()).map_err(|_| invalid())?;
    output.write_all(&size.to_le_bytes())?;
    output.write_all(bytes)?;
    output.flush()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn truncated_and_oversized_inputs_refuse_before_a_body_allocation() {
        for bytes in [
            vec![1],
            vec![1, 0, 0],
            u32::MAX.to_le_bytes().to_vec(),
            vec![0; 4],
        ] {
            assert!(read(&mut bytes.as_slice()).is_err());
        }
        assert!(read(&mut [2, 0, 0, 0, 1].as_slice()).is_err());
        assert!(read(&mut [].as_slice()).unwrap().is_none());
    }
    #[test]
    fn strict_command_codec_rejects_lease_claims_unknown_fields_and_duplicate_keys() {
        for wire in [
            r#"{"v":1,"op":{"kind":"body","tomb":"a","held":true}}"#,
            r#"{"v":1,"v":1,"op":{"kind":"credential"}}"#,
            r#"{"v":1,"op":{"kind":"read","scope":"root","leaf":"at-rest.key","maximum":32}}"#,
        ] {
            assert!(serde_json::from_str::<super::super::wire::Request>(wire).is_err());
        }
    }
}
