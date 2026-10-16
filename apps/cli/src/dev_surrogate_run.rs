//! Starting one plugin run for [`super`]: the verified binary, the
//! spec line, and the fail-closed broker entry `run --agent-proxy`
//! drives. Split from the session so each file stays reviewable.

use std::path::Path;

use super::{
    default_settings_path, notices_path, spawn, CredentialWire, LoginWire, PluginSettings,
    RunSpecWire, SettingsError, SurrogateSession, Value, Zeroizing, PLUGIN_ID, RUN_TTL_SECS,
};

/// The plugin's binary, still hashing to its install pin.
///
/// # Errors
///
/// When the binary no longer matches its pin, or cannot be located.
pub(super) fn verified_plugin(
    settings: &PluginSettings,
    env: &dyn Fn(&str) -> Option<String>,
) -> anyhow::Result<std::path::PathBuf> {
    settings
        .verified_binary(PLUGIN_ID, env)
        .map_err(|error| match error {
            SettingsError::PinMismatch { .. } => anyhow::anyhow!(
                "the surrogate-proxy plugin no longer matches its install pin; \
                 reinstall it or run 'opensesame plugins disable surrogate-proxy'"
            ),
            other => anyhow::anyhow!("the surrogate-proxy plugin cannot be run: {other}"),
        })
}

/// Write one run spec to a freshly spawned plugin and take its session.
///
/// # Errors
///
/// When the plugin cannot start, does not answer, or refuses the run.
pub(super) fn spawn_run(
    binary: &Path,
    run_id: String,
    entries: &[Value],
    logins: &[LoginWire],
    credentials: &[CredentialWire],
    notices: &Path,
) -> anyhow::Result<SurrogateSession> {
    let mut line = Zeroizing::new(Vec::new());
    serde_json::to_writer(
        &mut *line,
        &RunSpecWire {
            run_id: &run_id,
            ttl_secs: RUN_TTL_SECS,
            entries,
            logins,
            credentials,
            passthrough_hosts: [],
            watched: true,
            notices_path: notices,
        },
    )?;
    line.push(b'\n');
    let session = spawn(binary, &line, run_id)?;
    drop(line);
    Ok(session)
}

const BROKER_PLUGIN_REQUIRED: &str = "--agent-proxy needs the surrogate-proxy plugin installed \
    and switched on ('opensesame plugins install surrogate-proxy --from <path-or-https-url> \
    --sha256 <hex>', then 'opensesame plugins enable surrogate-proxy'); nothing was injected";

/// Surrogates for a `run --agent-proxy` broker plan, or an error. Unlike
/// [`for_run`], broker mode was asked for by name, so every quiet outcome
/// there is a failure here: no plugin, a switched-off plugin, or a plugin
/// that serves none of the requested entries ends the run before the
/// child starts, and no value is ever injected in a surrogate's place.
///
/// # Errors
///
/// When the plugin is not active, fails its pin, cannot start the run, or
/// leaves any requested entry unserved.
pub(crate) fn brokered(
    entries: &[Value],
    credentials: &[CredentialWire],
) -> anyhow::Result<SurrogateSession> {
    let env = |key: &str| std::env::var(key).ok();
    let settings_path = default_settings_path().ok();
    start_brokered(entries, credentials, settings_path.as_deref(), &env)
}

/// [`brokered`] with the settings location and environment given.
///
/// # Errors
///
/// See [`brokered`].
pub(crate) fn start_brokered(
    entries: &[Value],
    credentials: &[CredentialWire],
    settings_path: Option<&Path>,
    env: &dyn Fn(&str) -> Option<String>,
) -> anyhow::Result<SurrogateSession> {
    anyhow::ensure!(!entries.is_empty(), "{BROKER_PLUGIN_REQUIRED}");
    let Some(settings_path) = settings_path else {
        anyhow::bail!("{BROKER_PLUGIN_REQUIRED}");
    };
    let settings = PluginSettings::load(settings_path)
        .map_err(|_| anyhow::anyhow!("{BROKER_PLUGIN_REQUIRED}"))?;
    if !settings.state(PLUGIN_ID, env).is_ok_and(|s| s.active) {
        anyhow::bail!("{BROKER_PLUGIN_REQUIRED}");
    }
    let binary = verified_plugin(&settings, env)?;
    let run_id = format!("run-{}", uuid::Uuid::new_v4().hyphenated());
    let notices = notices_path(settings_path, PLUGIN_ID)?;
    let session = spawn_run(&binary, run_id, entries, &[], credentials, &notices)?;
    let unserved: Vec<&str> = entries
        .iter()
        .filter_map(|entry| entry["env_var"].as_str())
        .filter(|var| session.unserved.iter().any(|u| u == var) || !session.env.contains_key(*var))
        .collect();
    if !unserved.is_empty() {
        drop(session);
        anyhow::bail!(
            "the surrogate-proxy plugin brokers none of {}; nothing was injected",
            unserved.join(", ")
        );
    }
    Ok(session)
}
