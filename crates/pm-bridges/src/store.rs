//! The single door every bridge uses onto the sealed store.
//!
//! Bridges never touch `sealed_store` types directly: they go through
//! [`StoreAccess`], so root resolution, unlocking, locking, and the URL→entry
//! search behave identically no matter which foreign protocol asked.
//!
//! The search predicates ([`host_of`], [`trailer_urls`], [`host_matches`],
//! [`name_matches`]) are deliberately pure and free of I/O — they are the
//! part with branching logic worth testing exhaustively, and they are what
//! two different bridges (browserpass and keepassxc) share.

use std::fmt::Write as _;
use std::path::{Path, PathBuf};

use opensesame_sealed_store::{
    resolve_store_dir, totp_code, unlock_store_key, Entry, ItemDataKey, StoreRoot,
};
use zeroize::Zeroize;

use crate::BridgeError;

/// Env var carrying the sealed-store passphrase for a non-interactive bridge.
///
/// A native-messaging host has no TTY — the browser owns its stdio — so the
/// passphrase must arrive out of band. This mirrors `apps/cli`'s own
/// `OPENSESAME_STORE_PASSWORD` escape hatch and is documented as such: it is
/// a human/device-plane convenience, never an agent affordance.
pub const ENV_STORE_PASSWORD: &str = "OPENSESAME_STORE_PASSWORD";

/// Optional explicit store root for a bridge, overriding the usual
/// `OPENSESAME_STORE_DIR` / `PASSWORD_STORE_DIR` / `~/.password-store` chain.
pub const ENV_BRIDGE_STORE_DIR: &str = "OPENSESAME_BRIDGE_STORE_DIR";

/// Upper bound on entries decrypted to answer one URL query.
///
/// A `url:` trailer match requires opening entries, so an unbounded store
/// would turn one autofill into unbounded work. Past this many entries the
/// search degrades to the (cheap, name-only) heuristic pass.
pub const MAX_SEARCH_ENTRIES: usize = 4096;

/// A store entry that answered a query, with its logical path.
#[derive(Debug, Clone)]
pub struct StoreMatch {
    pub name: String,
    pub entry: Entry,
}

impl StoreMatch {
    /// Best-effort login for the entry: an explicit trailer field, else the
    /// last path segment (the `pass`/gopass convention).
    #[must_use]
    pub fn login(&self) -> String {
        trailer_value(&self.entry.trailer, &["login", "username", "user"])
            .unwrap_or_else(|| self.name.rsplit('/').next().unwrap_or("").to_string())
    }
}

/// Root resolution for bridges.
///
/// TODO(dedupe): `apps/cli/src/store.rs::resolve_root` does the same job with
/// tomb-registry support layered on. Lifting the shared half into
/// `crates/sealed-store` is the right end state (§4.4); it is duplicated
/// minimally here so the two agents building on it do not collide in that
/// crate. Bridges deliberately do **not** consult the tomb registry: a
/// browser-launched host must not silently follow an "active tomb" the human
/// switched in another terminal.
#[must_use]
pub fn resolve_root(explicit: Option<PathBuf>) -> PathBuf {
    if let Some(path) = explicit {
        return path;
    }
    if let Some(dir) = std::env::var_os(ENV_BRIDGE_STORE_DIR).filter(|v| !v.is_empty()) {
        return PathBuf::from(dir);
    }
    resolve_store_dir()
}

/// An opened (and possibly unlocked) sealed store.
pub struct StoreAccess {
    root_path: PathBuf,
    root: StoreRoot,
    key: ItemDataKey,
    locked: bool,
}

