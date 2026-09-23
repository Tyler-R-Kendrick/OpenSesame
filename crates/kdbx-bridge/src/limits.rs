//! Resource limits screened out of a `KDBX` outer header before decryption.
//!
//! A KDBX file names its own KDF parameters, and the reader runs them *before*
//! it can authenticate anything — the key derivation is what produces the key
//! the HMAC is checked with. So a file from an untrusted source can ask the
//! reader to allocate an arbitrary amount of memory and burn an arbitrary
//! amount of CPU, and it costs the attacker a few bytes of header.
//!
//! `keepass` has no API for inspecting the outer header without deriving, so
//! this module walks the outer header itself — bounds-checked, no allocation,
//! no crypto — and refuses hostile work factors up front. `KeePass`'s own
//! limits are far below these; a real database written by any mainstream
//! client passes.
//!
//! The screen fails **closed**. Every format `keepass` would run a KDF for is
//! walked: KDBX 4 (the `KdfParameters` variant dictionary), KDBX 3 (the
//! `TransformRounds` field) and `KeePass` 1 (`transform_rounds` at a fixed
//! offset). A KDBX 3/4 header this walker cannot finish, a field too short to
//! hold the value the parser will read, or a second `KdfParameters` field
//! (the parser keeps the *last* one) is refused as malformed, never passed on
//! unscreened. Only input with no recognizable version header is left to the
//! parser, which rejects it before any KDF runs.

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
/// Largest total `Argon2` work accepted: memory (bytes) × passes. Each limit
/// above is reasonable alone, but 1 GiB × 4096 passes is not; this caps the
/// product at 16 GiB of memory traffic (1 GiB × 16, or 64 MiB × 256).
pub const MAX_KDF_WORK_BYTES: u64 = 1 << 34;

/// Longest outer header this walker will follow, in bytes. A real header is a
/// few hundred bytes; past this the file is refused rather than scanned.
const MAX_HEADER_BYTES: usize = 1 << 20;

/// Size of the version header every KDBX flavour starts with.
const VERSION_HEADER_BYTES: usize = 12;
const KDBX_SIGNATURE: [u8; 4] = [0x03, 0xd9, 0xa2, 0x9a];
const KEEPASS_1_ID: u32 = 0xb54b_fb65;
const KEEPASS_LATEST_ID: u32 = 0xb54b_fb67;
/// Where `KeePass` 1 keeps its `u32` `transform_rounds`.
const KDB1_ROUNDS_OFFSET: usize = 120;

const HEADER_END: u8 = 0;
/// KDBX 3 `TransformRounds` — a `u64` AES-KDF round count.
const HEADER_TRANSFORM_ROUNDS: u8 = 6;
/// KDBX 4 `KdfParameters` — a variant dictionary.
const HEADER_KDF_PARAMS: u8 = 11;

const VD_END: u8 = 0x00;
const VD_U32: u8 = 0x04;
const VD_U64: u8 = 0x05;

/// Reject a `KeePass` header whose KDF parameters ask for absurd work, or that
/// cannot be screened at all.
pub(crate) fn check_kdf_limits(bytes: &[u8]) -> Result<(), KdbxError> {
    let params = kdf_params(bytes)?;
    over("KDF memory cost", params.memory, MAX_KDF_MEMORY_BYTES)?;
    over("KDF iteration count", params.iterations, MAX_KDF_ITERATIONS)?;
    over(
        "KDF parallelism",
        params.parallelism.map(u64::from),
        u64::from(MAX_KDF_PARALLELISM),
    )?;
    over("AES-KDF round count", params.rounds, MAX_AES_KDF_ROUNDS)?;
    if let (Some(memory), Some(iterations)) = (params.memory, params.iterations) {
        let work = memory.saturating_mul(iterations);
        over(
            "KDF work (memory × iterations)",
            Some(work),
            MAX_KDF_WORK_BYTES,
        )?;
    }
    Ok(())
}

fn over(what: &str, value: Option<u64>, limit: u64) -> Result<(), KdbxError> {
    match value {
        Some(value) if value > limit => Err(KdbxError::Malformed(format!(
            "{what} of {value} exceeds the {limit} limit"
        ))),
        _ => Ok(()),
    }
}

fn malformed(why: &str) -> KdbxError {
    KdbxError::Malformed(format!("KDBX header cannot be screened: {why}"))
}

