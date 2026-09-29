//! The runtime switch (ADR 0150 §7).
//!
//! Login substitution is compiled only into the surrogate-proxy plugin, and
//! even there a declaration does nothing until it is **armed**: the recipe
//! opted in, and the `surrogate-proxy` plugin is installed, recorded on and
//! not forced off by `OPENSESAME_PLUGIN_SURROGATE_PROXY=off`. Login
//! substitution has no switch of its own. It shares that plugin's, so the one
//! Settings switch, `opensesame plugins enable|disable` and the environment
//! override govern the proxy and the login form together.
//!
//! [`LoginRoad::choose`] is the whole decision and it is pure: it reads the
//! [`PluginState`] the runner already holds (from
//! `PluginSettings::load(default_settings_path()?)?.state(SUBSTITUTION_PLUGIN,
//! env)`), never a file. Only [`ArmedSubstitution`] can substitute, and only
//! `choose` makes one, so a runner that skipped the check has nothing to call.

use std::fmt;
use std::ops::Deref;

use opensesame_plugin_settings::PluginState;
use serde::{Deserialize, Serialize};

use super::LoginSubstitution;

/// The plugin whose switch login substitution shares
/// (`spec/plugins/catalog.json`).
pub const SUBSTITUTION_PLUGIN: &str = "surrogate-proxy";

/// A declared substitution the plugin's switch allowed. Not `Clone`, like the
/// declaration it holds: [`conclude`](Self::conclude) consumes it.
pub struct ArmedSubstitution(pub(super) LoginSubstitution);

impl fmt::Debug for ArmedSubstitution {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_tuple("ArmedSubstitution").field(&self.0).finish()
    }
}

/// The declaration's origin, path, field and surrogate, read-only.
impl Deref for ArmedSubstitution {
    type Target = LoginSubstitution;

    fn deref(&self) -> &LoginSubstitution {
        &self.0
    }
}

/// Why a login goes by CDP fill without trying substitution.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CdpOnly {
    /// The recipe declared no substitution.
    NotDeclared,
    /// The state passed is another plugin's. A caller's mistake, refused
    /// rather than read as this plugin's switch.
    NotThePlugin,
    /// The surrogate-proxy plugin is not installed.
    NotInstalled,
    /// Installed and recorded off — the default after every install.
    SwitchedOff,
    /// Recorded on, and forced off by the environment for this process.
    ForcedOff,
}

impl CdpOnly {
    /// Stable, value-free names, for a runner's log line or notice.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::NotDeclared => "not_declared",
            Self::NotThePlugin => "not_the_plugin",
            Self::NotInstalled => "not_installed",
            Self::SwitchedOff => "switched_off",
            Self::ForcedOff => "forced_off",
        }
    }
}

/// How one login proceeds.
#[derive(Debug)]
pub enum LoginRoad {
    /// Type the surrogate and substitute at egress, falling back to CDP fill.
    Substitute(ArmedSubstitution),
    /// CDP fill only, as before ADR 0150.
    CdpFill(CdpOnly),
}

impl LoginRoad {
    /// Arm `declared` if, and only if, the recipe opted in and `plugin` is the
    /// surrogate-proxy plugin, installed, recorded on and not forced off.
    ///
    /// `active` is re-derived from the facts it summarizes rather than
    /// trusted: a state that says `active` beside `enabled: false` or
    /// `forced_off: true` arms nothing.
    #[must_use]
    pub fn choose(declared: Option<LoginSubstitution>, plugin: &PluginState) -> Self {
        let Some(declared) = declared else {
            return Self::CdpFill(CdpOnly::NotDeclared);
        };
        match permitted(plugin) {
            Ok(()) => Self::Substitute(ArmedSubstitution(declared)),
            Err(why) => Self::CdpFill(why),
        }
    }
}

fn permitted(plugin: &PluginState) -> Result<(), CdpOnly> {
    if plugin.id != SUBSTITUTION_PLUGIN {
        return Err(CdpOnly::NotThePlugin);
    }
    if !plugin.installed {
        return Err(CdpOnly::NotInstalled);
    }
    if plugin.forced_off {
        return Err(CdpOnly::ForcedOff);
    }
    if !(plugin.enabled && plugin.active) {
        return Err(CdpOnly::SwitchedOff);
    }
    Ok(())
}
