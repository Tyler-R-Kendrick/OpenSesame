//! Bitwarden vault cryptography.
//!
//! ```text
//! master password + email (as salt)
//!   ├─ KDF: PBKDF2-SHA256 (default 600_000) OR Argon2id (m/t/p from prelogin)
//!   └─→ Master Key (256-bit)
//!         ├─ PBKDF2-SHA256(payload = MasterKey, salt = masterPassword, 1 iter)
//!         │    → Master Password Hash (base64, sent to the server)
//!         └─ HKDF-SHA256-Expand(MasterKey, info = "enc" | "mac")
//!              → 512-bit Stretched Master Key (32B enc || 32B mac)
//!                └─ AES-256-CBC + HMAC-SHA256 unwraps the 512-bit User Key
//!                     └─ decrypts every vault field (`EncString`)
//! ```
//!
//! Design rules enforced here:
//! * every key lives in a [`secrecy::SecretBox`], is zeroized on drop, and has
//!   no `Debug`/`Serialize` implementation that can print or persist it;
//! * MAC verification is constant time (`hmac`'s `verify_slice`) — never `==`;
//! * `EncString` type 7 (COSE) is refused by name, never best-effort decoded.
//!
//! Derived from the public Bitwarden format description; informed by rbw
//! (MIT, <https://github.com/doy/rbw>) — see `NOTICE`. No AGPL/GPL source.

use std::fmt;
use std::str::FromStr;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use cbc::cipher::block_padding::Pkcs7;
use cbc::cipher::{BlockDecryptMut, BlockEncryptMut, KeyIvInit};
use hmac::{Hmac, Mac};
use secrecy::{ExposeSecret, SecretBox};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::error::{Error, Result};

type Aes256CbcDec = cbc::Decryptor<aes::Aes256>;
type Aes256CbcEnc = cbc::Encryptor<aes::Aes256>;
type HmacSha256 = Hmac<Sha256>;

/// Bitwarden's current `PBKDF2` default (raised from `100_000` in 2023).
pub const DEFAULT_PBKDF2_ITERATIONS: u32 = 600_000;
/// Bitwarden's own server-enforced floor. Anything lower is a downgrade.
pub const MIN_PBKDF2_ITERATIONS: u32 = 5_000;

const AES_BLOCK: usize = 16;
const KEY_LEN: usize = 32;
const MAC_LEN: usize = 32;

/// Key-derivation function named by `POST /identity/accounts/prelogin`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kdf {
    /// `kdf: 0`
    Pbkdf2 { iterations: u32 },
    /// `kdf: 1`
    Argon2id {
        iterations: u32,
        memory_kib: u32,
        parallelism: u32,
    },
}

impl Kdf {
    /// Build from the raw prelogin fields. `kdf_memory` is in **MiB** on the
    /// wire, as Bitwarden's UI presents it.
    ///
    /// # Errors
    ///
    /// Returns [`Error::UnsupportedKdf`] for an unknown KDF or
    /// [`Error::InvalidKdfParameters`] for missing, unsafe, or overflowing
    /// parameters.
    pub fn from_prelogin(
        kdf: u32,
        iterations: u32,
        memory_mebibytes: Option<u32>,
        parallelism: Option<u32>,
    ) -> Result<Self> {
        match kdf {
            0 => {
                if iterations < MIN_PBKDF2_ITERATIONS {
                    return Err(Error::InvalidKdfParameters(format!(
                        "PBKDF2 iterations {iterations} below the {MIN_PBKDF2_ITERATIONS} floor"
                    )));
                }
                Ok(Kdf::Pbkdf2 { iterations })
            }
            1 => {
                let memory_mebibytes = memory_mebibytes.ok_or_else(|| {
                    Error::InvalidKdfParameters("Argon2id requires kdfMemory".into())
                })?;
                let parallelism = parallelism.ok_or_else(|| {
                    Error::InvalidKdfParameters("Argon2id requires kdfParallelism".into())
                })?;
                let memory_kib = memory_mebibytes.checked_mul(1024).ok_or_else(|| {
                    Error::InvalidKdfParameters(format!(
                        "kdfMemory {memory_mebibytes} MiB overflows"
                    ))
                })?;
                Self::argon2id(iterations, memory_kib, parallelism)
            }
            other => Err(Error::UnsupportedKdf(other)),
        }
    }

