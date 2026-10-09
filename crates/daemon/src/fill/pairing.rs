//! The pairing ceremony that admits one browser extension to fill
//! (ADR 0052 §2 (b), ADR 0150 §6.4).
//!
//! An extension generates its own random token and asks to pair, from its own
//! origin. The daemon answers with a short code, which the popup shows. A
//! person reads that code off their own popup and approves it with the
//! operator credential on a separate channel; only then does the pair
//! `(extension origin, SHA-256 of the token)` become a paired caller. A
//! forger on the same machine can open a request under a copied origin, but
//! it gets its own code, and nobody approves a code they were not shown.
//!
//! The daemon keeps the token's digest, never the token, and persists paired
//! callers (origin, digest, time) to one owner-only file so a restart does
//! not force a new ceremony. Pending requests live in memory and expire.

use chrono::{DateTime, Utc};
use opensesame_host_core::operator::constant_time_eq;
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// How long a person has to approve a code.
pub(crate) const PENDING_TTL_SECS: i64 = 600;
/// Outstanding requests at once; more is a flood, not a person.
pub(crate) const MAX_PENDING: usize = 8;
/// Paired extensions at once; one per browser profile is the expected case.
pub(crate) const MAX_PAIRED: usize = 16;

/// File the paired callers are kept in, under the fill state directory.
pub(crate) const PAIRINGS_FILE: &str = "fill-pairings.json";

/// Code alphabet: no `0/O`, `1/I/L` or `U`, so it survives being read aloud.
const CODE_ALPHABET: &[u8] = b"ABCDEFGHJKMNPQRSTVWXYZ23456789";
const CODE_LEN: usize = 8;

#[derive(Clone, Debug, Serialize, Deserialize)]
struct PairedCaller {
    origin: String,
    /// Lower-case hex SHA-256 of the extension's token.
    token_sha256: String,
    paired_at: DateTime<Utc>,
}

/// A paired caller as the operator sees it: no digest.
#[derive(Debug, Serialize)]
pub(crate) struct PairedView {
    pub(crate) origin: String,
    pub(crate) paired_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct Pending {
    pub(crate) origin: String,
    #[serde(skip)]
    token_sha256: String,
    pub(crate) code: String,
    pub(crate) expires_at: DateTime<Utc>,
}

#[derive(Serialize, Deserialize)]
struct PairingFile {
    v: u32,
    pairings: Vec<PairedCaller>,
}

/// What a pairing request came to.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum PairOutcome {
    /// This origin and token are already a paired caller.
    Paired,
    /// Waiting on a person; show them this code.
    Pending {
        code: String,
        expires_at: DateTime<Utc>,
    },
    /// Too many outstanding requests.
    Full,
}

#[derive(Debug)]
pub(crate) enum PairingError {
    /// Too many paired callers; revoke one first.
    Full,
    /// The pairing file could not be written.
    Io(std::io::Error),
}

#[derive(Default)]
struct Inner {
    paired: Vec<PairedCaller>,
    pending: Vec<Pending>,
}

/// The paired callers and the outstanding requests.
pub(crate) struct Pairings {
    file: Option<PathBuf>,
    inner: Mutex<Inner>,
}

fn digest_hex(token: &str) -> String {
    Sha256::digest(token.as_bytes())
        .iter()
        .fold(String::with_capacity(64), |mut out, byte| {
            use std::fmt::Write as _;
            let _ = write!(out, "{byte:02x}");
            out
        })
}

fn fresh_code() -> String {
    let mut bytes = [0u8; CODE_LEN];
    OsRng.fill_bytes(&mut bytes);
    let len = u8::try_from(CODE_ALPHABET.len()).unwrap_or(u8::MAX);
    bytes
        .iter()
        .map(|byte| char::from(CODE_ALPHABET[usize::from(byte % len)]))
        .collect()
}

/// `abcd-efgh`, `ABCD EFGH` and `ABCDEFGH` are the same code.
fn normalize_code(code: &str) -> String {
    code.chars()
        .filter(|c| !matches!(c, '-' | ' '))
        .map(|c| c.to_ascii_uppercase())
        .collect()
}

