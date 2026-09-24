//! The plaintext `VaultHeader` (vault-format-v1 §3, §5) and the `SealedBlob`
//! (§1). The header reveals parameters, never content, and it travels in a
//! file anyone may edit: every number in it is checked before it is used.

use serde_json::{Map, Value};

use super::{
    b64,
    error::{Result, VaultFileError},
};

/// OWASP 2023 floor for PBKDF2-HMAC-SHA-256; the writer's own count.
pub const MIN_PBKDF2_ITERATIONS: u32 = 600_000;
/// Above this, deriving is indistinguishable from a hung process.
pub const MAX_PBKDF2_ITERATIONS: u32 = 10_000_000;
const SALT_BYTES: usize = 16;
const IV_BYTES: usize = 12;
const TAG_BYTES: usize = 16;
/// The one KDF the format names.
const PBKDF2_SHA256: &str = "PBKDF2-SHA256";

const NO_PASSWORD_WRAP: VaultFileError =
    VaultFileError::Corrupt("this vault has no master-password unlock");
const MALFORMED_SEAL: VaultFileError = VaultFileError::Corrupt("a seal is malformed");

/// A JSON number that is an integer, as `Number.isInteger` sees one: `2` and
/// `2.0` both are, `2.5` and `"2"` are not.
pub(super) fn js_integer(value: &Value) -> Option<u64> {
    if let Some(integer) = value.as_u64() {
        return Some(integer);
    }
    let float = value.as_f64()?;
    // 2^53: every integer below it is exact in a JS number.
    let exact = (0.0..9_007_199_254_740_992.0).contains(&float) && float.fract() == 0.0;
    #[expect(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "only used when the range and fraction checks above hold"
    )]
    exact.then_some(float as u64)
}

/// A value that is there: JSON `null` reads as absent, as it does in JS.
fn present(value: Option<&Value>) -> Option<&Value> {
    value.filter(|value| !value.is_null())
}

/// AES-256-GCM with a 12-byte IV and the 128-bit tag appended (§1).
pub(super) struct SealedBlob {
    pub(super) iv: [u8; IV_BYTES],
    pub(super) ct: Vec<u8>,
}

impl SealedBlob {
    pub(super) fn parse(value: &Value) -> Result<Self> {
        let field = |name| {
            value
                .get(name)
                .and_then(Value::as_str)
                .and_then(b64::decode)
        };
        let iv = field("ivB64").ok_or(MALFORMED_SEAL)?;
        let ct = field("ctB64").ok_or(MALFORMED_SEAL)?;
        let iv = <[u8; IV_BYTES]>::try_from(iv).map_err(|_| MALFORMED_SEAL)?;
        if ct.len() < TAG_BYTES {
            return Err(MALFORMED_SEAL);
        }
        Ok(Self { iv, ct })
    }
}

/// KDF parameters that passed §3's validation.
pub(super) struct ValidKdf {
    pub(super) salt: [u8; SALT_BYTES],
    pub(super) iterations: u32,
}

/// `assertKdfParams` (§3): the algorithm, the iteration band and the salt
/// size, checked before any derivation so an edited header cannot weaken the
/// KDF or make the reader hang.
pub(super) fn validate_kdf(kdf: &Value) -> Result<ValidKdf> {
    if kdf.get("alg").and_then(Value::as_str) != Some(PBKDF2_SHA256) {
        return Err(VaultFileError::Corrupt("unsupported key derivation"));
    }
    let iterations = kdf
        .get("iterations")
        .and_then(js_integer)
        .and_then(|count| u32::try_from(count).ok())
        .filter(|count| (MIN_PBKDF2_ITERATIONS..=MAX_PBKDF2_ITERATIONS).contains(count))
        .ok_or(VaultFileError::Corrupt(
            "key derivation parameters were altered",
        ))?;
    let salt = kdf
        .get("saltB64")
        .and_then(Value::as_str)
        .and_then(b64::decode)
        .and_then(|salt| <[u8; SALT_BYTES]>::try_from(salt).ok())
        .ok_or(VaultFileError::Corrupt(
            "key derivation salt is the wrong size",
        ))?;
    Ok(ValidKdf { salt, iterations })
}

/// One passkey PRF wrap (§5). Its PRF output comes from the authenticator
/// that enrolled it; this reader never asks for one.
pub struct PasskeyRecord {
    credential_id_b64: String,
    pub(super) prf_salt: Vec<u8>,
    pub(super) wrap: SealedBlob,
}

impl PasskeyRecord {
    fn parse(value: &Value) -> Result<Self> {
        const MALFORMED: VaultFileError = VaultFileError::Corrupt("a passkey unlock is malformed");
        let text = |name| value.get(name).and_then(Value::as_str);
        let credential_id_b64 = text("credentialIdB64").ok_or(MALFORMED)?.to_owned();
        let prf_salt = text("prfSaltB64").and_then(b64::decode).ok_or(MALFORMED)?;
        let wrap = SealedBlob::parse(present(value.get("wrap")).ok_or(MALFORMED)?)?;
        Ok(Self {
            credential_id_b64,
            prf_salt,
            wrap,
        })
    }

