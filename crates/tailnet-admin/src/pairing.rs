//! Pairing one browser origin with the tailnet device routes, for one role
//! (ADR 0166 §3), as `PluginPairings` pairs one with the plugin routes.
//!
//! `opensesame tailnet pair --origin <o> --role <r>` records a one-time code
//! for exactly that origin and role; the page at that origin trades it, once,
//! for a bearer. The file keeps a SHA-256 of each code and bearer, never
//! either value. A code lives [`CODE_TTL_SECS`]; a code presented from any
//! other origin is spent on the spot, because a code that reached the wrong
//! page has leaked.

use std::path::{Path, PathBuf};

use opensesame_plugin_settings::{is_pairable_origin, is_secret_shaped};
use serde::{Deserialize, Serialize};

use crate::pairing_code::{clean_label, digest_hex, pairing_id, same, secret, Role, CODE_TTL_SECS};
use crate::paths::{read_optional, write_private};
use crate::AdminError;

const PAIRINGS_FILE: &str = "tailnet-pairings.json";
const FILE_VERSION: u32 = 1;
/// Codes waiting at once; more is a flood, not a person.
const MAX_PENDING: usize = 8;
/// Paired pages at once.
const MAX_PAIRED: usize = 32;

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Pending {
    code_sha256: String,
    origin: String,
    role: Role,
    label: String,
    expires_at: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct PairedPage {
    id: String,
    token_sha256: String,
    origin: String,
    role: Role,
    label: String,
    paired_at: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct PairingFile {
    v: u32,
    #[serde(default)]
    pending: Vec<Pending>,
    #[serde(default)]
    paired: Vec<PairedPage>,
}

impl Default for PairingFile {
    fn default() -> Self {
        Self {
            v: FILE_VERSION,
            pending: Vec::new(),
            paired: Vec::new(),
        }
    }
}

/// Who a bearer is: what an audit line and a role check need.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Paired {
    pub id: String,
    pub origin: String,
    pub role: Role,
    pub label: String,
}

/// A paired page as the operator sees it: no digest.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PairedView {
    pub id: String,
    pub origin: String,
    pub role: Role,
    pub label: String,
    pub paired_at: u64,
}

/// A code still waiting, as the operator sees it: no digest.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PendingView {
    pub origin: String,
    pub role: Role,
    pub label: String,
    pub expires_at: u64,
}

/// The pairings file, read and written whole on every call.
#[derive(Clone, Debug)]
pub struct RolePairings {
    path: PathBuf,
}

impl RolePairings {
    #[must_use]
    pub fn at(dir: &Path) -> Self {
        Self {
            path: dir.join(PAIRINGS_FILE),
        }
    }

    fn load(&self) -> Result<PairingFile, AdminError> {
        let Some(bytes) = read_optional(&self.path)? else {
            return Ok(PairingFile::default());
        };
        let file: PairingFile = serde_json::from_slice(&bytes)
            .map_err(|error| AdminError::Unreadable(error.to_string()))?;
        if file.v != FILE_VERSION {
            return Err(AdminError::Unreadable(format!("version {}", file.v)));
        }
        Ok(file)
    }

    fn save(&self, file: &PairingFile) -> Result<(), AdminError> {
        let bytes = serde_json::to_vec_pretty(file)
            .map_err(|error| AdminError::Unreadable(error.to_string()))?;
        write_private(&self.path, &bytes)?;
        Ok(())
    }

    /// Record a one-time code for `origin` and `role`; returned once.
    ///
    /// # Errors
    ///
    /// `Invalid` for an origin a browser never sends, `Full` with too many
    /// codes waiting, or a file error.
    pub fn issue(
        &self,
        origin: &str,
        role: Role,
        label: &str,
        now: u64,
    ) -> Result<(String, u64), AdminError> {
        if !is_pairable_origin(origin) {
            return Err(AdminError::Invalid("invalid_origin"));
        }
        let mut file = self.load()?;
        file.pending.retain(|p| p.expires_at > now);
        if file.pending.len() >= MAX_PENDING {
            return Err(AdminError::Full);
        }
        let code = secret();
        let expires_at = now + CODE_TTL_SECS;
        file.pending.push(Pending {
            code_sha256: digest_hex(&code),
            origin: origin.to_string(),
            role,
            label: clean_label(label),
            expires_at,
        });
        self.save(&file)?;
        Ok((code, expires_at))
    }