    /// Argon2id with memory already in KiB (the unit `argon2` wants).
    ///
    /// # Errors
    ///
    /// Returns [`Error::InvalidKdfParameters`] when iterations or parallelism
    /// are zero, or when the memory cost is below Argon2's minimum.
    pub fn argon2id(iterations: u32, memory_kib: u32, parallelism: u32) -> Result<Self> {
        if iterations == 0 || parallelism == 0 {
            return Err(Error::InvalidKdfParameters(
                "Argon2id iterations and parallelism must be non-zero".into(),
            ));
        }
        if memory_kib < 8 * parallelism {
            return Err(Error::InvalidKdfParameters(format!(
                "Argon2id memory {memory_kib} KiB is below the 8×parallelism minimum"
            )));
        }
        Ok(Kdf::Argon2id {
            iterations,
            memory_kib,
            parallelism,
        })
    }
}

impl Default for Kdf {
    fn default() -> Self {
        Kdf::Pbkdf2 {
            iterations: DEFAULT_PBKDF2_ITERATIONS,
        }
    }
}

/// Bitwarden lowercases and trims the email before using it as KDF salt.
/// Getting this wrong derives a key that simply never opens the vault.
#[must_use]
pub fn normalize_email(email: &str) -> String {
    email.trim().to_ascii_lowercase()
}

/// The 256-bit master key. Never `Debug`, never serialized, never on disk.
pub struct MasterKey(SecretBox<[u8; KEY_LEN]>);

impl MasterKey {
    /// master password + email → 256-bit master key.
    ///
    /// # Errors
    ///
    /// Returns [`Error::InvalidKdfParameters`] or [`Error::KeyDerivation`]
    /// when the selected KDF parameters cannot be applied.
    pub fn derive(master_password: &[u8], email: &str, kdf: &Kdf) -> Result<Self> {
        let salt = normalize_email(email);
        let mut out = Zeroizing::new([0u8; KEY_LEN]);
        match *kdf {
            Kdf::Pbkdf2 { iterations } => {
                if iterations == 0 {
                    return Err(Error::InvalidKdfParameters(
                        "PBKDF2 iterations must be non-zero".into(),
                    ));
                }
                pbkdf2::pbkdf2_hmac::<Sha256>(
                    master_password,
                    salt.as_bytes(),
                    iterations,
                    out.as_mut(),
                );
            }
            Kdf::Argon2id {
                iterations,
                memory_kib,
                parallelism,
            } => {
                // Bitwarden salts Argon2id with SHA-256(email), not the email.
                let salt = Sha256::digest(salt.as_bytes());
                let params =
                    argon2::Params::new(memory_kib, iterations, parallelism, Some(KEY_LEN))
                        .map_err(|e| Error::InvalidKdfParameters(e.to_string()))?;
                argon2::Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, params)
                    .hash_password_into(master_password, salt.as_slice(), out.as_mut())
                    .map_err(|e| Error::KeyDerivation(e.to_string()))?;
            }
        }
        Ok(Self(SecretBox::new(Box::new(*out))))
    }

    /// The hash the server sees: PBKDF2-SHA256 over the master **key**, salted
    /// with the master **password**, one iteration, base64. The server never
    /// sees anything that can decrypt the vault.
    #[must_use]
    pub fn password_hash_b64(&self, master_password: &[u8]) -> String {
        let mut out = Zeroizing::new([0u8; KEY_LEN]);
        pbkdf2::pbkdf2_hmac::<Sha256>(
            self.0.expose_secret().as_slice(),
            master_password,
            1,
            out.as_mut(),
        );
        B64.encode(out.as_ref())
    }

    /// HKDF-Expand the master key into the 512-bit stretched master key that
    /// unwraps the user key. The master key is already uniformly random, so
    /// Bitwarden expands without an extract step.
    ///
    /// # Panics
    ///
    /// Panics only if the fixed 32-byte HKDF input or output lengths violate
    /// the `HKDF-SHA256` implementation's documented limits.
    #[must_use]
    pub fn stretch(&self) -> SymmetricKey {
        let hkdf = hkdf::Hkdf::<Sha256>::from_prk(self.0.expose_secret().as_slice())
            .expect("32-byte PRK is always long enough for HKDF-SHA256");
        let mut enc = Zeroizing::new([0u8; KEY_LEN]);
        let mut mac = Zeroizing::new([0u8; MAC_LEN]);
        hkdf.expand(b"enc", enc.as_mut())
            .expect("32-byte expand output is within HKDF limits");
        hkdf.expand(b"mac", mac.as_mut())
            .expect("32-byte expand output is within HKDF limits");
        SymmetricKey {
            enc: SecretBox::new(Box::new(*enc)),
            mac: Some(SecretBox::new(Box::new(*mac))),
        }
    }

    /// Unwrap the account's user key (`profile.key` / token `Key`).
    ///
    /// Modern accounts wrap it as a type-2 `EncString` under the *stretched*
    /// master key. Pre-stretch accounts wrap it as a type-0 `EncString` under
    /// the master key itself; those still exist in the wild, so both are
    /// handled — and the two are never confused, because the envelope type
    /// selects the key.
    ///
    /// # Errors
    ///
    /// Returns a named envelope, integrity, padding, or key-length error when
    /// the wrapped user key cannot be safely decrypted.
    pub fn decrypt_user_key(&self, wrapped: &EncString) -> Result<SymmetricKey> {
        let plaintext = match wrapped.enc_type() {
            EncType::AesCbc256B64 => {
                let legacy = SymmetricKey::from_bytes(self.0.expose_secret().as_slice())?;
                legacy.decrypt(wrapped)?
            }
            EncType::AesCbc256HmacSha256B64 => self.stretch().decrypt(wrapped)?,
        };
        SymmetricKey::from_bytes(&plaintext)
    }

    /// Test/fixture support: build a master key from raw bytes.
    #[must_use]
    pub fn from_bytes(bytes: [u8; KEY_LEN]) -> Self {
        Self(SecretBox::new(Box::new(bytes)))
    }
}

