//! Resource limits screened out of a `KDBX` outer header before decryption.
//!
//! A KDBX file names its own KDF parameters, and the reader runs them *before*
//! it can authenticate anything — the key derivation is what produces the key
//! the HMAC is checked with. So a file from an untrusted source can ask the
//! reader to allocate an arbitrary amount of memory and burn an arbitrary
//! amount of CPU, and it costs the attacker a few bytes of header.
//!
//! `keepass` has no API for inspecting the outer header without deriving, so
//! this module walks the KDBX 4 outer header itself — bounds-checked, no
//! allocation, no crypto — and refuses obviously hostile work factors up
//! front. `KeePass`'s own limits are far below these; a real database written by
//! any mainstream client passes.
//!
//! The screen is best effort by design: a header this walker cannot follow is
//! passed through to `keepass`, which rejects it with a proper parse error.
//! It never accepts a file the parser would reject, only refuses some the
//! parser would otherwise spend a gigabyte on.

use crate::KdbxError;

/// Largest `Argon2` memory cost accepted, in bytes. `KeePassXC`'s own maximum is
/// far below this; its default is 64 MiB.
pub const MAX_KDF_MEMORY_BYTES: u64 = 1 << 30;
/// Largest `Argon2` pass count accepted. `KeePass` defaults to single digits.
pub const MAX_KDF_ITERATIONS: u64 = 1 << 12;
/// Largest Argon2 lane count accepted.
pub const MAX_KDF_PARALLELISM: u32 = 64;
/// Largest `AES-KDF` round count accepted. `KeePass` defaults to 60 000.
pub const MAX_AES_KDF_ROUNDS: u64 = 1 << 26;

/// Longest outer header this walker will follow, in bytes. A real KDBX 4
/// header is a few hundred bytes; the cap keeps a malformed one from turning
/// the walk into a scan of the whole file.
const MAX_HEADER_BYTES: usize = 64 * 1024;

const HEADER_END: u8 = 0;
const HEADER_KDF_PARAMS: u8 = 11;

const VD_END: u8 = 0x00;
const VD_U32: u8 = 0x04;
const VD_U64: u8 = 0x05;

/// Reject a KDBX 4 header whose KDF parameters ask for absurd work.
///
/// Files that are not KDBX 4, and headers this walker cannot follow, return
/// `Ok(())` — classification of those is the parser's job.
pub(crate) fn check_kdf_limits(bytes: &[u8]) -> Result<(), KdbxError> {
    let Some(params) = kdf_params(bytes) else {
        return Ok(());
    };

    if let Some(memory) = params.memory {
        if memory > MAX_KDF_MEMORY_BYTES {
            return Err(KdbxError::Malformed(format!(
                "KDF memory cost of {memory} bytes exceeds the {MAX_KDF_MEMORY_BYTES} byte limit"
            )));
        }
    }
    if let Some(iterations) = params.iterations {
        if iterations > MAX_KDF_ITERATIONS {
            return Err(KdbxError::Malformed(format!(
                "KDF iteration count of {iterations} exceeds the {MAX_KDF_ITERATIONS} limit"
            )));
        }
    }
    if let Some(parallelism) = params.parallelism {
        if parallelism > MAX_KDF_PARALLELISM {
            return Err(KdbxError::Malformed(format!(
                "KDF parallelism of {parallelism} exceeds the {MAX_KDF_PARALLELISM} limit"
            )));
        }
    }
    if let Some(rounds) = params.rounds {
        if rounds > MAX_AES_KDF_ROUNDS {
            return Err(KdbxError::Malformed(format!(
                "AES-KDF round count of {rounds} exceeds the {MAX_AES_KDF_ROUNDS} limit"
            )));
        }
    }
    Ok(())
}

#[derive(Debug, Default, PartialEq, Eq)]
struct KdfParams {
    /// Argon2 `M`, in bytes.
    memory: Option<u64>,
    /// Argon2 `I`.
    iterations: Option<u64>,
    /// Argon2 `P`.
    parallelism: Option<u32>,
    /// AES-KDF `R`.
    rounds: Option<u64>,
}