#[derive(Debug, Default, PartialEq, Eq)]
struct KdfParams {
    /// Argon2 `M`, in bytes.
    memory: Option<u64>,
    /// Argon2 `I`.
    iterations: Option<u64>,
    /// Argon2 `P`.
    parallelism: Option<u32>,
    /// AES-KDF `R` (KDBX 4), `TransformRounds` (KDBX 3) or `KeePass` 1 rounds.
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

/// Dispatch on the version header to the walker for that format.
fn kdf_params(bytes: &[u8]) -> Result<KdfParams, KdbxError> {
    let mut version = Cursor::new(bytes, 0);
    let (Some(signature), Some(secondary)) = (version.take(4), version.u32()) else {
        // Too short to be anything: the parser rejects it before any KDF.
        return Ok(KdfParams::default());
    };
    if signature != KDBX_SIGNATURE {
        return Ok(KdfParams::default());
    }
    if secondary == KEEPASS_1_ID {
        // A header shorter than the fixed `KeePass` 1 layout is refused by the
        // parser before it derives anything.
        let rounds = Cursor::new(bytes, KDB1_ROUNDS_OFFSET).u32().map(u64::from);
        return Ok(KdfParams {
            rounds,
            ..KdfParams::default()
        });
    }
    let (_minor, Some(major)) = (version.u16(), version.u16()) else {
        return Ok(KdfParams::default());
    };
    match (secondary, major) {
        (KEEPASS_LATEST_ID, 3) => walk_kdbx3(bytes),
        (KEEPASS_LATEST_ID, 4) => walk_kdbx4(bytes),
        // KDB2 and unknown versions: the parser refuses them outright.
        _ => Ok(KdfParams::default()),
    }
}

/// Walk KDBX 3 header fields (`u8` id, `u16` length) to the end marker,
/// screening *every* `TransformRounds` field — the parser keeps the last.
fn walk_kdbx3(bytes: &[u8]) -> Result<KdfParams, KdbxError> {
    let mut cursor = Cursor::new(bytes, VERSION_HEADER_BYTES);
    let mut params = KdfParams::default();
    loop {
        if cursor.pos > MAX_HEADER_BYTES {
            return Err(malformed("outer header is too long"));
        }
        let (Some(id), Some(size)) = (cursor.u8(), cursor.u16()) else {
            return Err(malformed("truncated outer header"));
        };
        let data = cursor
            .take(usize::from(size))
            .ok_or_else(|| malformed("truncated outer header field"))?;
        match id {
            HEADER_END => return Ok(params),
            HEADER_TRANSFORM_ROUNDS => {
                let rounds =
                    read_u64(data).ok_or_else(|| malformed("short TransformRounds field"))?;
                params.rounds = Some(params.rounds.map_or(rounds, |seen| seen.max(rounds)));
            }
            _ => {}
        }
    }
}

/// Walk KDBX 4 header fields (`u8` id, `u32` length) to the end marker and
/// read the one KDF variant dictionary.
fn walk_kdbx4(bytes: &[u8]) -> Result<KdfParams, KdbxError> {
    let mut cursor = Cursor::new(bytes, VERSION_HEADER_BYTES);
    let mut params: Option<KdfParams> = None;
    loop {
        if cursor.pos > MAX_HEADER_BYTES {
            return Err(malformed("outer header is too long"));
        }
        let (Some(id), Some(size)) = (cursor.u8(), cursor.u32()) else {
            return Err(malformed("truncated outer header"));
        };
        let size = usize::try_from(size).unwrap_or(usize::MAX);
        if size > MAX_HEADER_BYTES {
            return Err(malformed("outer header field is too long"));
        }
        let data = cursor
            .take(size)
            .ok_or_else(|| malformed("truncated outer header field"))?;
        match id {
            HEADER_END => return Ok(params.unwrap_or_default()),
            HEADER_KDF_PARAMS if params.is_some() => {
                return Err(malformed("more than one KdfParameters field"));
            }
            HEADER_KDF_PARAMS => params = Some(variant_dictionary(data)?),
            _ => {}
        }
    }
}

/// Read `M`, `I`, `P` and `R` out of a KDF variant dictionary. A later entry
/// of the same name and type replaces an earlier one, as in the parser.
fn variant_dictionary(bytes: &[u8]) -> Result<KdfParams, KdbxError> {
    let bad = || malformed("unreadable KdfParameters dictionary");
    let mut cursor = Cursor::new(bytes, 0);
    let _version = cursor.u16().ok_or_else(bad)?;
    let mut params = KdfParams::default();
    loop {
        let value_type = cursor.u8().ok_or_else(bad)?;
        if value_type == VD_END {
            return Ok(params);
        }
        let name_len = cursor.u32().ok_or_else(bad)? as usize;
        let name = cursor.take(name_len).ok_or_else(bad)?;
        let value_len = cursor.u32().ok_or_else(bad)? as usize;
        let value = cursor.take(value_len).ok_or_else(bad)?;

        match (name, value_type) {
            (b"M", VD_U64) => params.memory = Some(read_u64(value).ok_or_else(bad)?),
            (b"I", VD_U64) => params.iterations = Some(read_u64(value).ok_or_else(bad)?),
            (b"P", VD_U32) => params.parallelism = Some(read_u32(value).ok_or_else(bad)?),
            (b"R", VD_U64) => params.rounds = Some(read_u64(value).ok_or_else(bad)?),
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
#[path = "limits_tests.rs"]
mod tests;
