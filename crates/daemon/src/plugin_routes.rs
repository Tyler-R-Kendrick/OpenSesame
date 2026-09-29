//! Settings for optional, runtime-installed plugins (ADR 0150 §7).
//!
//! ```text
//! GET  /v1/plugins                -> {"plugins":[PluginState,…]}  (catalog order)
//! PUT  /v1/plugins/{id}           {"enabled":bool} -> PluginState
//!                                  | 404 not_installed | 400 unknown_plugin
//! GET  /v1/plugins/{id}/notices   -> {"notices":[…]} newest first, at most 50
//! ```
//!
//! Every route takes the operator token (or the Unix-socket peer check) and
//! refuses a browser, like every other operator route. They read and write the
//! one settings file `crates/plugin-settings` owns, so Settings and
//! `opensesame plugins enable|disable` edit the same bytes. Installing is not
//! here: it downloads and pins an executable, which is a person at a
//! terminal (`opensesame plugins install`), never an HTTP call.
//!
//! The daemon links no plugin. The notices route reads the file the plugin
//! writes at `<dir of plugins.json>/plugin-state/<id>/notices.jsonl`, keeps
//! five fields of each line, and drops any line that names the surrogate
//! marker at all — the plugin already vets every field, and this is the same
//! fence again at the last place a notice leaves the machine's owner.

use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};