    /// Trade `code`, presented from `origin`, for a bearer. The code is spent
    /// whether it was expired, sent from another origin, or traded. One
    /// refusal for every way it can be wrong.
    ///
    /// # Errors
    ///
    /// `PairingRefused`, `Full` (the code stays), or a file error.
    pub fn exchange(
        &self,
        code: &str,
        origin: &str,
        now: u64,
    ) -> Result<(Paired, String), AdminError> {
        let mut file = self.load()?;
        let digest = digest_hex(code);
        let index = file
            .pending
            .iter()
            .position(|p| same(&p.code_sha256, &digest))
            .filter(|_| is_secret_shaped(code))
            .ok_or(AdminError::PairingRefused)?;
        let live = file.pending[index].expires_at > now && file.pending[index].origin == origin;
        if live && file.paired.len() >= MAX_PAIRED {
            return Err(AdminError::Full);
        }
        let pending = file.pending.remove(index);
        file.pending.retain(|p| p.expires_at > now);
        let outcome = if live {
            let paired = Paired {
                id: pairing_id(),
                origin: pending.origin,
                role: pending.role,
                label: pending.label,
            };
            let token = secret();
            file.paired.push(PairedPage {
                id: paired.id.clone(),
                token_sha256: digest_hex(&token),
                origin: paired.origin.clone(),
                role: paired.role,
                label: paired.label.clone(),
                paired_at: now,
            });
            Ok((paired, token))
        } else {
            Err(AdminError::PairingRefused)
        };
        self.save(&file)?;
        outcome
    }

    /// Who `token`, presented from `origin`, is; `None` when it is nobody.
    /// An unreadable file pairs nobody.
    #[must_use]
    pub fn authorize(&self, token: &str, origin: &str) -> Option<Paired> {
        if !is_secret_shaped(token) {
            return None;
        }
        let file = self.load().ok()?;
        let digest = digest_hex(token);
        let mut found = None;
        // Every row is compared, so timing says nothing about which matched.
        for page in &file.paired {
            if same(&page.token_sha256, &digest) && page.origin == origin {
                found = Some(Paired {
                    id: page.id.clone(),
                    origin: page.origin.clone(),
                    role: page.role,
                    label: page.label.clone(),
                });
            }
        }
        found
    }

    /// Whether a browser at `origin` may be answered at all: it holds a
    /// bearer, or a code for it is still waiting.
    #[must_use]
    pub fn admits_origin(&self, origin: &str, now: u64) -> bool {
        self.load().is_ok_and(|file| {
            file.paired.iter().any(|p| p.origin == origin)
                || file
                    .pending
                    .iter()
                    .any(|p| p.origin == origin && p.expires_at > now)
        })
    }

    /// Remove the bearer `token` presented from `origin`.
    ///
    /// # Errors
    ///
    /// A file error.
    pub fn revoke(&self, token: &str, origin: &str) -> Result<bool, AdminError> {
        let Some(paired) = self.authorize(token, origin) else {
            return Ok(false);
        };
        let mut file = self.load()?;
        file.paired.retain(|p| p.id != paired.id);
        self.save(&file)?;
        Ok(true)
    }

    /// Remove every bearer and code for `origin`, for the pairing `id`, or
    /// for everyone with neither. Returns how many bearers went.
    ///
    /// # Errors
    ///
    /// A file error.
    pub fn unpair(&self, origin: Option<&str>, id: Option<&str>) -> Result<usize, AdminError> {
        let mut file = self.load()?;
        let before = file.paired.len();
        let everyone = origin.is_none() && id.is_none();
        let goes = |page_origin: &str, page_id: Option<&str>| {
            everyone
                || origin.is_some_and(|o| o == page_origin)
                || id.is_some_and(|wanted| page_id == Some(wanted))
        };
        file.paired.retain(|p| !goes(&p.origin, Some(&p.id)));
        file.pending.retain(|p| !goes(&p.origin, None));
        let removed = before - file.paired.len();
        self.save(&file)?;
        Ok(removed)
    }

    /// Paired pages and waiting codes, for the operator.
    ///
    /// # Errors
    ///
    /// A file error.
    pub fn list(&self, now: u64) -> Result<(Vec<PairedView>, Vec<PendingView>), AdminError> {
        let file = self.load()?;
        let paired = file
            .paired
            .iter()
            .map(|p| PairedView {
                id: p.id.clone(),
                origin: p.origin.clone(),
                role: p.role,
                label: p.label.clone(),
                paired_at: p.paired_at,
            })
            .collect();
        let pending = file
            .pending
            .iter()
            .filter(|p| p.expires_at > now)
            .map(|p| PendingView {
                origin: p.origin.clone(),
                role: p.role,
                label: p.label.clone(),
                expires_at: p.expires_at,
            })
            .collect();
        Ok((paired, pending))
    }
}

#[cfg(test)]
#[path = "pairing_tests.rs"]
mod tests;
