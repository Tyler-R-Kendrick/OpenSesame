//! The plugin catalog, embedded from `spec/plugins/catalog.json` (ADR 0139):
//! one definition every target reads.

use serde::Deserialize;

const CATALOG_JSON: &str = include_str!("../../../spec/plugins/catalog.json");

/// How a plugin is delivered.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PluginKind {
    /// A separate executable, installed next to — never inside — `opensesame`.
    NativeBinary,
    /// A companion browser extension, installed from its own package.
    BrowserExtension,
}

/// One catalog row.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct CatalogPlugin {
    pub id: String,
    pub kind: PluginKind,
    /// The executable name, for a native binary.
    #[serde(default)]
    pub binary: Option<String>,
    /// The npm package, for a browser extension.
    #[serde(default)]
    pub package: Option<String>,
    /// The Pages / capability-registry capability that owns its settings.
    pub capability: String,
    pub adr: String,
    pub default_enabled: bool,
    /// Daemon routes that answer only while the plugin is on.
    #[serde(default)]
    pub daemon_routes: Vec<String>,
    /// Providers the plugin brokers with a connection's own credential, the
    /// one the person sealed under `connections/…`, rather than one a local
    /// tool yields.
    #[serde(default)]
    pub stored_credential_providers: Vec<String>,
    pub summary: String,
}

#[derive(Deserialize)]
struct CatalogFile {
    schema_version: u8,
    settings_file: String,
    env_override_prefix: String,
    plugins: Vec<CatalogPlugin>,
}

fn parsed() -> CatalogFile {
    // The file is embedded at compile time and pinned by tests, so a parse
    // failure is a build defect, not a runtime condition.
    serde_json::from_str(CATALOG_JSON).unwrap_or_else(|_| CatalogFile {
        schema_version: 0,
        settings_file: String::new(),
        env_override_prefix: String::new(),
        plugins: Vec::new(),
    })
}

/// Every plugin the catalog names.
#[must_use]
pub fn catalog() -> Vec<CatalogPlugin> {
    parsed().plugins
}

/// Whether the plugin `plugin_id` brokers `provider_id` with the credential a
/// person sealed for that connection. `false` for an unknown plugin and for a
/// provider the plugin serves from a local tool or not at all: the catalog is
/// the one place that says, so the command line, which links no plugin, and
/// the plugin itself cannot disagree (ADR 0139).
#[must_use]
pub fn takes_stored_credential(plugin_id: &str, provider_id: &str) -> bool {
    find(plugin_id).is_some_and(|plugin| {
        plugin
            .stored_credential_providers
            .iter()
            .any(|served| served == provider_id)
    })
}

/// The settings file's name inside the config directory.
pub(crate) fn settings_file_name() -> String {
    parsed().settings_file
}

/// `OPENSESAME_PLUGIN_`.
pub(crate) fn env_override_prefix() -> String {
    parsed().env_override_prefix
}

pub(crate) fn schema_version() -> u8 {
    parsed().schema_version
}

/// The catalog row for `id`.
pub(crate) fn find(id: &str) -> Option<CatalogPlugin> {
    catalog().into_iter().find(|plugin| plugin.id == id)
}