use axum::{
    extract::{DefaultBodyLimit, Path as UrlPath, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use opensesame_plugin_settings::{
    catalog, default_settings_path, notices_path, PluginSettings, SettingsError,
    NOTICES_ROTATED_FILE,
};
use serde::Deserialize;
use serde_json::{json, Map, Value};

use crate::{require_operator, App, UdsPeer};

/// Most notices one response carries.
pub(crate) const MAX_NOTICES: usize = 50;
/// Most bytes read from the end of one notices file.
const MAX_NOTICE_BYTES: u64 = 2 * 1024 * 1024;

type EnvReader = Arc<dyn Fn(&str) -> Option<String> + Send + Sync>;

/// Where the settings file is, what the environment says, and one lock so two
/// toggles cannot interleave a read-modify-write.
#[derive(Clone)]
pub(crate) struct PluginHost {
    settings_path: Option<PathBuf>,
    env: EnvReader,
    write: Arc<Mutex<()>>,
}

impl PluginHost {
    /// This process's settings file and environment.
    pub(crate) fn from_process() -> Self {
        Self::at(
            default_settings_path().ok(),
            Arc::new(|key: &str| std::env::var(key).ok()),
        )
    }

    pub(crate) fn at(settings_path: Option<PathBuf>, env: EnvReader) -> Self {
        Self {
            settings_path,
            env,
            write: Arc::new(Mutex::new(())),
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Toggle {
    enabled: bool,
}

pub(crate) fn routes() -> Router<App> {
    Router::new()
        .route("/v1/plugins", get(list_plugins))
        .route(
            "/v1/plugins/{id}",
            axum::routing::put(set_plugin).layer(DefaultBodyLimit::max(1024)),
        )
        .route("/v1/plugins/{id}/notices", get(plugin_notices))
}

fn error(status: StatusCode, code: &str) -> Response {
    (status, Json(json!({ "error": code }))).into_response()
}

fn settings_path(host: &PluginHost) -> Result<&Path, Response> {
    host.settings_path.as_deref().ok_or_else(|| {
        error(
            StatusCode::SERVICE_UNAVAILABLE,
            "plugin_settings_unavailable",
        )
    })
}

fn load(path: &Path) -> Result<PluginSettings, Response> {
    PluginSettings::load(path).map_err(|_| {
        error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "plugin_settings_unreadable",
        )
    })
}

fn is_catalog_id(id: &str) -> bool {
    catalog().iter().any(|plugin| plugin.id == id)
}

async fn list_plugins(State(st): State<App>, uds: UdsPeer, headers: HeaderMap) -> Response {
    if let Err(resp) = require_operator(&st, &headers, &uds) {
        return resp;
    }
    let host = &st.plugins;
    let settings = match settings_path(host).and_then(load) {
        Ok(settings) => settings,
        Err(resp) => return resp,
    };
    let states = settings.states(|key| (host.env)(key));
    Json(json!({ "plugins": states })).into_response()
}

async fn set_plugin(
    State(st): State<App>,
    uds: UdsPeer,
    headers: HeaderMap,
    UrlPath(id): UrlPath<String>,
    Json(toggle): Json<Toggle>,
) -> Response {
    if let Err(resp) = require_operator(&st, &headers, &uds) {
        return resp;
    }
    if !is_catalog_id(&id) {
        return error(StatusCode::BAD_REQUEST, "unknown_plugin");
    }
    let host = &st.plugins;
    let path = match settings_path(host) {
        Ok(path) => path,
        Err(resp) => return resp,
    };
    let _guard = host.write.lock().unwrap_or_else(PoisonError::into_inner);
    let mut settings = match load(path) {
        Ok(settings) => settings,
        Err(resp) => return resp,
    };
    match settings.set_enabled(&id, toggle.enabled) {
        Ok(()) => {}
        Err(SettingsError::NotInstalled(_)) => {
            return error(StatusCode::NOT_FOUND, "not_installed")
        }
        Err(_) => return error(StatusCode::BAD_REQUEST, "unknown_plugin"),
    }
    if settings.save(path).is_err() {
        return error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "plugin_settings_unwritable",
        );
    }
    match settings.state(&id, |key| (host.env)(key)) {
        Ok(state) => Json(state).into_response(),
        Err(_) => error(StatusCode::BAD_REQUEST, "unknown_plugin"),
    }
}

async fn plugin_notices(
    State(st): State<App>,
    uds: UdsPeer,
    headers: HeaderMap,
    UrlPath(id): UrlPath<String>,
) -> Response {
    if let Err(resp) = require_operator(&st, &headers, &uds) {
        return resp;
    }
    if !is_catalog_id(&id) {
        return error(StatusCode::BAD_REQUEST, "unknown_plugin");
    }
    let file = match settings_path(&st.plugins).map(|path| notices_path(path, &id)) {
        Ok(Ok(file)) => file,
        Ok(Err(_)) => return error(StatusCode::BAD_REQUEST, "unknown_plugin"),
        Err(resp) => return resp,
    };
    match tokio::task::spawn_blocking(move || recent_notices(&file)).await {
        Ok(notices) => Json(json!({ "notices": notices })).into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

/// The newest [`MAX_NOTICES`] notices across the file and its rotation.
#[must_use]
pub fn recent_notices(file: &Path) -> Vec<Value> {
    let mut notices = Vec::new();
    for path in [
        file.to_path_buf(),
        file.with_file_name(NOTICES_ROTATED_FILE),
    ] {
        let text = read_tail(&path);
        for line in text.lines().rev() {
            if notices.len() == MAX_NOTICES {
                return notices;
            }
            if let Some(notice) = project(line) {
                notices.push(notice);
            }
        }
    }
    notices
}

/// Up to [`MAX_NOTICE_BYTES`] from the end of `path`, from a line boundary.
fn read_tail(path: &Path) -> String {
    let Ok(mut file) = std::fs::File::open(path) else {
        return String::new();
    };
    let len = file.metadata().map_or(0, |meta| meta.len());
    let start = len.saturating_sub(MAX_NOTICE_BYTES);
    if file.seek(SeekFrom::Start(start)).is_err() {
        return String::new();
    }
    let mut bytes = Vec::new();
    if file.take(MAX_NOTICE_BYTES).read_to_end(&mut bytes).is_err() {
        return String::new();
    }
    let text = String::from_utf8_lossy(&bytes).into_owned();
    if start == 0 {
        return text;
    }
    // The first line was cut; drop it rather than parse half a notice.
    text.split_once('\n')
        .map(|(_, rest)| rest.to_owned())
        .unwrap_or_default()
}

/// Five fields of one notice line, or `None` when it is not a notice or names
/// the surrogate marker anywhere.
pub(crate) fn project(line: &str) -> Option<Value> {
    if line.to_ascii_lowercase().contains("osr_") {
        return None;
    }
    let value: Value = serde_json::from_str(line).ok()?;
    let mut out = Map::new();
    for key in ["event_type", "severity", "occurred_at", "summary"] {
        out.insert(
            key.into(),
            Value::String(value.get(key)?.as_str()?.to_owned()),
        );
    }
    if let Some(subject) = value.get("subject_id").and_then(Value::as_str) {
        out.insert("subject_id".into(), Value::String(subject.to_owned()));
    }
    Some(Value::Object(out))
}

#[cfg(test)]
#[path = "plugin_routes_tests.rs"]
mod tests;