/// A symmetric vault key: 32-byte AES key, plus a 32-byte HMAC key when the
/// key is a modern (type-2 capable) one.
pub struct SymmetricKey {
    enc: SecretBox<[u8; KEY_LEN]>,
    mac: Option<SecretBox<[u8; MAC_LEN]>>,
}

impl SymmetricKey {
    /// 32 bytes → enc only (legacy); 64 bytes → enc || mac.
    ///
    /// # Errors
    ///
    /// Returns [`Error::InvalidKeyLength`] for every other input length.
    pub fn from_bytes(bytes: &[u8]) -> Result<Self> {
        match bytes.len() {
            KEY_LEN => {
                let mut enc = [0u8; KEY_LEN];
                enc.copy_from_slice(bytes);
                Ok(Self {
                    enc: SecretBox::new(Box::new(enc)),
                    mac: None,
                })
            }
            len if len == KEY_LEN + MAC_LEN => {
                let mut enc = [0u8; KEY_LEN];
                let mut mac = [0u8; MAC_LEN];
                enc.copy_from_slice(&bytes[..KEY_LEN]);
                mac.copy_from_slice(&bytes[KEY_LEN..]);
                Ok(Self {
                    enc: SecretBox::new(Box::new(enc)),
                    mac: Some(SecretBox::new(Box::new(mac))),
                })
            }
            other => Err(Error::InvalidKeyLength(other)),
        }
    }

    /// True when this key can authenticate type-2 `EncString` values.
    #[must_use]
    pub fn has_mac(&self) -> bool {
        self.mac.is_some()
    }

    /// Decrypt an `EncString` to raw bytes. Type 2 verifies the MAC in constant
    /// time *before* touching the ciphertext; type 7 is refused by name.
    ///
    /// # Errors
    ///
    /// Returns a named key-kind, integrity, envelope, key-length, or padding
    /// error when the value cannot be safely decrypted.
    pub fn decrypt(&self, value: &EncString) -> Result<Zeroizing<Vec<u8>>> {
        match value.enc_type {
            EncType::AesCbc256B64 => {
                if self.mac.is_some() {
                    return Err(Error::KeyKindMismatch {
                        enc_type: EncType::AesCbc256B64 as u8,
                        reason: "an unauthenticated type-0 EncString must not be opened with an \
                                 authenticated key — that silently drops integrity",
                    });
                }
                self.decrypt_cbc(value)
            }
            EncType::AesCbc256HmacSha256B64 => {
                let mac_key = self.mac.as_ref().ok_or(Error::KeyKindMismatch {
                    enc_type: EncType::AesCbc256HmacSha256B64 as u8,
                    reason: "this key has no MAC half, so the tag cannot be verified",
                })?;
                let expected = value.mac.as_deref().ok_or(Error::MalformedEncString(
                    "type 2 EncString is missing its MAC part",
                ))?;
                let mut hmac = <HmacSha256 as Mac>::new_from_slice(mac_key.expose_secret())
                    .map_err(|_| Error::InvalidKeyLength(MAC_LEN))?;
                hmac.update(&value.iv);
                hmac.update(&value.data);
                // Constant time. Never `==`.
                hmac.verify_slice(expected)
                    .map_err(|_| Error::MacMismatch)?;
                self.decrypt_cbc(value)
            }
        }
    }

    /// Decrypt an `EncString` that is known to hold UTF-8.
    ///
    /// # Errors
    ///
    /// Returns the errors from [`Self::decrypt`], or [`Error::NotUtf8`] when
    /// the authenticated plaintext is not UTF-8.
    pub fn decrypt_string(&self, value: &EncString) -> Result<Zeroizing<String>> {
        let bytes = self.decrypt(value)?;
        let text = std::str::from_utf8(&bytes)
            .map_err(|_| Error::NotUtf8)?
            .to_owned();
        Ok(Zeroizing::new(text))
    }