impl StoreAccess {
    /// Open `root_path`, unlocking with `passphrase` when the store carries an
    /// `.opensesame-key`. GPG/age-format stores need no passphrase here (the
    /// agent behind `gpg`/`age` supplies it), so `passphrase` may be `None`.
    ///
    /// # Errors
    ///
    /// Returns an error when the store cannot be opened or its key cannot be unlocked.
    pub fn open(root_path: &Path, passphrase: Option<&[u8]>) -> Result<Self, BridgeError> {
        let root = StoreRoot::open(root_path)?;
        let keyed = root_path.join(".opensesame-key").exists();
        let key = if keyed {
            let passphrase = passphrase.ok_or(BridgeError::Unconfigured(ENV_STORE_PASSWORD))?;
            unlock_store_key(root_path, passphrase)?
        } else {
            // GPG/age stores route decryption through their own agent; the
            // item key is never consulted on that path.
            ItemDataKey([0u8; 32])
        };
        Ok(Self {
            root_path: root_path.to_path_buf(),
            root,
            key,
            locked: false,
        })
    }

    /// Open the store a bridge should use, taking the passphrase from
    /// [`ENV_STORE_PASSWORD`] and clearing it from this process's memory.
    ///
    /// # Errors
    ///
    /// Returns the same errors as [`Self::open`].
    pub fn from_env(explicit: Option<PathBuf>) -> Result<Self, BridgeError> {
        let root_path = resolve_root(explicit);
        let mut password = std::env::var(ENV_STORE_PASSWORD)
            .ok()
            .filter(|p| !p.is_empty());
        let access = Self::open(&root_path, password.as_deref().map(str::as_bytes));
        if let Some(p) = password.as_mut() {
            p.zeroize();
        }
        access
    }

    #[must_use]
    pub fn root_path(&self) -> &Path {
        &self.root_path
    }

    /// Whether the store has been locked by a client (`lock-database`).
    #[must_use]
    pub fn is_locked(&self) -> bool {
        self.locked
    }

    /// Drop the item key and refuse further reads until the process restarts.
    /// There is deliberately no in-process unlock: re-entering the passphrase
    /// is a human act on a TTY, which a native-messaging host does not have.
    pub fn lock(&mut self) {
        self.key.0.zeroize();
        self.locked = true;
    }

    fn key(&self) -> Result<&ItemDataKey, BridgeError> {
        if self.locked {
            return Err(BridgeError::Locked);
        }
        Ok(&self.key)
    }

    /// Logical entry names under `prefix` (`""` for the whole store).
    ///
    /// # Errors
    ///
    /// Returns an error when the store cannot list the requested prefix.
    pub fn list(&self, prefix: &str) -> Result<Vec<String>, BridgeError> {
        Ok(self.root.ls(prefix)?)
    }

    /// Decrypt one entry by logical name.
    ///
    /// # Errors
    ///
    /// Returns an error when the store is locked or the entry cannot be read.
    pub fn show(&self, name: &str) -> Result<Entry, BridgeError> {
        Ok(self.root.show(name, self.key()?)?)
    }

    /// Insert or overwrite one entry.
    ///
    /// # Errors
    ///
    /// Returns an error when the store is locked or the entry cannot be written.
    pub fn put(&self, name: &str, entry: &Entry) -> Result<(), BridgeError> {
        Ok(self.root.insert_or_replace(name, entry, self.key()?)?)
    }

    /// Current TOTP for an entry that carries an `otpauth://` trailer line.
    ///
    /// # Errors
    ///
    /// Returns an error when the entry cannot be read or has no valid TOTP configuration.
    pub fn totp(&self, name: &str, at_unix: u64) -> Result<String, BridgeError> {
        let entry = self.show(name)?;
        let otp = entry
            .otp
            .ok_or_else(|| BridgeError::Store("entry has no otpauth:// trailer".into()))?;
        totp_code(&otp, at_unix).map_err(|e| BridgeError::Store(e.to_string()))
    }

