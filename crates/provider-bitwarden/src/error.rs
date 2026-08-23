//! Errors for the Bitwarden/Vaultwarden consume-client.
//!
//! Every variant is *named* and actionable: a human on the CLI must be able to
//! tell a wrong master password from an unsupported cipher format from a
//! refused redirect without reading the source.

/// Result alias for this crate.
pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// The `{type}.{parts}` envelope did not parse: wrong part count, bad
    /// base64, truncated, or empty. Never carries attacker-controlled bytes.
    #[error("malformed EncString: {0}")]
    MalformedEncString(&'static str),

    /// EncString type 7. Bitwarden is mid-migration to COSE
    /// (`CoseEncrypt0` / XChaCha20-Poly1305); a best-effort decode would
    /// silently corrupt data, so this client refuses instead.
    #[error(
        "EncString type 7 (CoseEncrypt0 / XChaCha20-Poly1305) is not supported by the \
         OpenSesame Bitwarden consume-client, which implements types 0 and 2. Bitwarden's \
         COSE migration is tracked as roadmap in ADR 0052 \
         (docs/adr/0052-password-manager-ecosystem-bridging.md). Until it lands, read this \
         item with the `bw` CLI fallback (clear the `native_client` connection config) or \
         re-save the item from a pre-COSE client."
    )]
    CoseEncryptUnsupported,

    /// Types 1, 3, 4, 5 and 6 exist but are deliberately not implemented:
    /// 1 is AES-CBC-128 (retired), 3/4/5/6 are RSA-OAEP/PKCS1 variants used
    /// for organization key wrapping, which this personal-vault client never
    /// unwraps.
    #[error(
        "EncString type {0} is not implemented: types 3-6 wrap organization keys with RSA, \
         which the OpenSesame consume-client does not unwrap (personal vault items only); \
         type 1 (AES-CBC-128) is retired. See ADR 0052."
    )]
    UnsupportedEncStringType(u8),

    /// The `{type}` prefix was not a known EncString type at all.
    #[error("unknown EncString type `{0}`")]
    UnknownEncStringType(String),

    /// Constant-time MAC verification failed. Either the key is wrong or the
    /// ciphertext was tampered with; the two are indistinguishable on purpose.
    #[error("EncString MAC verification failed — wrong key or tampered ciphertext")]
    MacMismatch,

    /// A type-2 EncString was presented to a key with no MAC half, or a
    /// type-0 EncString to a key that has one. Mixing them is how
    /// authentication gets silently dropped.
    #[error("EncString type {enc_type} cannot be opened with this key: {reason}")]
    KeyKindMismatch {
        enc_type: u8,
        reason: &'static str,
    },

    /// AES-CBC unpadding failed after the MAC verified. Structurally this
    /// should not happen; it means the plaintext was not PKCS#7 padded.
    #[error("ciphertext could not be unpadded")]
    Padding,

    /// The decrypted bytes were not valid UTF-8 where a string was expected.
    #[error("decrypted value was not UTF-8")]
    NotUtf8,

    /// A symmetric key was not 32 (enc only) or 64 (enc||mac) bytes.
    #[error("symmetric key must be 32 or 64 bytes, got {0}")]
    InvalidKeyLength(usize),

    /// `prelogin` named a KDF this client does not implement.
    #[error("unsupported KDF type {0} — this client implements PBKDF2-SHA256 (0) and Argon2id (1)")]
    UnsupportedKdf(u32),

    /// KDF parameters outside the band this client is willing to run.
    #[error("invalid KDF parameters: {0}")]
    InvalidKdfParameters(String),

    /// The KDF itself failed (argon2 rejecting parameters, for example).
    #[error("key derivation failed: {0}")]
    KeyDerivation(String),

    /// The configured server URL is not usable as an authority base.
    #[error("server URL: {0}")]
    InvalidServerUrl(String),

    /// A 3xx is a response, never a chase (mirrors `crates/invoke-through`).
    #[error("server responded {status} redirect for {path} — redirects are refused, not followed")]
    RedirectRefused { status: u16, path: String },

    /// Transport failure. May name the host; never a credential.
    #[error("transport error talking to {host}: {message}")]
    Transport { host: String, message: String },

    /// A non-2xx API response.
    #[error("{path} failed with HTTP {status}: {message}")]
    Api {
        path: String,
        status: u16,
        message: String,
    },

    /// The identity endpoint rejected the master password hash.
    #[error("authentication failed: {0}")]
    Authentication(String),

    /// The account has 2FA enabled; this client does not implement the
    /// second-factor exchange.
    #[error(
        "this account requires two-factor authentication, which the OpenSesame consume-client \
         does not implement yet — use the `bw` CLI fallback for it (see ADR 0052)"
    )]
    TwoFactorRequired,

    /// Response body was not the JSON shape this client expects.
    #[error("{path} returned an unexpected response shape: {message}")]
    MalformedResponse { path: String, message: String },

    /// The in-memory session outlived its TTL or the access token expired.
    #[error("session expired — unlock again")]
    SessionExpired,

    /// The requested item is not in the decrypted vault.
    #[error("no vault item matched `{0}`")]
    ItemNotFound(String),

    /// The matched item has no password (a secure note, card, or identity).
    #[error("vault item `{0}` has no login password")]
    NoPassword(String),

    /// More than one item matched a name lookup; ids disambiguate.
    #[error("`{resource}` matched {count} items — use the item id instead")]
    AmbiguousItem { resource: String, count: usize },
}

impl Error {
    /// Stable machine-readable code, for receipts and for tests that assert a
    /// *named* error rather than a message substring.
    pub fn code(&self) -> &'static str {
        match self {
            Error::MalformedEncString(_) => "malformed_enc_string",
            Error::CoseEncryptUnsupported => "cose_encrypt_unsupported",
            Error::UnsupportedEncStringType(_) => "unsupported_enc_string_type",
            Error::UnknownEncStringType(_) => "unknown_enc_string_type",
            Error::MacMismatch => "mac_mismatch",
            Error::KeyKindMismatch { .. } => "key_kind_mismatch",
            Error::Padding => "padding",
            Error::NotUtf8 => "not_utf8",
            Error::InvalidKeyLength(_) => "invalid_key_length",
            Error::UnsupportedKdf(_) => "unsupported_kdf",
            Error::InvalidKdfParameters(_) => "invalid_kdf_parameters",
            Error::KeyDerivation(_) => "key_derivation",
            Error::InvalidServerUrl(_) => "invalid_server_url",
            Error::RedirectRefused { .. } => "redirect_refused",
            Error::Transport { .. } => "transport",
            Error::Api { .. } => "api",
            Error::Authentication(_) => "authentication",
            Error::TwoFactorRequired => "two_factor_required",
            Error::MalformedResponse { .. } => "malformed_response",
            Error::SessionExpired => "session_expired",
            Error::ItemNotFound(_) => "item_not_found",
            Error::NoPassword(_) => "no_password",
            Error::AmbiguousItem { .. } => "ambiguous_item",
        }
    }
}