    fn decrypt_cbc(&self, value: &EncString) -> Result<Zeroizing<Vec<u8>>> {
        if value.iv.len() != AES_BLOCK {
            return Err(Error::MalformedEncString("IV must be 16 bytes"));
        }
        if value.data.is_empty() || value.data.len() % AES_BLOCK != 0 {
            return Err(Error::MalformedEncString(
                "ciphertext must be a non-zero multiple of the AES block size",
            ));
        }
        let cipher = Aes256CbcDec::new_from_slices(self.enc.expose_secret().as_slice(), &value.iv)
            .map_err(|_| Error::InvalidKeyLength(KEY_LEN))?;
        let plaintext = cipher
            .decrypt_padded_vec_mut::<Pkcs7>(&value.data)
            .map_err(|_| Error::Padding)?;
        Ok(Zeroizing::new(plaintext))
    }

    /// Encrypt with a caller-supplied IV. Deterministic on purpose: this is
    /// how the committed crypto vectors and API fixtures are generated. Real
    /// vault writes are out of scope for a consume-client.
    ///
    /// # Errors
    ///
    /// Returns [`Error::InvalidKeyLength`] if the fixed key material cannot be
    /// accepted by the selected cipher or MAC implementation.
    pub fn encrypt_with_iv(&self, plaintext: &[u8], iv: [u8; AES_BLOCK]) -> Result<EncString> {
        let cipher = Aes256CbcEnc::new_from_slices(self.enc.expose_secret().as_slice(), &iv)
            .map_err(|_| Error::InvalidKeyLength(KEY_LEN))?;
        let data = cipher.encrypt_padded_vec_mut::<Pkcs7>(plaintext);
        match self.mac.as_ref() {
            Some(mac_key) => {
                let mut hmac = <HmacSha256 as Mac>::new_from_slice(mac_key.expose_secret())
                    .map_err(|_| Error::InvalidKeyLength(MAC_LEN))?;
                hmac.update(&iv);
                hmac.update(&data);
                Ok(EncString {
                    enc_type: EncType::AesCbc256HmacSha256B64,
                    iv: iv.to_vec(),
                    data,
                    mac: Some(hmac.finalize().into_bytes().to_vec()),
                })
            }
            None => Ok(EncString {
                enc_type: EncType::AesCbc256B64,
                iv: iv.to_vec(),
                data,
                mac: None,
            }),
        }
    }

    /// Test/fixture support: the raw key material, as `enc || mac`.
    /// Deliberately `Zeroizing` and deliberately not a `Display`/`Serialize`.
    #[must_use]
    pub fn to_bytes(&self) -> Zeroizing<Vec<u8>> {
        let mut out = Vec::with_capacity(KEY_LEN + MAC_LEN);
        out.extend_from_slice(self.enc.expose_secret().as_slice());
        if let Some(mac) = self.mac.as_ref() {
            out.extend_from_slice(mac.expose_secret().as_slice());
        }
        Zeroizing::new(out)
    }
}

/// The `EncString` types Bitwarden has minted. Only 0 and 2 are implemented;
/// every other value is refused by name at parse time.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum EncType {
    /// `0.iv|data` — AES-256-CBC, unauthenticated. Legacy.
    AesCbc256B64 = 0,
    /// `2.iv|data|mac` — AES-256-CBC + HMAC-SHA256. The current standard.
    AesCbc256HmacSha256B64 = 2,
}

/// A parsed `{type}.{base64 parts joined by |}` value.
///
/// Parsing is total: every malformed input yields a named error, never a
/// panic. `Display` round-trips the wire form exactly.
#[derive(Clone, PartialEq, Eq)]
pub struct EncString {
    enc_type: EncType,
    iv: Vec<u8>,
    data: Vec<u8>,
    mac: Option<Vec<u8>>,
}

impl EncString {
    /// The envelope type (0 or 2 — everything else fails to parse).
    #[must_use]
    pub fn enc_type(&self) -> EncType {
        self.enc_type
    }

    /// Parse, mapping the empty string to `None` rather than an error. The
    /// Bitwarden API uses `""` and `null` interchangeably for absent fields.
    ///
    /// # Errors
    ///
    /// Returns a named parse error when a nonempty value is not a supported,
    /// structurally valid `EncString`.
    pub fn parse_optional(raw: Option<&str>) -> Result<Option<Self>> {
        match raw.map(str::trim) {
            None | Some("") => Ok(None),
            Some(value) => value.parse().map(Some),
        }
    }
}

impl FromStr for EncString {
    type Err = Error;