/// A cursor that yields `None` rather than panicking at the end of input.
struct Cursor<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> Cursor<'a> {
    fn new(bytes: &'a [u8], pos: usize) -> Self {
        Self { bytes, pos }
    }

    fn take(&mut self, len: usize) -> Option<&'a [u8]> {
        let end = self.pos.checked_add(len)?;
        let slice = self.bytes.get(self.pos..end)?;
        self.pos = end;
        Some(slice)
    }

    fn u8(&mut self) -> Option<u8> {
        self.take(1).map(|b| b[0])
    }

    fn u16(&mut self) -> Option<u16> {
        let b = self.take(2)?;
        Some(u16::from_le_bytes([b[0], b[1]]))
    }

    fn u32(&mut self) -> Option<u32> {
        let b = self.take(4)?;
        Some(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }
}

/// Walk the KDBX 4 outer header and read the KDF variant dictionary.
fn kdf_params(bytes: &[u8]) -> Option<KdfParams> {
    // 12-byte version header: signature (4), secondary id (4), minor (2),
    // major (2). Only KDBX 4 uses u32 header field lengths.
    let major = {
        let mut cursor = Cursor::new(bytes, 10);
        cursor.u16()?
    };
    if major != 4 {
        return None;
    }

    let mut cursor = Cursor::new(bytes, 12);
    loop {
        if cursor.pos > MAX_HEADER_BYTES {
            return None;
        }
        let id = cursor.u8()?;
        let size = cursor.u32()? as usize;
        if size > MAX_HEADER_BYTES {
            return None;
        }
        let data = cursor.take(size)?;
        if id == HEADER_KDF_PARAMS {
            return variant_dictionary(data);
        }
        if id == HEADER_END {
            return None;
        }
    }
}

/// Read `M`, `I`, `P` and `R` out of a KDF variant dictionary.
fn variant_dictionary(bytes: &[u8]) -> Option<KdfParams> {
    let mut cursor = Cursor::new(bytes, 0);
    let _version = cursor.u16()?;
    let mut params = KdfParams::default();
    loop {
        let value_type = cursor.u8()?;
        if value_type == VD_END {
            return Some(params);
        }
        let name_len = cursor.u32()? as usize;
        let name = cursor.take(name_len)?;
        let value_len = cursor.u32()? as usize;
        let value = cursor.take(value_len)?;

        match (name, value_type) {
            (b"M", VD_U64) => params.memory = read_u64(value),
            (b"I", VD_U64) => params.iterations = read_u64(value),
            (b"P", VD_U32) => params.parallelism = read_u32(value),
            (b"R", VD_U64) => params.rounds = read_u64(value),
            _ => {}
        }
    }
}

fn read_u64(value: &[u8]) -> Option<u64> {
    let bytes: [u8; 8] = value.get(..8)?.try_into().ok()?;
    Some(u64::from_le_bytes(bytes))
}

