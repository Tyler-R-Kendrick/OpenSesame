//! Named multi-tomb registry (portable sealed-store roots + optional Linux Tomb).

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum TombBackend {
    #[default]
    Portable,
    LinuxTomb,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TombEntry {
    pub name: String,
    /// Ciphertext store root.
    pub store: String,
    /// Key material path (`.opensesame-key` or Linux tomb key).
    pub key: String,
    /// Linux Tomb volume file when `backend` is `linux-tomb`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub volume: Option<String>,
    #[serde(default)]
    pub backend: TombBackend,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TombRegistry {
    pub version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active: Option<String>,
    #[serde(default)]
    pub tombs: Vec<TombEntry>,
}

impl Default for TombRegistry {
    fn default() -> Self {
        Self {
            version: 1,
            active: None,
            tombs: Vec::new(),
        }
    }
}

#[derive(Debug, Error)]
pub enum TombRegistryError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("invalid tombs config: {0}")]
    Json(#[from] serde_json::Error),
    #[error("tomb not found: {0}")]
    NotFound(String),
    #[error("tomb already registered: {0}")]
    Duplicate(String),
}

#[must_use]
pub fn default_tombs_config_path() -> PathBuf {
    if let Ok(p) = std::env::var("OPENSESAME_TOMBS_CONFIG") {
        if !p.is_empty() {
            return PathBuf::from(p);
        }
    }
    if let Some(dir) = directories::BaseDirs::new() {
        return dir.config_dir().join("opensesame").join("tombs.json");
    }
    PathBuf::from("tombs.json")
}

///
/// # Errors
///
/// Returns an error when validation or the underlying operation fails.
pub fn load_tomb_registry(path: &Path) -> Result<TombRegistry, TombRegistryError> {
    if !path.exists() {
        return Ok(TombRegistry::default());
    }
    let raw = fs::read_to_string(path)?;
    let reg: TombRegistry = serde_json::from_str(&raw)?;
    Ok(reg)
}

///
/// # Errors
///
/// Returns an error when validation or the underlying operation fails.
pub fn save_tomb_registry(path: &Path, reg: &TombRegistry) -> Result<(), TombRegistryError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let raw = serde_json::to_string_pretty(reg)?;
    fs::write(path, raw)?;
    Ok(())
}

fn expand_user(raw: &str) -> PathBuf {
    if let Some(rest) = raw.strip_prefix("~/") {
        if let Ok(home) = std::env::var("HOME") {
            return PathBuf::from(home).join(rest);
        }
    }
    if raw == "~" {
        if let Ok(home) = std::env::var("HOME") {
            return PathBuf::from(home);
        }
    }
    PathBuf::from(raw)
}

pub struct ResolvedTomb {
    pub entry: TombEntry,
    pub store: PathBuf,
    pub key: PathBuf,
    pub volume: Option<PathBuf>,
}

/// Resolve store/key paths for `name`, or the active tomb when `name` is None.
///
/// # Errors
///
/// Returns an error when validation or the underlying operation fails.
pub fn resolve_tomb_paths(
    reg: &TombRegistry,
    name: Option<&str>,
) -> Result<ResolvedTomb, TombRegistryError> {
    let key = name
        .map(str::to_string)
        .or_else(|| reg.active.clone())
        .ok_or_else(|| TombRegistryError::NotFound("(no active tomb)".into()))?;
    let entry = reg
        .tombs
        .iter()
        .find(|t| t.name == key)
        .cloned()
        .ok_or(TombRegistryError::NotFound(key))?;
    Ok(ResolvedTomb {
        store: expand_user(&entry.store),
        key: expand_user(&entry.key),
        volume: entry.volume.as_deref().map(expand_user),
        entry,
    })
}

impl TombRegistry {
    ///
    /// # Errors
    ///
    /// Returns an error when validation or the underlying operation fails.
    pub fn add(&mut self, entry: TombEntry) -> Result<(), TombRegistryError> {
        if self.tombs.iter().any(|t| t.name == entry.name) {
            return Err(TombRegistryError::Duplicate(entry.name));
        }
        if self.active.is_none() {
            self.active = Some(entry.name.clone());
        }
        self.tombs.push(entry);
        Ok(())
    }

    ///
    /// # Errors
    ///
    /// Returns an error when validation or the underlying operation fails.
    pub fn remove(&mut self, name: &str) -> Result<(), TombRegistryError> {
        let before = self.tombs.len();
        self.tombs.retain(|t| t.name != name);
        if self.tombs.len() == before {
            return Err(TombRegistryError::NotFound(name.into()));
        }
        if self.active.as_deref() == Some(name) {
            self.active = self.tombs.first().map(|t| t.name.clone());
        }
        Ok(())
    }