    fn from_str(raw: &str) -> Result<Self> {
        let raw = raw.trim();
        if raw.is_empty() {
            return Err(Error::MalformedEncString("empty EncString"));
        }
        let (tag, body) = raw
            .split_once('.')
            .ok_or(Error::MalformedEncString("missing `{type}.` prefix"))?;
        let enc_type = match tag {
            "0" => EncType::AesCbc256B64,
            "2" => EncType::AesCbc256HmacSha256B64,
            "7" => return Err(Error::CoseEncryptUnsupported),
            "1" | "3" | "4" | "5" | "6" => {
                // `tag` is one ASCII digit here, so the parse cannot fail.
                let value = tag.parse::<u8>().unwrap_or(0);
                return Err(Error::UnsupportedEncStringType(value));
            }
            other => return Err(Error::UnknownEncStringType(other.chars().take(8).collect())),
        };
        let mut parts = body.split('|');
        let iv = parts.next().unwrap_or_default();
        let data = parts
            .next()
            .ok_or(Error::MalformedEncString("missing ciphertext part"))?;
        let mac = parts.next();
        if parts.next().is_some() {
            return Err(Error::MalformedEncString("too many `|`-separated parts"));
        }
        match (enc_type, mac) {
            (EncType::AesCbc256B64, Some(_)) => {
                return Err(Error::MalformedEncString("type 0 takes exactly 2 parts"))
            }
            (EncType::AesCbc256HmacSha256B64, None) => {
                return Err(Error::MalformedEncString("type 2 takes exactly 3 parts"))
            }
            _ => {}
        }
        let iv = decode_part(iv, "IV")?;
        let data = decode_part(data, "ciphertext")?;
        let mac = mac.map(|m| decode_part(m, "MAC")).transpose()?;
        if iv.len() != AES_BLOCK {
            return Err(Error::MalformedEncString("IV must be 16 bytes"));
        }
        if data.is_empty() || data.len() % AES_BLOCK != 0 {
            return Err(Error::MalformedEncString(
                "ciphertext must be a non-zero multiple of the AES block size",
            ));
        }
        if let Some(mac) = mac.as_ref() {
            if mac.len() != MAC_LEN {
                return Err(Error::MalformedEncString("MAC must be 32 bytes"));
            }
        }
        Ok(EncString {
            enc_type,
            iv,
            data,
            mac,
        })
    }
}

fn decode_part(raw: &str, what: &'static str) -> Result<Vec<u8>> {
    if raw.is_empty() {
        return Err(match what {
            "IV" => Error::MalformedEncString("empty IV part"),
            "ciphertext" => Error::MalformedEncString("empty ciphertext part"),
            _ => Error::MalformedEncString("empty MAC part"),
        });
    }
    B64.decode(raw).map_err(|_| match what {
        "IV" => Error::MalformedEncString("IV is not base64"),
        "ciphertext" => Error::MalformedEncString("ciphertext is not base64"),
        _ => Error::MalformedEncString("MAC is not base64"),
    })
}

impl fmt::Display for EncString {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{}.{}|{}",
            self.enc_type as u8,
            B64.encode(&self.iv),
            B64.encode(&self.data)
        )?;
        if let Some(mac) = self.mac.as_ref() {
            write!(f, "|{}", B64.encode(mac))?;
        }
        Ok(())
    }
}

/// Ciphertext is not a secret; the key is. Showing the envelope in a debug log
/// is safe and makes malformed-input triage possible.
impl fmt::Debug for EncString {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("EncString")
            .field("type", &(self.enc_type as u8))
            .field("iv_len", &self.iv.len())
            .field("data_len", &self.data.len())
            .field("mac_len", &self.mac.as_ref().map(Vec::len))
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key64() -> SymmetricKey {
        let bytes: Vec<u8> = (0u8..64)
            .map(|i| i.wrapping_mul(7).wrapping_add(3))
            .collect();
        SymmetricKey::from_bytes(&bytes).unwrap()
    }

    fn key32() -> SymmetricKey {
        let bytes: Vec<u8> = (0u8..32)
            .map(|i| i.wrapping_mul(11).wrapping_add(5))
            .collect();
        SymmetricKey::from_bytes(&bytes).unwrap()
    }

    #[test]
    fn normalize_email_trims_and_lowercases() {
        assert_eq!(normalize_email("  User@Example.COM \n"), "user@example.com");
    }

