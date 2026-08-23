//! Pure mount/path grammar for the Vault KV v2 read facade.
//!
//! Split out of `kv_facade.rs` for one reason: `fuzz/src/lib.rs` declares this
//! same file as a module of its own (`#[path = …] pub mod kv_v2_path`), so the
//! `kv_v2_path` fuzz target exercises *this* parser rather than a copy that
//! could drift from it. That means the file must stay free of every dependency
//! but `std`, so the same bytes compile inside the gateway and inside the fuzz
//! crate.
//!
//! The grammar is deliberately tiny. A KV v2 client may address exactly
//! `{mount}/{family}/{name}` where `mount` is the one served mount, `family`
//! names a view over existing Host storage, and `name` is a connection's
//! logical name. Nothing else parses — in particular nothing containing a
//! path separator, a `..`, or a leading dot — so a resolved path can never
//! address anything outside the caller's own organization's connections.

/// The single KV v2 mount this facade serves — Vault's own default name, so
/// `VAULT_ADDR=<gateway> vault kv get secret/...` works unmodified. Any other
/// mount answers as absent rather than as forbidden.
pub const KV_MOUNT: &str = "secret";

/// Longest KV path accepted before parsing. Vault itself has no such bound;
/// this one keeps a hostile path from becoming an allocation.
pub const MAX_KV_PATH_BYTES: usize = 512;

/// Longest connection logical name accepted. The broker's own limit is lower;
/// this is a parser bound, not a storage one.
pub const MAX_KV_NAME_BYTES: usize = 128;

/// Which view over existing Host storage a KV path addresses.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KvFamily {
    /// `secret/connections/{logical_name}` — the connection's reference-only
    /// view: ConnectionRef, provider, status, configured field *names*.
    Connections,
    /// `secret/materialize/{logical_name}` — a provider-minted, short-lived
    /// derived credential, served only where the connection's materialization
    /// policy is `derived_short_lived` (ADR 0049).
    Materialize,
}

impl KvFamily {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Connections => "connections",
            Self::Materialize => "materialize",
        }
    }
}

/// A parsed, confined KV path.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KvPath {
    pub family: KvFamily,
    pub name: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KvPathError {
    /// A mount this facade does not serve.
    UnknownMount,
    /// Longer than [`MAX_KV_PATH_BYTES`].
    TooLong,
    /// Not exactly two segments, or a segment was empty.
    Malformed,
    /// Two segments, but the first is not a known family.
    UnknownFamily,
    /// The name segment is empty, over-long, or outside the allowed charset.
    InvalidName,
}

impl KvPathError {
    /// The reason string used in a Vault-shaped error body. Deliberately the
    /// same for every variant that could otherwise confirm existence.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::UnknownMount => "unknown_mount",
            Self::TooLong => "path_too_long",
            Self::Malformed => "malformed_path",
            Self::UnknownFamily => "unknown_family",
            Self::InvalidName => "invalid_name",
        }
    }
}

/// Whether one path segment is an acceptable connection logical name.
///
/// ASCII alphanumerics plus `-`, `_`, `.`; never empty, never over-long,
/// never leading-dot, and never containing `..`. The charset alone rules out
/// `/` and `\`, and the `..` rule rules out traversal spelled with dots that
/// a percent-decoder handed us already decoded.
pub fn valid_kv_name(name: &str) -> bool {
    if name.is_empty() || name.len() > MAX_KV_NAME_BYTES {
        return false;
    }
    if name.starts_with('.') || name.contains("..") {
        return false;
    }
    name.bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.')
}

/// Parse `{mount}` + the wildcard tail of a KV v2 route into a confined path.
///
/// `raw` is the already percent-decoded tail the router captured, so this sees
/// `..` and `/` in their decoded form and rejects them here rather than
/// hoping a later layer does.
pub fn parse_kv_path(mount: &str, raw: &str) -> Result<KvPath, KvPathError> {
    if mount != KV_MOUNT {
        return Err(KvPathError::UnknownMount);
    }
    if raw.len() > MAX_KV_PATH_BYTES {
        return Err(KvPathError::TooLong);
    }
    let mut segments = raw.split('/');
    let family = segments.next().unwrap_or("");
    let name = segments.next().unwrap_or("");
    if segments.next().is_some() || family.is_empty() || name.is_empty() {
        return Err(KvPathError::Malformed);
    }
    let family = match family {
        "connections" => KvFamily::Connections,
        "materialize" => KvFamily::Materialize,
        _ => return Err(KvPathError::UnknownFamily),
    };
    if !valid_kv_name(name) {
        return Err(KvPathError::InvalidName);
    }
    let parsed = KvPath {
        family,
        name: name.to_string(),
    };
    // Belt and braces: the charset rules above already make this true, so a
    // future edit that loosens them fails here rather than in production.
    if !kv_path_is_confined(&parsed) {
        return Err(KvPathError::InvalidName);
    }
    Ok(parsed)
}

/// The invariant every accepted path must satisfy: the resolved name is a
/// single, non-traversing storage key. Checked by [`parse_kv_path`] itself, by
/// the unit tests, and by the `kv_v2_path` fuzz target for every input
/// libFuzzer can build.
pub fn kv_path_is_confined(parsed: &KvPath) -> bool {
    let name = parsed.name.as_str();
    !name.is_empty()
        && name.len() <= MAX_KV_NAME_BYTES
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains("..")
        && !name.starts_with('.')
        && !name.contains('\0')
        && valid_kv_name(name)
}
