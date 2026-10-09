//! `opensesame plugins …`: optional, runtime-installed plugins (ADR 0150 §7).
//!
//! Nothing a plugin does ships in this binary. A person installs one — a
//! native executable, or a companion browser extension's package — pinned by
//! sha256; it is recorded **off**; and it runs only once switched on here or in
//! Settings. Both write the one settings file `crates/plugin-settings` owns.
//! `OPENSESAME_PLUGIN_<ID>=off` turns a plugin off for a process whatever the
//! file says; nothing turns one on.

use std::path::PathBuf;

use clap::Subcommand;
use opensesame_plugin_settings::{catalog, default_settings_path, PluginSettings, SettingsError};
use serde_json::{json, Value};

use crate::plugins_install::{self, InstallRequest};

#[derive(Subcommand, Debug)]
pub(crate) enum PluginsCmd {
    /// Every plugin the catalog names, and whether it is installed and on.
    List,
    /// Install a plugin from a local file or an https URL, pinned by sha256.
    /// It is recorded off.
    Install {
        id: String,
        /// A local path or an https URL (the native binary, or the extension's
        /// packed zip), or a browser store id for an extension.
        #[arg(long)]
        from: String,
        /// Lowercase hex sha256 of what `--from` names. Checked before anything
        /// is recorded.
        #[arg(long)]
        sha256: String,
        #[arg(long = "version")]
        plugin_version: Option<String>,
        /// The browser extension's id (browser-extension plugins only).
        #[arg(long)]
        extension_id: Option<String>,
    },
    /// Switch an installed plugin on.
    Enable { id: String },
    /// Switch a plugin off.
    Disable { id: String },
    /// Delete a plugin's installed files and its record.
    Remove { id: String },
    /// One plugin's state, and whether its file still matches its pin.
    Status { id: String },
    /// A plugin's recent tripwire notices, newest first — never a surrogate.
    Notices { id: String },
    /// Let one browser origin reach these plugin settings: prints a one-time
    /// pairing code, good for five minutes, that the page at that origin
    /// trades once for a key opening the plugin routes and nothing else.
    Pair {
        /// The page's exact origin: `https://host[:port]`, or
        /// `http://localhost:port` for a page served on this machine.
        #[arg(long)]
        origin: String,
        /// Where that page reaches this daemon: this machine, or its tailnet
        /// address (its Tailscale Serve URL).
        #[arg(long, default_value = plugins_pair::DEFAULT_DAEMON_URL)]
        url: String,
        /// What the page calls this daemon.
        #[arg(long, default_value = "OpenSesame daemon")]
        label: String,
    },
    /// Revoke what pages hold: every pairing for one origin, or all of them.
    Unpair {
        #[arg(long, required_unless_present = "all", conflicts_with = "all")]
        origin: Option<String>,
        #[arg(long)]
        all: bool,
    },
}

fn env(key: &str) -> Option<String> {
    std::env::var(key).ok()
}

fn settings_path() -> anyhow::Result<PathBuf> {
    Ok(default_settings_path()?)
}

fn unknown(id: &str) -> anyhow::Error {
    let known: Vec<String> = catalog().into_iter().map(|p| p.id).collect();
    anyhow::anyhow!(
        "unknown plugin {id}; the catalog names: {}",
        known.join(", ")
    )
}

pub(crate) async fn run(output: &str, cmd: PluginsCmd) -> anyhow::Result<()> {
    let path = settings_path()?;
    let value = match cmd {
        PluginsCmd::List => {
            let settings = PluginSettings::load(&path)?;
            json!({ "plugins": settings.states(env), "pairings": plugins_pair::listing(&path)? })
        }
        PluginsCmd::Install {
            id,
            from,
            sha256,
            plugin_version,
            extension_id,
        } => {
            let request = InstallRequest {
                id,
                from,
                sha256,
                version: plugin_version,
                extension_id,
            };
            plugins_install::install(&path, &plugins_install::install_root()?, request).await?
        }
        PluginsCmd::Enable { id } => set_enabled(&path, &id, true)?,
        PluginsCmd::Disable { id } => set_enabled(&path, &id, false)?,
        PluginsCmd::Remove { id } => {
            plugins_install::remove(&path, &plugins_install::install_root()?, &id)?
        }
        PluginsCmd::Status { id } => status(&path, &id)?,
        PluginsCmd::Pair { origin, url, label } => {
            let value = plugins_pair::pair(&path, &origin, &url, &label)?;
            eprintln!(
                "The code works once, from {origin} only, for five minutes; it is not shown again."
            );
            value
        }
        PluginsCmd::Unpair { origin, all } => {
            plugins_pair::unpair(&path, origin.as_deref().filter(|_| !all))?
        }
        PluginsCmd::Notices { id } => {
            let file =
                opensesame_plugin_settings::notices_path(&path, &id).map_err(|_| unknown(&id))?;
            json!({ "notices": opensesame_daemon::plugin_notices(&file) })
        }
    };
    crate::print_output(output, &value)
}

/// Switch `id` on or off. Switching a native plugin on re-checks its pin
/// first and leaves it off if the file changed.
pub(crate) fn set_enabled(
    path: &std::path::Path,
    id: &str,
    enabled: bool,
) -> anyhow::Result<Value> {
    let checking = std::cell::Cell::new(false);
    let changed = PluginSettings::update(path, |settings| {
        settings.set_enabled(id, enabled)?;
        if enabled && is_native(id) {
            checking.set(true);
            settings.verified_binary(id, |_: &str| None)?;
        }
        settings.state(id, env)
    });
    match changed {
        Ok(state) => Ok(serde_json::to_value(state)?),
        Err(SettingsError::UnknownPlugin(_)) => Err(unknown(id)),
        Err(SettingsError::NotInstalled(_)) if !checking.get() => anyhow::bail!(
            "plugin {id} is not installed; install it first with \
             'opensesame plugins install {id} --from <path-or-https-url> --sha256 <hex>'"
        ),
        Err(error) if checking.get() => anyhow::bail!(
            "plugin {id} was left off: {error}; reinstall it with \
             'opensesame plugins install {id} …'"
        ),
        Err(other) => Err(other.into()),
    }
}

fn is_native(id: &str) -> bool {
    catalog()
        .iter()
        .any(|p| p.id == id && p.kind == opensesame_plugin_settings::PluginKind::NativeBinary)
}

/// State plus the install record and a fresh pin check.
pub(crate) fn status(path: &std::path::Path, id: &str) -> anyhow::Result<Value> {
    let settings = PluginSettings::load(path)?;
    let state = settings.state(id, env).map_err(|_| unknown(id))?;
    let mut value = serde_json::to_value(&state)?;
    if let Some(installed) = settings.plugins.get(id) {
        let pin = if is_native(id) {
            match opensesame_plugin_settings::sha256_file(std::path::Path::new(&installed.location))
            {
                Ok(digest) if digest == installed.sha256 => "ok",
                Ok(_) => "mismatch",
                Err(_) => "missing",
            }
        } else {
            "store"
        };
        value["location"] = json!(installed.location);
        value["sha256"] = json!(installed.sha256);
        value["pin"] = json!(pin);
    }
    Ok(value)
}

#[path = "plugins_pair.rs"]
pub(crate) mod plugins_pair;

#[cfg(test)]
#[path = "plugins_tests.rs"]
mod tests;
