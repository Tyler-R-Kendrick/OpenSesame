//! Capability-moded discovery offers (ADR 0047, offer schema v1).
//!
//! Where [`scan`](crate::scan) answers "which providers look configured", the
//! offer model answers "what could `OpenSesame` do with each one": import the
//! credential into the vault ([`CapabilityClass::Importable`]), broker calls
//! through a local tool without importing ([`CapabilityClass::InvokeThrough`]),
//! or mint short-lived credentials natively
//! ([`CapabilityClass::Mintable`]). The value-blind contract is unchanged:
//! sources name variables, paths, keychain labels, and MCP env *key names* —
//! never a value, a prefix, or a length.
//!
//! Probes perform **no network I/O by construction**: [`ProbeContext`]
//! carries an injected environment snapshot, a keychain *label* enumerator,
//! and a scrubbed command runner that returns exit status only. There is no
//! socket, HTTP client, or URL anywhere in the probe API, and no way to read
//! the process environment directly.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::{scan, Detection, SourceKind};

pub const OFFER_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ProbeSource {
    EnvVar {
        name: String,
    },
    DotFile {
        path: PathBuf,
    },
    Keychain {
        store: KeychainStore,
        item_label: String,
    }, // label is a display name, NEVER a secret-derived value
    McpConfig {
        path: PathBuf,
        server_name: String,
        env_keys: Vec<String>,
    }, // key NAMES only
    CliTool {
        binary: String,
        version: Option<String>,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum KeychainStore {
    SecretService,
    MacOsKeychain,
    WindowsCredentialManager,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum CapabilityClass {
    Importable,
    InvokeThrough,
    Mintable,
} // Ord ascending; max() = preferred

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Confidence {
    Low,
    Medium,
    High,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OfferItem {
    pub provider_id: String,
    pub source: ProbeSource,
    pub capabilities: Vec<CapabilityClass>,
    pub confidence: Confidence,
    pub registry_hint: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProbeReport {
    pub schema_version: u32, // == OFFER_SCHEMA_VERSION
    pub host_label: String,  // hostname or tailnet node name; never a machine-id
    pub probed_at_unix: u64,
    pub items: Vec<OfferItem>,
}

/// Failures a probe may report. Note what is absent: there is no network or
/// "credential invalid" variant, because probes never validate a credential —
/// a test is an oracle (ADR 0047 §2).
#[derive(Debug, thiserror::Error)]
pub enum ProbeError {
    #[error("keychain enumeration failed: {0}")]
    Keychain(String),
    #[error("command probe failed: {0}")]
    Command(String),
    #[error("i/o during probe: {0}")]
    Io(#[from] std::io::Error),
}

/// Exit-code semantics only. Raw stdout/stderr never leaves the runner, so a
/// binary that prints a secret cannot leak it through a probe.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CommandStatus {
    pub success: bool,
    pub stdout_non_empty: bool,
}

pub trait KeychainBackend: Send + Sync {
    /// Enumerate item labels (display names) visible to the current user.
    /// MUST NOT return secret values. MAY trigger OS unlock prompts.
    ///
    /// # Errors
    ///
    /// Returns an error when validation or the underlying operation fails.
    fn enumerate_labels(&self) -> Result<Vec<(KeychainStore, String)>, ProbeError>;
}

pub trait CommandRunner: Send + Sync {
    /// Run a binary with a scrubbed environment, no shell, strict timeout, output capped.
    /// Returns exit status + whether stdout was non-empty. Callers never receive raw output.
    ///
    /// # Errors
    ///
    /// Returns an error when validation or the underlying operation fails.
    fn run_status(&self, argv: &[&str], timeout_ms: u64) -> Result<CommandStatus, ProbeError>;
}

pub struct ProbeContext {
    pub home_dir: PathBuf,
    pub env: BTreeMap<String, String>, // injected snapshot; never read process env directly
    pub keychain: Arc<dyn KeychainBackend>,
    pub commands: Arc<dyn CommandRunner>,
    pub max_read_bytes: usize,
}

pub trait CapabilityProbe: Send + Sync {
    fn id(&self) -> &'static str;
    ///
    /// # Errors
    ///
    /// Returns an error when validation or the underlying operation fails.
    fn probe(&self, ctx: &ProbeContext) -> Result<Vec<OfferItem>, ProbeError>;
}

// ——— Mint capability —————————————————————————————————————————————

/// Providers with a native short-lived mint path: GitHub App installation
/// tokens, the AWS family via STS, and GCP via service-account impersonation.
pub const MINT_CAPABLE_PROVIDERS: &[&str] = &[
    "github",
    "aws",
    "aws-kms",
    "aws-ps",
    "aws-bedrock",
    "gcp",
    "gcp-kms",
];

/// Whether this provider can mint short-lived credentials natively.
#[must_use]
pub fn mint_capable(provider: &str) -> bool {
    MINT_CAPABLE_PROVIDERS.contains(&provider)
}

// ——— Offer merging and reporting ——————————————————————————————————

/// One [`OfferItem`] per (`provider_id`, source-kind-identity): capabilities
/// are unioned, confidence takes the max, and MCP env key names are unioned.
/// Output order is deterministic (provider id, then source identity).
#[must_use]
pub fn merge_offers(items: Vec<OfferItem>) -> Vec<OfferItem> {
    let mut merged: BTreeMap<(String, String), OfferItem> = BTreeMap::new();
    for item in items {
        let key = (item.provider_id.clone(), source_identity(&item.source));
        let Some(existing) = merged.get_mut(&key) else {
            let mut item = item;
            item.capabilities.sort();
            item.capabilities.dedup();
            merged.insert(key, item);
            continue;
        };
        for capability in &item.capabilities {
            if !existing.capabilities.contains(capability) {
                existing.capabilities.push(*capability);
            }
        }
        existing.capabilities.sort();
        if confidence_rank(item.confidence) > confidence_rank(existing.confidence) {
            existing.confidence = item.confidence;
        }
        if existing.registry_hint.is_none() {
            existing.registry_hint.clone_from(&item.registry_hint);
        }
        if let (
            ProbeSource::McpConfig { env_keys: kept, .. },
            ProbeSource::McpConfig {
                env_keys: extra, ..
            },
        ) = (&mut existing.source, &item.source)
        {
            let additions: Vec<_> = extra
                .iter()
                .filter(|key| !kept.contains(*key))
                .cloned()
                .collect();
            kept.extend(additions);
            kept.sort();
        }
    }
    merged.into_values().collect()
}

/// The preferred way to use this offer: the highest capability class.
#[must_use]
pub fn preferred_capability(item: &OfferItem) -> Option<CapabilityClass> {
    item.capabilities.iter().copied().max()
}

/// Assemble a report, stamping it with the current schema version.
#[must_use]
pub fn build_report(host_label: String, probed_at_unix: u64, items: Vec<OfferItem>) -> ProbeReport {
    ProbeReport {
        schema_version: OFFER_SCHEMA_VERSION,
        host_label,
        probed_at_unix,
        items,
    }
}

/// Identity of a source for merging: same place, same provider — env keys and
/// CLI versions deliberately do not distinguish.
fn source_identity(source: &ProbeSource) -> String {
    match source {
        ProbeSource::EnvVar { name } => format!("env_var:{name}"),
        ProbeSource::DotFile { path } => format!("dot_file:{}", path.display()),
        ProbeSource::Keychain { store, item_label } => {
            format!("keychain:{store:?}:{item_label}")
        }
        ProbeSource::McpConfig {
            path, server_name, ..
        } => format!("mcp_config:{}:{server_name}", path.display()),
        ProbeSource::CliTool { binary, .. } => format!("cli_tool:{binary}"),
    }
}

fn confidence_rank(confidence: Confidence) -> u8 {
    match confidence {
        Confidence::Low => 0,
        Confidence::Medium => 1,
        Confidence::High => 2,
    }
}

// ——— Environment and dotfile probe ————————————————————————————————

/// Wraps [`scan`] — the same alias table, explicit `OPENSESAME_PROVIDER_*`
/// variables, and dotfile readers — emitting capability-moded offers instead
/// of flat detections. Explicit deployment-controlled variables are reported
/// with high confidence; everything conventional is medium.
pub struct EnvDotfileProbe;

impl CapabilityProbe for EnvDotfileProbe {
    fn id(&self) -> &'static str {
        "env-dotfile"
    }

    fn probe(&self, ctx: &ProbeContext) -> Result<Vec<OfferItem>, ProbeError> {
        // scan() reads HOME from the environment for dotfile paths; the
        // injected home directory stands in when the snapshot lacks one.
        let mut env = ctx.env.clone();
        env.entry("HOME".to_string())
            .or_insert_with(|| ctx.home_dir.to_string_lossy().into_owned());
        let read_env = |name: &str| env.get(name).filter(|v| !v.is_empty()).cloned();
        let read_file = |path: &PathBuf| read_capped(path, ctx.max_read_bytes);
        let detections = scan(&read_env, &read_file);
        Ok(detections
            .iter()
            .flat_map(|detection| detection_offers(detection, &ctx.home_dir, &env))
            .collect())
    }
}

fn detection_offers(
    detection: &Detection,
    home: &Path,
    env: &BTreeMap<String, String>,
) -> Vec<OfferItem> {
    let mut capabilities = vec![CapabilityClass::Importable];
    if mint_capable(&detection.provider_id) {
        capabilities.push(CapabilityClass::Mintable);
    }
    detection
        .sources
        .iter()
        .map(|source| {
            let (probe_source, confidence) = match source.kind {
                SourceKind::Env => (
                    ProbeSource::EnvVar {
                        name: source.name.clone(),
                    },
                    if source.name.starts_with("OPENSESAME_PROVIDER_") {
                        Confidence::High
                    } else {
                        Confidence::Medium
                    },
                ),
                SourceKind::File => (
                    ProbeSource::DotFile {
                        path: dotfile_path(&source.name, home, env),
                    },
                    Confidence::Medium,
                ),
                // scan() never emits MCP sources; McpConfigProbe owns those.
                SourceKind::Mcp => (
                    ProbeSource::DotFile {
                        path: PathBuf::from(&source.name),
                    },
                    Confidence::Medium,
                ),
            };
            OfferItem {
                provider_id: detection.provider_id.clone(),
                source: probe_source,
                capabilities: capabilities.clone(),
                confidence,
                registry_hint: None,
            }
        })
        .collect()
}

/// Resolve the display labels [`scan`] emits for file detections back to the
/// paths it read. The match arms mirror the label table in `scan`; the
/// fallback keeps an unknown label visible rather than dropping it.
fn dotfile_path(label: &str, home: &Path, env: &BTreeMap<String, String>) -> PathBuf {
    match label {
        "~/.vault-token" => home.join(".vault-token"),
        "~/.bao-token" => home.join(".bao-token"),
        "~/.aws/credentials" => home.join(".aws/credentials"),
        "gcloud application default credentials" => {
            env.get("GOOGLE_APPLICATION_CREDENTIALS").map_or_else(
                || home.join(".config/gcloud/application_default_credentials.json"),
                PathBuf::from,
            )
        }
        other => PathBuf::from(other),
    }
}

// ——— MCP configuration probe ——————————————————————————————————————

/// MCP client configurations, relative to the home directory unless already
/// absolute. Mirrors `apps/daemon/src/discovery.rs`.
pub const MCP_CONFIG_PATHS: &[&str] = &[
    ".mcp.json",
    ".cursor/mcp.json",
    ".codeium/windsurf/mcp_config.json",
    ".config/Claude/claude_desktop_config.json",
    "Library/Application Support/Claude/claude_desktop_config.json",
    "AppData/Roaming/Claude/claude_desktop_config.json",
];

/// Extends [`mcp_server_names`](crate::mcp_server_names): for each declared
/// server it also collects the *names* of the keys in its `env` block. These
/// files routinely hold raw API keys as env values, so no value from them is
/// ever read into an offer — key names only.
pub struct McpConfigProbe;

impl CapabilityProbe for McpConfigProbe {
    fn id(&self) -> &'static str {
        "mcp-config"
    }

    fn probe(&self, ctx: &ProbeContext) -> Result<Vec<OfferItem>, ProbeError> {
        let mut items = Vec::new();
        for relative in MCP_CONFIG_PATHS {
            let path = if Path::new(relative).is_absolute() {
                PathBuf::from(relative)
            } else {
                ctx.home_dir.join(relative)
            };
            let Some(contents) = read_capped(&path, ctx.max_read_bytes) else {
                continue;
            };
            for (server_name, env_keys) in mcp_server_env_keys(&contents) {
                items.push(OfferItem {
                    provider_id: server_name.clone(),
                    source: ProbeSource::McpConfig {
                        path: path.clone(),
                        server_name,
                        env_keys,
                    },
                    capabilities: vec![CapabilityClass::Importable],
                    confidence: Confidence::Medium,
                    registry_hint: None,
                });
            }
        }
        Ok(items)
    }
}

/// Per MCP server, the sorted names of the keys in its `env` block. Malformed
/// JSON or a missing `mcpServers` object yields an empty list, never an error.
#[must_use]
pub fn mcp_server_env_keys(contents: &str) -> Vec<(String, Vec<String>)> {
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(contents) else {
        return Vec::new();
    };
    let Some(servers) = parsed.get("mcpServers").and_then(|v| v.as_object()) else {
        return Vec::new();
    };
    servers
        .iter()
        .map(|(name, server)| {
            let mut env_keys: Vec<String> = server
                .get("env")
                .and_then(|v| v.as_object())
                .map(|env| env.keys().cloned().collect())
                .unwrap_or_default();
            env_keys.sort();
            (name.clone(), env_keys)
        })
        .collect()
}

// ——— Test doubles ——————————————————————————————————————————————————

/// In-memory keychain for tests and fixtures: a fixed list of labels.
#[derive(Debug, Default)]
pub struct MockKeychain {
    labels: Vec<(KeychainStore, String)>,
}

impl MockKeychain {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    #[must_use]
    pub fn with_label(mut self, store: KeychainStore, label: impl Into<String>) -> Self {
        self.labels.push((store, label.into()));
        self
    }
}

impl KeychainBackend for MockKeychain {
    fn enumerate_labels(&self) -> Result<Vec<(KeychainStore, String)>, ProbeError> {
        Ok(self.labels.clone())
    }
}

/// Scripted command runner for tests: exact argv matches return the scripted
/// status; anything else is an error, so an unexpected invocation fails loud.
#[derive(Debug, Default)]
pub struct MockCommandRunner {
    responses: BTreeMap<Vec<String>, CommandStatus>,
}

impl MockCommandRunner {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    #[must_use]
    pub fn with_status(mut self, argv: &[&str], status: CommandStatus) -> Self {
        self.responses
            .insert(argv.iter().map(|arg| (*arg).to_string()).collect(), status);
        self
    }
}

impl CommandRunner for MockCommandRunner {
    fn run_status(&self, argv: &[&str], _timeout_ms: u64) -> Result<CommandStatus, ProbeError> {
        let key: Vec<String> = argv.iter().map(|arg| (*arg).to_string()).collect();
        self.responses
            .get(&key)
            .copied()
            .ok_or_else(|| ProbeError::Command(format!("no mock response scripted for {key:?}")))
    }
}

// ——— Shared helpers ————————————————————————————————————————————————

/// Read a credential-adjacent file, capped: anything larger than
/// `max_read_bytes` is skipped, not truncated — a truncated JSON file would
/// parse as garbage anyway, and a truncated credential file is worse.
fn read_capped(path: &Path, max_read_bytes: usize) -> Option<String> {
    let len = std::fs::metadata(path).ok()?.len();
    if len > max_read_bytes as u64 {
        return None;
    }
    std::fs::read_to_string(path).ok()
}