impl Pairings {
    /// Load paired callers from `dir`; `None` keeps them in memory only. An
    /// unreadable or malformed file starts empty — nobody is paired — rather
    /// than guessing at what it meant.
    pub(crate) fn load(dir: Option<&Path>) -> Self {
        let file = dir.map(|dir| dir.join(PAIRINGS_FILE));
        let paired = file
            .as_deref()
            .and_then(|path| std::fs::read(path).ok())
            .and_then(
                |bytes| match serde_json::from_slice::<PairingFile>(&bytes) {
                    Ok(parsed) if parsed.v == 1 => Some(parsed.pairings),
                    _ => {
                        tracing::warn!("fill pairing file unreadable; starting with none paired");
                        None
                    }
                },
            )
            .unwrap_or_default();
        Self {
            file,
            inner: Mutex::new(Inner {
                paired,
                pending: Vec::new(),
            }),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        match self.inner.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    /// Whether `token`, presented from `origin`, is a paired caller.
    pub(crate) fn verify(&self, origin: &str, token: &str) -> bool {
        let digest = digest_hex(token);
        self.lock()
            .paired
            .iter()
            .any(|p| p.origin == origin && constant_time_eq(&p.token_sha256, &digest))
    }

    /// Open (or re-read) a pairing request for `origin` with `token`.
    pub(crate) fn request(&self, origin: &str, token: &str, now: DateTime<Utc>) -> PairOutcome {
        if self.verify(origin, token) {
            return PairOutcome::Paired;
        }
        let digest = digest_hex(token);
        let mut inner = self.lock();
        inner.pending.retain(|p| p.expires_at > now);
        if let Some(open) = inner
            .pending
            .iter()
            .find(|p| p.origin == origin && constant_time_eq(&p.token_sha256, &digest))
        {
            return PairOutcome::Pending {
                code: open.code.clone(),
                expires_at: open.expires_at,
            };
        }
        // One outstanding request per origin: a newer token replaces an older.
        inner.pending.retain(|p| p.origin != origin);
        if inner.pending.len() >= MAX_PENDING {
            return PairOutcome::Full;
        }
        let pending = Pending {
            origin: origin.to_string(),
            token_sha256: digest,
            code: fresh_code(),
            expires_at: now + chrono::Duration::seconds(PENDING_TTL_SECS),
        };
        let outcome = PairOutcome::Pending {
            code: pending.code.clone(),
            expires_at: pending.expires_at,
        };
        inner.pending.push(pending);
        outcome
    }

    /// A person approved `code`: its request becomes the paired caller for
    /// its origin, replacing any earlier token there. `Ok(None)` when no
    /// live request carries that code.
    pub(crate) fn approve(
        &self,
        code: &str,
        now: DateTime<Utc>,
    ) -> Result<Option<String>, PairingError> {
        let code = normalize_code(code);
        let mut inner = self.lock();
        inner.pending.retain(|p| p.expires_at > now);
        let Some(index) = inner
            .pending
            .iter()
            .position(|p| constant_time_eq(&p.code, &code))
        else {
            return Ok(None);
        };
        let request = inner.pending.remove(index);
        let mut paired = inner.paired.clone();
        paired.retain(|p| p.origin != request.origin);
        if paired.len() >= MAX_PAIRED {
            inner.pending.insert(index, request);
            return Err(PairingError::Full);
        }
        paired.push(PairedCaller {
            origin: request.origin.clone(),
            token_sha256: request.token_sha256,
            paired_at: now,
        });
        self.persist(&paired).map_err(PairingError::Io)?;
        inner.paired = paired;
        Ok(Some(request.origin))
    }

    /// Forget the paired caller at `origin`. `Ok(false)` when there was none.
    pub(crate) fn revoke(&self, origin: &str) -> Result<bool, PairingError> {
        let mut inner = self.lock();
        let mut paired = inner.paired.clone();
        paired.retain(|p| p.origin != origin);
        if paired.len() == inner.paired.len() {
            return Ok(false);
        }
        self.persist(&paired).map_err(PairingError::Io)?;
        inner.paired = paired;
        Ok(true)
    }

    /// Paired callers and live requests, for the operator. Digests stay here.
    pub(crate) fn snapshot(&self, now: DateTime<Utc>) -> (Vec<PairedView>, Vec<Pending>) {
        let inner = self.lock();
        let paired = inner
            .paired
            .iter()
            .map(|p| PairedView {
                origin: p.origin.clone(),
                paired_at: p.paired_at,
            })
            .collect();
        let pending = inner
            .pending
            .iter()
            .filter(|p| p.expires_at > now)
            .cloned()
            .collect();
        (paired, pending)
    }

    /// Write the paired callers, owner-only, by rename so a crash leaves the
    /// old file or the new one and never half of either.
    fn persist(&self, paired: &[PairedCaller]) -> std::io::Result<()> {
        let Some(path) = self.file.as_deref() else {
            return Ok(());
        };
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let body = serde_json::to_vec_pretty(&PairingFile {
            v: 1,
            pairings: paired.to_vec(),
        })
        .map_err(std::io::Error::other)?;
        let tmp = path.with_extension("tmp");
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt as _;
            options.mode(0o600);
        }
        std::io::Write::write_all(&mut options.open(&tmp)?, &body)?;
        std::fs::rename(&tmp, path)
    }
}

#[cfg(test)]
#[path = "pairing_tests.rs"]
mod tests;