fn read_u32(value: &[u8]) -> Option<u32> {
    let bytes: [u8; 4] = value.get(..4)?.try_into().ok()?;
    Some(u32::from_le_bytes(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a KDBX 4 header carrying one KDF variant dictionary.
    fn header_with(entries: &[(&[u8], u8, Vec<u8>)]) -> Vec<u8> {
        let mut vd = Vec::new();
        vd.extend_from_slice(&0x0100u16.to_le_bytes());
        for (name, value_type, value) in entries {
            vd.push(*value_type);
            vd.extend_from_slice(
                &u32::try_from(name.len())
                    .expect("fixture name length fits u32")
                    .to_le_bytes(),
            );
            vd.extend_from_slice(name);
            vd.extend_from_slice(
                &u32::try_from(value.len())
                    .expect("fixture value length fits u32")
                    .to_le_bytes(),
            );
            vd.extend_from_slice(value);
        }
        vd.push(VD_END);

        let mut out = vec![0x03, 0xd9, 0xa2, 0x9a];
        out.extend_from_slice(&0xb54b_fb67u32.to_le_bytes()); // secondary id
        out.extend_from_slice(&1u16.to_le_bytes()); // minor
        out.extend_from_slice(&4u16.to_le_bytes()); // major
                                                    // A field the walker must skip over.
        out.push(4);
        out.extend_from_slice(&32u32.to_le_bytes());
        out.extend_from_slice(&[0u8; 32]);
        // The KDF parameters.
        out.push(HEADER_KDF_PARAMS);
        out.extend_from_slice(
            &u32::try_from(vd.len())
                .expect("fixture dictionary length fits u32")
                .to_le_bytes(),
        );
        out.extend_from_slice(&vd);
        // End of header.
        out.push(HEADER_END);
        out.extend_from_slice(&0u32.to_le_bytes());
        out
    }

    fn u64v(value: u64) -> Vec<u8> {
        value.to_le_bytes().to_vec()
    }

    fn u32v(value: u32) -> Vec<u8> {
        value.to_le_bytes().to_vec()
    }

    #[test]
    fn realistic_argon2_parameters_pass() {
        let header = header_with(&[
            (b"M", VD_U64, u64v(64 * 1024 * 1024)),
            (b"I", VD_U64, u64v(2)),
            (b"P", VD_U32, u32v(4)),
        ]);
        assert!(check_kdf_limits(&header).is_ok());
    }

    #[test]
    fn a_terabyte_of_memory_is_refused() {
        let header = header_with(&[(b"M", VD_U64, u64v(1 << 40))]);
        let err = check_kdf_limits(&header).unwrap_err();
        assert!(matches!(err, KdbxError::Malformed(_)), "{err:?}");
        assert!(err.to_string().contains("memory cost"));
    }

    #[test]
    fn an_absurd_iteration_count_is_refused() {
        let header = header_with(&[(b"I", VD_U64, u64v(u64::MAX))]);
        assert!(check_kdf_limits(&header).is_err());
    }

    #[test]
    fn an_absurd_lane_count_is_refused() {
        let header = header_with(&[(b"P", VD_U32, u32v(u32::MAX))]);
        assert!(check_kdf_limits(&header).is_err());
    }

    #[test]
    fn an_absurd_aes_kdf_round_count_is_refused() {
        let header = header_with(&[(b"R", VD_U64, u64v(u64::MAX))]);
        assert!(check_kdf_limits(&header).is_err());
    }

    #[test]
    fn limits_are_inclusive_at_the_boundary() {
        let at = header_with(&[(b"M", VD_U64, u64v(MAX_KDF_MEMORY_BYTES))]);
        assert!(check_kdf_limits(&at).is_ok());
        let over = header_with(&[(b"M", VD_U64, u64v(MAX_KDF_MEMORY_BYTES + 1))]);
        assert!(check_kdf_limits(&over).is_err());
    }

    #[test]
    fn non_kdbx4_input_is_left_to_the_parser() {
        let mut header = header_with(&[(b"M", VD_U64, u64v(1 << 40))]);
        header[10] = 3; // major version 3
        header[11] = 0;
        assert!(check_kdf_limits(&header).is_ok());
    }

    #[test]
    fn truncated_and_malformed_headers_are_left_to_the_parser() {
        let full = header_with(&[(b"M", VD_U64, u64v(1 << 40))]);
        for len in 0..full.len() {
            // Never panics; a header the walker cannot follow is passed on.
            let _ = check_kdf_limits(&full[..len]);
        }
        assert!(check_kdf_limits(&[]).is_ok());
        assert!(check_kdf_limits(&[0xff; 12]).is_ok());
    }

    #[test]
    fn a_header_field_claiming_a_huge_length_does_not_scan_the_file() {
        let mut header = vec![0x03, 0xd9, 0xa2, 0x9a];
        header.extend_from_slice(&0xb54b_fb67u32.to_le_bytes());
        header.extend_from_slice(&1u16.to_le_bytes());
        header.extend_from_slice(&4u16.to_le_bytes());
        header.push(4);
        header.extend_from_slice(&u32::MAX.to_le_bytes());
        header.extend_from_slice(&[0u8; 64]);
        assert!(check_kdf_limits(&header).is_ok());
    }

    #[test]
    fn a_dictionary_with_wrong_value_types_is_ignored() {
        // `M` declared as a u32 is not the Argon2 memory field.
        let header = header_with(&[(b"M", VD_U32, u32v(u32::MAX))]);
        assert!(check_kdf_limits(&header).is_ok());
    }
}