    /// The credential this wrap belongs to (public, as in the header).
    #[must_use]
    pub fn credential_id_b64(&self) -> &str {
        &self.credential_id_b64
    }
}

/// The plaintext header of a Pages vault.
#[derive(Clone)]
pub struct VaultHeader {
    kdf: Option<Value>,
    wrap: Option<Value>,
    unlocks: Map<String, Value>,
    body_rev: Option<u64>,
}

impl VaultHeader {
    /// §3: `v` is 1, `bodyRev` is an integer when present, and at least one
    /// of `wrap`, `unlocks.passkey(s)` or `unlocks.pin` exists.
    pub(super) fn parse(value: &Value) -> Result<Self> {
        let object = value
            .as_object()
            .ok_or(VaultFileError::Corrupt("the header is not an object"))?;
        if object.get("v").and_then(Value::as_f64) != Some(1.0) {
            return Err(VaultFileError::Corrupt("unsupported vault format"));
        }
        let body_rev = match present(object.get("bodyRev")) {
            None => None,
            Some(rev) => Some(js_integer(rev).ok_or(VaultFileError::Corrupt(
                "the header's body revision is malformed",
            ))?),
        };
        let unlocks = match present(object.get("unlocks")) {
            None => Map::new(),
            Some(Value::Object(unlocks)) => unlocks.clone(),
            Some(_) => {
                return Err(VaultFileError::Corrupt(
                    "the header's unlock records are malformed",
                ))
            }
        };
        let header = Self {
            kdf: present(object.get("kdf")).cloned(),
            wrap: present(object.get("wrap")).cloned(),
            unlocks,
            body_rev,
        };
        let passkeys = header
            .unlocks
            .get("passkeys")
            .and_then(Value::as_array)
            .is_some_and(|rows| !rows.is_empty());
        let any = header.wrap.is_some()
            || header.has_pin()
            || passkeys
            || present(header.unlocks.get("passkey")).is_some();
        if !any {
            return Err(VaultFileError::Corrupt("this vault has no unlock"));
        }
        Ok(header)
    }

    /// A portable master-password wrap: both `kdf` and `wrap` (§4).
    #[must_use]
    pub fn has_password_wrap(&self) -> bool {
        self.kdf.is_some() && self.wrap.is_some()
    }

    /// A PIN wrap, which belongs to the device that enrolled it (§5).
    #[must_use]
    pub fn has_pin(&self) -> bool {
        present(self.unlocks.get("pin")).is_some()
    }

    /// The highest body revision the writer recorded (§3).
    #[must_use]
    pub fn body_rev(&self) -> Option<u64> {
        self.body_rev
    }

    /// The password wrap and its validated KDF, before any derivation.
    pub(super) fn password_wrap(&self) -> Result<(ValidKdf, SealedBlob)> {
        let (Some(kdf), Some(wrap)) = (&self.kdf, &self.wrap) else {
            return Err(NO_PASSWORD_WRAP);
        };
        if kdf.get("alg").and_then(Value::as_str) != Some(PBKDF2_SHA256) {
            return Err(NO_PASSWORD_WRAP);
        }
        Ok((validate_kdf(kdf)?, SealedBlob::parse(wrap)?))
    }

    /// The PIN wrap and its validated KDF, before any derivation.
    pub(super) fn pin_wrap(&self) -> Result<(ValidKdf, SealedBlob)> {
        let pin = present(self.unlocks.get("pin"))
            .ok_or(VaultFileError::Corrupt("this vault has no PIN unlock"))?;
        let kdf = present(pin.get("kdf"))
            .ok_or(VaultFileError::Corrupt("unsupported PIN unlock format"))?;
        if kdf.get("alg").and_then(Value::as_str) != Some(PBKDF2_SHA256) {
            return Err(VaultFileError::Corrupt("unsupported PIN unlock format"));
        }
        let wrap = present(pin.get("wrap")).ok_or(MALFORMED_SEAL)?;
        Ok((validate_kdf(kdf)?, SealedBlob::parse(wrap)?))
    }

    /// The passkey wraps as `listPasskeyUnlockRecords` reads them (§5): the
    /// `passkeys` list, with a lone legacy `passkey` prepended when its
    /// credential is not already listed.
    ///
    /// # Errors
    ///
    /// `Corrupt` when a record is malformed.
    pub fn passkey_records(&self) -> Result<Vec<PasskeyRecord>> {
        let mut records = match present(self.unlocks.get("passkeys")) {
            None => Vec::new(),
            Some(Value::Array(rows)) => rows
                .iter()
                .map(PasskeyRecord::parse)
                .collect::<Result<_>>()?,
            Some(_) => return Err(VaultFileError::Corrupt("a passkey unlock is malformed")),
        };
        let Some(legacy) = present(self.unlocks.get("passkey")) else {
            return Ok(records);
        };
        let legacy = PasskeyRecord::parse(legacy)?;
        if !records
            .iter()
            .any(|row| row.credential_id_b64 == legacy.credential_id_b64)
        {
            records.insert(0, legacy);
        }
        Ok(records)
    }
}