    ///
    /// # Errors
    ///
    /// Returns an error when validation or the underlying operation fails.
    pub fn use_tomb(&mut self, name: &str) -> Result<(), TombRegistryError> {
        if !self.tombs.iter().any(|t| t.name == name) {
            return Err(TombRegistryError::NotFound(name.into()));
        }
        self.active = Some(name.into());
        Ok(())
    }
}

/// Canonical sealed-store tomb name for a principal's default personal project.
pub const PERSONAL_PROJECT_TOMB_NAME: &str = "personal";

/// Returns the frozen tomb name bound to the default personal project.
#[must_use]
pub fn personal_project_tomb_name() -> &'static str {
    PERSONAL_PROJECT_TOMB_NAME
}

/// Resolve the tomb name from optional project binding metadata.
///
/// When `sealed_store_tomb_name` is absent or blank, falls back to the personal
/// project tomb so multi-tomb registries stay coherent (ADR 0038).
pub fn resolve_project_tomb_name(sealed_store_tomb_name: Option<&str>) -> &str {
    match sealed_store_tomb_name
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        Some(name) => name,
        None => PERSONAL_PROJECT_TOMB_NAME,
    }
}

/// Resolve an existing personal-project tomb, or register a portable entry.
///
/// Does not remove or rewrite other tombs — personal binding is additive.
///
/// # Errors
///
/// Returns an error when validation or the underlying operation fails.
pub fn ensure_personal_project_tomb(
    reg: &mut TombRegistry,
    store: &str,
    key: &str,
) -> Result<TombEntry, TombRegistryError> {
    let name = PERSONAL_PROJECT_TOMB_NAME;
    if let Some(existing) = reg.tombs.iter().find(|t| t.name == name) {
        return Ok(existing.clone());
    }
    let entry = TombEntry {
        name: name.into(),
        store: store.into(),
        key: key.into(),
        volume: None,
        backend: TombBackend::Portable,
    };
    reg.add(entry.clone())?;
    Ok(entry)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn round_trip_registry() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("tombs.json");
        let mut reg = TombRegistry::default();
        reg.add(TombEntry {
            name: "personal".into(),
            store: "~/tombs/personal".into(),
            key: "~/keys/personal.key".into(),
            volume: None,
            backend: TombBackend::Portable,
        })
        .unwrap();
        save_tomb_registry(&path, &reg).unwrap();
        let loaded = load_tomb_registry(&path).unwrap();
        assert_eq!(loaded.active.as_deref(), Some("personal"));
        assert_eq!(loaded.tombs.len(), 1);
    }

    #[test]
    fn resolve_active() {
        let mut reg = TombRegistry::default();
        reg.add(TombEntry {
            name: "a".into(),
            store: "/tmp/a".into(),
            key: "/tmp/a.key".into(),
            volume: None,
            backend: TombBackend::Portable,
        })
        .unwrap();
        let resolved = resolve_tomb_paths(&reg, None).unwrap();
        assert_eq!(resolved.store, PathBuf::from("/tmp/a"));
    }

    #[test]
    fn ensure_personal_project_tomb_is_idempotent() {
        let mut reg = TombRegistry::default();
        reg.add(TombEntry {
            name: "work".into(),
            store: "/tmp/work".into(),
            key: "/tmp/work.key".into(),
            volume: None,
            backend: TombBackend::Portable,
        })
        .unwrap();

        let first =
            ensure_personal_project_tomb(&mut reg, "~/tombs/personal", "~/keys/personal.key")
                .unwrap();
        assert_eq!(first.name, PERSONAL_PROJECT_TOMB_NAME);
        assert_eq!(reg.tombs.len(), 2);
        assert_eq!(reg.active.as_deref(), Some("work"));

        let second = ensure_personal_project_tomb(&mut reg, "/other/store", "/other/key").unwrap();
        assert_eq!(second.store, "~/tombs/personal");
        assert_eq!(reg.tombs.len(), 2);
    }

    #[test]
    fn resolve_project_tomb_name_falls_back_to_personal() {
        assert_eq!(resolve_project_tomb_name(None), PERSONAL_PROJECT_TOMB_NAME);
        assert_eq!(
            resolve_project_tomb_name(Some("  ")),
            PERSONAL_PROJECT_TOMB_NAME
        );
        assert_eq!(resolve_project_tomb_name(Some("team-a")), "team-a");
    }
}