    /// A stable, non-secret identifier for this store, used where a foreign
    /// protocol expects a "database hash".
    ///
    /// It is the SHA-256 of the canonical root path — a public fact about
    /// *which* store is bridged, never a function of any entry's contents.
    #[must_use]
    pub fn database_hash(&self) -> String {
        use sha2::{Digest, Sha256};
        let canonical = std::fs::canonicalize(&self.root_path).unwrap_or(self.root_path.clone());
        let mut hasher = Sha256::new();
        hasher.update(b"opensesame-sealed-store\0");
        hasher.update(canonical.to_string_lossy().as_bytes());
        hex(&hasher.finalize())
    }

    /// Find entries matching `url`.
    ///
    /// Pass 1 opens entries and matches a `url:`/`uri:`/`website:` trailer
    /// line against the query host. Only if that finds nothing does pass 2
    /// fall back to path-name heuristics — an explicit trailer is always a
    /// stronger signal than a filename that happens to look like a domain, so
    /// an entry that carries one is never handed out on its name alone.
    ///
    /// # Errors
    ///
    /// Returns an error for an invalid URL, locked store, or failed listing.
    pub fn find_by_url(&self, url: &str) -> Result<Vec<StoreMatch>, BridgeError> {
        // Check the lock up front. Without this a locked store would look
        // like an *empty* one — every per-entry decrypt failing quietly and
        // the caller told "no matches" instead of "locked".
        self.key()?;
        let host = host_of(url).ok_or_else(|| BridgeError::Protocol("no host in url".into()))?;
        let names = self.list("")?;

        let matches = self.find_trailer_matches(&names, &host);
        if !matches.is_empty() {
            return Ok(matches);
        }

        Ok(self.find_name_matches(&names, &host))
    }

    fn find_trailer_matches(&self, names: &[String], host: &str) -> Vec<StoreMatch> {
        if names.len() > MAX_SEARCH_ENTRIES {
            return Vec::new();
        }
        names
            .iter()
            .filter_map(|name| {
                let entry = self.show(name).ok()?;
                entry_matches_host(&entry, host).then(|| StoreMatch {
                    name: name.clone(),
                    entry,
                })
            })
            .collect()
    }

    fn find_name_matches(&self, names: &[String], host: &str) -> Vec<StoreMatch> {
        names
            .iter()
            .filter(|name| name_matches(name, host))
            .filter_map(|name| {
                let entry = self.show(name).ok()?;
                name_fallback_admits(&entry, host).then(|| StoreMatch {
                    name: name.clone(),
                    entry,
                })
            })
            .collect()
    }
}

/// May the name heuristic hand `entry` to `host`? Only when the entry names
/// no URL of its own, or one of its URLs really serves `host`: an explicit
/// `url: https://github.com` is never overridden by a path that happens to
/// look like `github.lol`.
#[must_use]
pub fn name_fallback_admits(entry: &Entry, host: &str) -> bool {
    trailer_urls(&entry.trailer).is_empty() || entry_matches_host(entry, host)
}

fn entry_matches_host(entry: &Entry, host: &str) -> bool {
    trailer_urls(&entry.trailer)
        .iter()
        .filter_map(|url| host_of(url))
        .any(|candidate| host_matches(&candidate, host))
}

fn hex(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        write!(output, "{byte:02x}").expect("writing to a String cannot fail");
    }
    output
}

/// A stable, non-secret opaque id for an entry, used where a foreign protocol
/// addresses entries by UUID. Derived from the logical path only.
#[must_use]
pub fn entry_uuid(name: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(b"opensesame-entry\0");
    hasher.update(name.as_bytes());
    hex(&hasher.finalize()[..16])
}