    #[test]
    fn type2_round_trips_and_displays_the_wire_form() {
        let key = key64();
        let enc = key.encrypt_with_iv(b"hunter2", [9u8; 16]).unwrap();
        assert_eq!(enc.enc_type(), EncType::AesCbc256HmacSha256B64);
        let wire = enc.to_string();
        assert!(wire.starts_with("2."), "{wire}");
        assert_eq!(wire.split('|').count(), 3);
        let reparsed: EncString = wire.parse().unwrap();
        assert_eq!(reparsed, enc);
        assert_eq!(&*key.decrypt(&reparsed).unwrap(), b"hunter2");
        assert_eq!(&*key.decrypt_string(&reparsed).unwrap(), "hunter2");
    }

    #[test]
    fn type0_round_trips_under_a_mac_less_key() {
        let key = key32();
        assert!(!key.has_mac());
        let enc = key.encrypt_with_iv(b"legacy", [1u8; 16]).unwrap();
        assert_eq!(enc.enc_type(), EncType::AesCbc256B64);
        let wire = enc.to_string();
        assert!(wire.starts_with("0."), "{wire}");
        assert_eq!(wire.split('|').count(), 2);
        assert_eq!(&*key.decrypt(&wire.parse().unwrap()).unwrap(), b"legacy");
    }

    #[test]
    fn type7_is_refused_by_name_never_best_effort() {
        let error = "7.T0NPU0VOQ1JZUFQwCg==".parse::<EncString>().unwrap_err();
        assert_eq!(error.code(), "cose_encrypt_unsupported");
        assert!(matches!(error, Error::CoseEncryptUnsupported));
        let message = error.to_string();
        assert!(message.contains("type 7"), "{message}");
        assert!(message.contains("ADR 0052"), "{message}");
        assert!(message.contains("bw"), "{message}");
    }

    #[test]
    fn rsa_and_retired_types_are_refused_explicitly() {
        for tag in [1u8, 3, 4, 5, 6] {
            let raw = format!("{tag}.aaaa|bbbb");
            let error = raw.parse::<EncString>().unwrap_err();
            assert_eq!(error.code(), "unsupported_enc_string_type", "type {tag}");
            assert!(matches!(error, Error::UnsupportedEncStringType(t) if t == tag));
        }
    }

    #[test]
    fn unknown_type_tags_are_named_and_bounded() {
        let error = "99999999999999.a|b".parse::<EncString>().unwrap_err();
        assert_eq!(error.code(), "unknown_enc_string_type");
        // The echoed tag is truncated so a hostile server cannot write an
        // arbitrarily long string into an operator's terminal.
        assert!(error.to_string().len() < 64, "{error}");
    }

    /// Table-driven: no malformed `EncString` may panic, and every one of them
    /// must produce a named error rather than a partial parse.
    #[test]
    fn malformed_enc_strings_never_panic() {
        let key = key64();
        let good = key
            .encrypt_with_iv(b"payload", [4u8; 16])
            .unwrap()
            .to_string();
        let (head, tail) = good.split_once('.').unwrap();
        let mut parts = tail.split('|');
        let iv = parts.next().unwrap().to_owned();
        let data = parts.next().unwrap().to_owned();
        let mac = parts.next().unwrap().to_owned();
        assert_eq!(head, "2");

        let cases: Vec<(&str, String)> = vec![
            ("empty", String::new()),
            ("whitespace", "   ".into()),
            ("no dot", "2aaaa|bbbb".into()),
            ("dot only", ".".into()),
            ("type only", "2.".into()),
            ("type 2, one part", format!("2.{iv}")),
            ("type 2, two parts", format!("2.{iv}|{data}")),
            ("type 2, four parts", format!("2.{iv}|{data}|{mac}|{mac}")),
            ("type 0, three parts", format!("0.{iv}|{data}|{mac}")),
            ("empty iv", format!("2.|{data}|{mac}")),
            ("empty data", format!("2.{iv}||{mac}")),
            ("empty mac", format!("2.{iv}|{data}|")),
            ("iv not base64", format!("2.!!!!|{data}|{mac}")),
            ("data not base64", format!("2.{iv}|!!!!|{mac}")),
            ("mac not base64", format!("2.{iv}|{data}|!!!!")),
            (
                "short iv",
                format!("2.{}|{data}|{mac}", B64.encode([0u8; 8])),
            ),
            (
                "long iv",
                format!("2.{}|{data}|{mac}", B64.encode([0u8; 32])),
            ),
            (
                "short mac",
                format!("2.{iv}|{data}|{}", B64.encode([0u8; 16])),
            ),
            (
                "unaligned ciphertext",
                format!("2.{iv}|{}|{mac}", B64.encode([0u8; 17])),
            ),
            (
                "empty ciphertext bytes",
                format!("2.{iv}|{}|{mac}", B64.encode([0u8; 0])),
            ),
            ("truncated wire", good[..good.len() / 2].to_owned()),
            ("negative type", "-1.a|b".into()),
            ("float type", "2.5.a|b".into()),
            ("unicode type", "٢.a|b".into()),
            ("null byte", "2.\0|b|c".into()),
        ];
        for (name, raw) in cases {
            match raw.parse::<EncString>() {
                Ok(parsed) => panic!("`{name}` unexpectedly parsed to {parsed:?}"),
                Err(error) => {
                    // A named error, and never an empty message.
                    assert!(!error.code().is_empty(), "{name}");
                    assert!(!error.to_string().is_empty(), "{name}");
                }
            }
        }
    }

