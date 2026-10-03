//! Optional runtime plugins (ADR 0150 §7): what exists, whether it is
//! installed, whether it is switched on, and whether the file on disk is still
//! the one that was installed.
//!
//! Nothing a plugin does is in a default build. The `opensesame` binary does
//! not link one, the daemon does not link one, and Pages does not bundle one.
//! A person installs a plugin (a binary pinned by sha256, or a companion
//! browser extension), and it stays off until switched on in Settings or with
//! `opensesame plugins enable`. Both paths write the one settings file this
//! crate reads, so Settings is that file (ADR 0134) and the CLI edits the same
//! bytes.
//!
//! Three rules hold everywhere a plugin is consulted:
//!
//! 1. **Off unless recorded on.** A plugin missing from the file, or present
//!    with `enabled: false`, is off. A catalog entry's `default_enabled` is
//!    `false` for every plugin, and a test pins it.
//! 2. **An environment override can only turn a plugin off.**
//!    `OPENSESAME_PLUGIN_<ID>` set to anything but an explicit `on`, `1`,
//!    `true` or `yes` wins over the file (an unrecognised word fails toward
//!    off); no value turns one on. An operator can disable a plugin for a
//!    process; no environment can enable something a person did not. For the
//!    same reason no environment names the settings file in a shipped build:
//!    `OPENSESAME_PLUGINS_FILE` is honoured only when this crate is built
//!    with the `path-override` feature, which the crates' own test builds
//!    turn on and a release never does (`pnpm audit:plugin-boundary`).
//!    A same-user process can still redirect `HOME`/`XDG_CONFIG_HOME`; that
//!    is the user boundary, not a boundary this crate draws.
//! 3. **A binary is verified at every launch, not only at install.** The
//!    recorded sha256 is recomputed before the binary is run; a mismatch is a
//!    refusal, never a warning.

mod catalog;
mod lock;
mod pairing;
mod pairing_code;
mod paths;
mod settings;

pub use catalog::{catalog, CatalogPlugin, PluginKind};
pub use pairing::{
    Issued, PairedView, PairingError, PendingView, PluginPairings, CODE_TTL_SECS, MAX_PAIRED,
    MAX_PENDING, PAIRINGS_FILE,
};
pub use pairing_code::{
    format_pairing_code, is_pairable_origin, is_secret_shaped, unix_now, MAX_LABEL_CHARS,
    PAIRING_CODE_PREFIX,
};
pub use paths::{
    notices_path, plugin_state_dir, tripwires_path, NOTICES_FILE, NOTICES_ROTATED_FILE,
    STATE_DIR_NAME, TRIPWIRES_FILE,
};
pub use settings::{
    default_settings_path, settings_path_from, sha256_file, InstalledPlugin, PluginSettings, PluginState,
    SettingsError, SETTINGS_PATH_ENV,
};

#[cfg(test)]
mod tests;
#[cfg(test)]
mod tests_hardening;