/// Read a `key: value` trailer field, first match wins, case-insensitive key.
#[must_use]
pub fn trailer_value(trailer: &str, keys: &[&str]) -> Option<String> {
    for line in trailer.lines() {
        let Some((raw_key, value)) = line.split_once(':') else {
            continue;
        };
        let raw_key = raw_key.trim().to_ascii_lowercase();
        if keys.iter().any(|k| *k == raw_key) {
            let value = value.trim();
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }
    None
}

/// Every URL-ish trailer line, in file order.
#[must_use]
pub fn trailer_urls(trailer: &str) -> Vec<String> {
    const KEYS: [&str; 5] = ["url", "uri", "website", "site", "location"];
    let mut out = Vec::new();
    for line in trailer.lines() {
        let Some((raw_key, value)) = line.split_once(':') else {
            continue;
        };
        let key = raw_key.trim().to_ascii_lowercase();
        if KEYS.contains(&key.as_str()) {
            let value = value.trim();
            if !value.is_empty() {
                out.push(value.to_string());
            }
        }
    }
    out
}

/// Extract a lowercase host from a URL, a bare authority, or a bare hostname.
///
/// Hand-rolled rather than pulling the `url` crate in: the bridges need a
/// host and nothing else, and the dependency budget argument for this crate
/// is that its dep set stays small and auditable.
#[must_use]
pub fn host_of(url: &str) -> Option<String> {
    let raw = url.trim();
    if raw.is_empty() {
        return None;
    }
    // Drop the scheme, if any.
    let rest = match raw.find("://") {
        Some(idx) => &raw[idx + 3..],
        None => raw,
    };
    // Authority ends at the first path/query/fragment separator.
    let authority = rest
        .split(['/', '?', '#'])
        .next()
        .filter(|s| !s.is_empty())?;
    // Strip userinfo.
    let authority = match authority.rsplit_once('@') {
        Some((_, host)) => host,
        None => authority,
    };
    // IPv6 literals keep their brackets; everything else drops a :port.
    let host = if let Some(stripped) = authority.strip_prefix('[') {
        stripped.split(']').next()?
    } else {
        authority.split(':').next()?
    };
    let host = host.trim().trim_end_matches('.');
    if host.is_empty() {
        return None;
    }
    Some(host.to_ascii_lowercase())
}

fn strip_www(host: &str) -> &str {
    host.strip_prefix("www.").unwrap_or(host)
}

/// Does a stored URL's host serve the queried host?
///
/// Exact match, or either side is a subdomain of the other (an entry filed
/// under `example.com` covers `login.example.com`, and vice versa). `www.` is
/// ignored on both sides, matching what every password manager does.
#[must_use]
pub fn host_matches(entry_host: &str, query_host: &str) -> bool {
    let a = strip_www(&entry_host.to_ascii_lowercase()).to_string();
    let b = strip_www(&query_host.to_ascii_lowercase()).to_string();
    if a.is_empty() || b.is_empty() {
        return false;
    }
    a == b || a.ends_with(&format!(".{b}")) || b.ends_with(&format!(".{a}"))
}

/// Path-name heuristics: does an entry's logical path look like it belongs to
/// `query_host`? Only reached when no `url:` trailer matched.
///
/// A segment must *be* the host, or a parent/child of it on a dot boundary.
/// There is deliberately no bare-label rule (`Dev/github` answering
/// `github.com`): it would equally answer `github.lol` or
/// `attacker.github.io`, handing a credential to a lookalike or a
/// shared-hosting tenant.
#[must_use]
pub fn name_matches(name: &str, query_host: &str) -> bool {
    let host = strip_www(&query_host.to_ascii_lowercase()).to_string();
    if host.is_empty() {
        return false;
    }
    for segment in name.split('/') {
        let segment = strip_www(&segment.trim().to_ascii_lowercase()).to_string();
        if segment.is_empty() {
            continue;
        }
        if segment == host {
            return true;
        }
        // `Web/github.com` answering `gist.github.com`, and the converse.
        // Both directions require the *other* side to look like a real
        // domain: without that guard a one-label query such as `com` would
        // suffix-match every `*.com` entry in the store.
        if segment.contains('.') && host.ends_with(&format!(".{segment}")) {
            return true;
        }
        if host.contains('.') && segment.ends_with(&format!(".{host}")) {
            return true;
        }
    }
    false
}

#[cfg(test)]
#[path = "store_tests.rs"]
mod tests;