    #[test]
    fn a_tampered_mac_is_rejected_in_constant_time() {
        let key = key64();
        let enc = key.encrypt_with_iv(b"do not tamper", [2u8; 16]).unwrap();
        let wire = enc.to_string();
        let mut parts: Vec<String> = wire[2..].split('|').map(str::to_owned).collect();
        let mut mac = B64.decode(&parts[2]).unwrap();
        mac[0] ^= 0x01;
        parts[2] = B64.encode(&mac);
        let tampered: EncString = format!("2.{}", parts.join("|")).parse().unwrap();
        let error = key.decrypt(&tampered).unwrap_err();
        assert_eq!(error.code(), "mac_mismatch");
    }

    #[test]
    fn tampered_ciphertext_fails_the_mac_before_decryption() {
        let key = key64();
        let enc = key.encrypt_with_iv(b"do not tamper", [3u8; 16]).unwrap();
        let wire = enc.to_string();
        let mut parts: Vec<String> = wire[2..].split('|').map(str::to_owned).collect();
        let mut data = B64.decode(&parts[1]).unwrap();
        data[0] ^= 0xff;
        parts[1] = B64.encode(&data);
        let tampered: EncString = format!("2.{}", parts.join("|")).parse().unwrap();
        assert_eq!(key.decrypt(&tampered).unwrap_err().code(), "mac_mismatch");
    }

    #[test]
    fn a_wrong_key_is_indistinguishable_from_tampering() {
        let enc = key64().encrypt_with_iv(b"secret", [5u8; 16]).unwrap();
        let other: Vec<u8> = (0u8..64).map(|i| i.wrapping_mul(13)).collect();
        let error = SymmetricKey::from_bytes(&other)
            .expect("64 bytes")
            .decrypt(&enc)
            .unwrap_err();
        assert_eq!(error.code(), "mac_mismatch");
    }

    #[test]
    fn key_kinds_are_never_mixed() {
        let authenticated = key64();
        let legacy = key32();
        let type2 = authenticated.encrypt_with_iv(b"x", [6u8; 16]).unwrap();
        let type0 = legacy.encrypt_with_iv(b"x", [6u8; 16]).unwrap();
        assert_eq!(
            legacy.decrypt(&type2).unwrap_err().code(),
            "key_kind_mismatch"
        );
        assert_eq!(
            authenticated.decrypt(&type0).unwrap_err().code(),
            "key_kind_mismatch"
        );
    }

    #[test]
    fn keys_must_be_32_or_64_bytes() {
        for len in [0usize, 1, 16, 31, 33, 63, 65, 128] {
            // `.err()` rather than `.unwrap_err()`: `SymmetricKey` has no
            // `Debug`, so the compiler itself enforces that a key can never be
            // printed by a test helper.
            let error = SymmetricKey::from_bytes(&vec![0u8; len])
                .err()
                .expect("rejected");
            assert!(matches!(error, Error::InvalidKeyLength(l) if l == len));
        }
        assert!(SymmetricKey::from_bytes(&[0u8; 32]).is_ok());
        assert!(SymmetricKey::from_bytes(&[0u8; 64]).is_ok());
    }

    #[test]
    fn non_utf8_plaintext_is_named_not_lossy() {
        let key = key64();
        let enc = key.encrypt_with_iv(&[0xff, 0xfe, 0xfd], [7u8; 16]).unwrap();
        assert_eq!(key.decrypt_string(&enc).unwrap_err().code(), "not_utf8");
        assert_eq!(&*key.decrypt(&enc).unwrap(), &[0xff, 0xfe, 0xfd]);
    }

    #[test]
    fn parse_optional_maps_absent_and_empty_to_none() {
        assert!(EncString::parse_optional(None).unwrap().is_none());
        assert!(EncString::parse_optional(Some("")).unwrap().is_none());
        assert!(EncString::parse_optional(Some("   ")).unwrap().is_none());
        assert_eq!(
            EncString::parse_optional(Some("7.aaaa"))
                .unwrap_err()
                .code(),
            "cose_encrypt_unsupported"
        );
    }

