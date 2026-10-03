//! The plugin switch in front of every fill route (ADR 0150 §7).
//!
//! Autofill is the optional `browser-autofill` plugin. While it is not
//! installed, not switched on, or forced off with
//! `OPENSESAME_PLUGIN_BROWSER_AUTOFILL=off`, every fill route answers exactly
//! what a path this daemon never served answers: a bare 404 with no body, for
//! every method and every caller. Nothing about pairing, origins or the store
//! is consulted first, so the routes' existence cannot be probed.
//!
//! The switch is read from the plugin settings file on every request, not
//! cached at start: `opensesame plugins disable browser-autofill` and the
//! Settings switch take effect on the very next fill.

use axum::{
    extract::Request,
    http::StatusCode,
    middleware::Next,
    response::{IntoResponse, Response},
};
use opensesame_plugin_settings::{default_settings_path, PluginSettings};
use std::path::PathBuf;
use std::sync::Arc;

/// The catalog id of the plugin these routes belong to.
pub(crate) const PLUGIN_ID: &str = "browser-autofill";

/// Whether the plugin is active right now.
pub(crate) trait PluginGate: Send + Sync {
    fn active(&self) -> bool;
}

/// Reads one environment variable; the process environment in production.
type EnvReader = Box<dyn Fn(&str) -> Option<String> + Send + Sync>;

/// The production gate: the plugin settings file and the process environment.
pub(crate) struct SettingsGate {
    path: Option<PathBuf>,
    env: EnvReader,
}

impl SettingsGate {
    /// `OPENSESAME_PLUGINS_FILE`, else `<config dir>/plugins.json`. With no
    /// config directory at all there is nowhere a person could have switched
    /// the plugin on, so it is off.
    pub(crate) fn from_env() -> Self {
        Self {
            path: default_settings_path().ok(),
            env: Box::new(|key| std::env::var(key).ok()),
        }
    }

    /// A gate over `path`, reading overrides from `env` rather than racing
    /// other tests on the process environment.
    #[cfg(test)]
    pub(crate) fn at(
        path: PathBuf,
        env: impl Fn(&str) -> Option<String> + Send + Sync + 'static,
    ) -> Self {
        Self {
            path: Some(path),
            env: Box::new(env),
        }
    }
}

impl PluginGate for SettingsGate {
    fn active(&self) -> bool {
        let Some(path) = self.path.as_deref() else {
            return false;
        };
        // An unreadable, malformed or newer-schema file is off: the plugin
        // runs only on a record that says, legibly, that a person turned it on.
        PluginSettings::load(path)
            .and_then(|settings| settings.state(PLUGIN_ID, &self.env))
            .is_ok_and(|state| state.active)
    }
}

/// A fixed answer, for route tests.
#[cfg(test)]
pub(crate) struct Fixed(pub(crate) bool);

#[cfg(test)]
impl PluginGate for Fixed {
    fn active(&self) -> bool {
        self.0
    }
}

/// Middleware: a route that is off is indistinguishable from no route.
pub(crate) async fn require_active(
    gate: Arc<dyn PluginGate>,
    request: Request,
    next: Next,
) -> Response {
    if gate.active() {
        next.run(request).await
    } else {
        StatusCode::NOT_FOUND.into_response()
    }
}