    #[test]
    fn prelogin_kdf_parameters_are_validated() {
        assert_eq!(
            Kdf::from_prelogin(0, 600_000, None, None).unwrap(),
            Kdf::Pbkdf2 {
                iterations: 600_000
            }
        );
        assert_eq!(
            Kdf::from_prelogin(0, 100, None, None).unwrap_err().code(),
            "invalid_kdf_parameters"
        );
        assert_eq!(
            Kdf::from_prelogin(1, 3, Some(64), Some(4)).unwrap(),
            Kdf::Argon2id {
                iterations: 3,
                memory_kib: 64 * 1024,
                parallelism: 4
            }
        );
        assert_eq!(
            Kdf::from_prelogin(1, 3, None, Some(4)).unwrap_err().code(),
            "invalid_kdf_parameters"
        );
        assert_eq!(
            Kdf::from_prelogin(1, 3, Some(64), None).unwrap_err().code(),
            "invalid_kdf_parameters"
        );
        assert_eq!(
            Kdf::from_prelogin(1, 0, Some(64), Some(4))
                .unwrap_err()
                .code(),
            "invalid_kdf_parameters"
        );
        assert_eq!(
            Kdf::from_prelogin(1, 3, Some(u32::MAX), Some(1))
                .unwrap_err()
                .code(),
            "invalid_kdf_parameters"
        );
        assert_eq!(
            Kdf::from_prelogin(9, 3, None, None).unwrap_err().code(),
            "unsupported_kdf"
        );
        assert_eq!(
            Kdf::default(),
            Kdf::Pbkdf2 {
                iterations: DEFAULT_PBKDF2_ITERATIONS
            }
        );
    }

    #[test]
    fn argon2_memory_must_cover_its_lanes() {
        assert_eq!(
            Kdf::argon2id(3, 8, 4).unwrap_err().code(),
            "invalid_kdf_parameters"
        );
        assert!(Kdf::argon2id(3, 32, 4).is_ok());
    }

    #[test]
    fn stretching_is_deterministic_and_splits_enc_from_mac() {
        let master = MasterKey::from_bytes([42u8; 32]);
        let a = master.stretch();
        let b = master.stretch();
        assert_eq!(a.to_bytes().to_vec(), b.to_bytes().to_vec());
        let bytes = a.to_bytes();
        assert_eq!(bytes.len(), 64);
        assert_ne!(&bytes[..32], &bytes[32..], "enc and mac halves must differ");
        assert!(a.has_mac());
    }

    #[test]
    fn a_legacy_type0_user_key_unwraps_under_the_master_key_itself() {
        let master_bytes = [77u8; 32];
        let master = MasterKey::from_bytes(master_bytes);
        // Pre-stretch accounts wrapped the user key with the master key.
        let raw_master = SymmetricKey::from_bytes(&master_bytes).unwrap();
        let user_key_bytes: Vec<u8> = (0u8..64).map(|i| i.wrapping_mul(5)).collect();
        let wrapped = raw_master
            .encrypt_with_iv(&user_key_bytes, [8u8; 16])
            .unwrap();
        assert_eq!(wrapped.enc_type(), EncType::AesCbc256B64);
        let unwrapped = master.decrypt_user_key(&wrapped).unwrap();
        assert_eq!(unwrapped.to_bytes().to_vec(), user_key_bytes);
    }

    #[test]
    fn a_modern_type2_user_key_unwraps_under_the_stretched_key() {
        let master = MasterKey::from_bytes([21u8; 32]);
        let user_key_bytes: Vec<u8> = (0u8..64).map(|i| i.wrapping_add(9)).collect();
        let wrapped = master
            .stretch()
            .encrypt_with_iv(&user_key_bytes, [10u8; 16])
            .unwrap();
        assert_eq!(wrapped.enc_type(), EncType::AesCbc256HmacSha256B64);
        assert_eq!(
            master
                .decrypt_user_key(&wrapped)
                .unwrap()
                .to_bytes()
                .to_vec(),
            user_key_bytes
        );
    }

    #[test]
    fn a_user_key_that_is_not_32_or_64_bytes_is_rejected() {
        let master = MasterKey::from_bytes([1u8; 32]);
        let wrapped = master
            .stretch()
            .encrypt_with_iv(&[0u8; 48], [11u8; 16])
            .unwrap();
        assert_eq!(
            master
                .decrypt_user_key(&wrapped)
                .err()
                .expect("48-byte user key is rejected")
                .code(),
            "invalid_key_length"
        );
    }

    #[test]
    fn debug_of_an_enc_string_shows_shape_not_content() {
        let enc = key64().encrypt_with_iv(b"top secret", [12u8; 16]).unwrap();
        let rendered = format!("{enc:?}");
        assert!(rendered.contains("iv_len: 16"), "{rendered}");
        assert!(!rendered.contains("top secret"), "{rendered}");
    }
}
