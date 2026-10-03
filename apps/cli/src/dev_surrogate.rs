//! Surrogate delivery for `opensesame dev run --agent`, through the optional
//! `surrogate-proxy` plugin (ADR 0150 §6.1, §7).
//!
//! This binary links no proxy. When the plugin is **active** — installed,
//! switched on, not forced off — and its binary still hashes to its install
//! pin, it is spawned for the run: it receives the run spec for the
//! placeholder entries on its stdin and answers with the child's environment
//! (surrogates, the run CA's trust variables, the proxy variables). The run
//! ends when this process closes the plugin's stdin: when the child exits,
//! and — because the kernel closes the pipe for a process that dies — when
//! this process is killed by a signal too.
//!
//! - **Not installed, or not switched on:** nothing changes. The placeholders
//!   are delivered as before, and one line on stderr says the plugin exists.
//! - **Switched on, but the binary no longer matches its pin, or is gone:**
//!   the run fails. Falling back silently would mean the person who asked for
//!   surrogates is running with placeholders and does not know it.

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use opensesame_domain::{CredentialDeliveryMode, PlaceholderLocation};
use opensesame_env_spec::ResolvedEnvEntry;
use opensesame_plugin_settings::{
    default_settings_path, notices_path, PluginSettings, SettingsError,
};
use serde_json::{json, Value};

/// The catalog id of the plugin this module drives.
pub(crate) const PLUGIN_ID: &str = "surrogate-proxy";
/// How long a dev run's surrogates live, run end aside.
const RUN_TTL_SECS: u64 = 12 * 60 * 60;
/// How long the plugin has to answer the spec.
const REPLY_TIMEOUT: Duration = Duration::from_secs(20);
/// How long it has to revoke and exit once its stdin closes.
const EXIT_GRACE: Duration = Duration::from_secs(5);

pub(crate) const HINT: &str = "opensesame: surrogate delivery is available as an optional plugin \
     ('opensesame plugins install surrogate-proxy --from <path-or-https-url> --sha256 <hex>'); \
     delivering placeholders";

/// A live plugin run. Dropping it closes the plugin's stdin, which ends the
/// run: every surrogate is revoked and the listener stops.
pub(crate) struct SurrogateSession {
    child: Child,
    stdin: Option<ChildStdin>,
    env: BTreeMap<String, String>,
    unserved: Vec<String>,
}

impl std::fmt::Debug for SurrogateSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SurrogateSession")
            .field("vars", &self.env.keys().collect::<Vec<_>>())
            .field("unserved", &self.unserved)
            .finish_non_exhaustive()
    }
}

impl SurrogateSession {
    /// The child's environment additions. Values include surrogates and the
    /// run's proxy credential: they go to the child and nowhere else.
    pub(crate) fn env(&self) -> &BTreeMap<String, String> {
        &self.env
    }

    pub(crate) fn unserved(&self) -> &[String] {
        &self.unserved
    }
}

impl Drop for SurrogateSession {
    fn drop(&mut self) {
        drop(self.stdin.take());
        let deadline = Instant::now() + EXIT_GRACE;
        while Instant::now() < deadline {
            if matches!(self.child.try_wait(), Ok(Some(_))) {
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Surrogates for `entries`' placeholders from the plugin, or `None` when the
/// run keeps its placeholders.
///
/// # Errors
///
/// When the plugin is active but its binary fails its pin or is missing, or
/// it cannot start the run.
pub(crate) fn for_run(entries: &[ResolvedEnvEntry]) -> anyhow::Result<Option<SurrogateSession>> {
    let env = |key: &str| std::env::var(key).ok();
    let settings_path = default_settings_path().ok();
    let session = start(entries, settings_path.as_deref(), &env)?;
    match &session {
        Some(session) if !session.unserved().is_empty() => eprintln!(
            "opensesame: no surrogate for {}; delivering placeholders for those",
            session.unserved().join(", ")
        ),
        Some(_) => {}
        None if run_entries(entries).is_empty() => {}
        None if is_active(settings_path.as_deref(), &env) => eprintln!(
            "opensesame: the surrogate-proxy plugin brokers none of these connections; \
             delivering placeholders"
        ),
        None => eprintln!("{HINT}"),
    }
    Ok(session)
}

fn is_active(settings_path: Option<&Path>, env: &dyn Fn(&str) -> Option<String>) -> bool {
    settings_path
        .and_then(|path| PluginSettings::load(path).ok())
        .and_then(|settings| settings.state(PLUGIN_ID, env).ok())
        .is_some_and(|state| state.active)
}

/// [`for_run`] with the settings location and environment given.
///
/// # Errors
///
/// See [`for_run`].
pub(crate) fn start(
    entries: &[ResolvedEnvEntry],
    settings_path: Option<&Path>,
    env: &dyn Fn(&str) -> Option<String>,
) -> anyhow::Result<Option<SurrogateSession>> {
    let requested = run_entries(entries);
    let Some(settings_path) = settings_path else {
        return Ok(None);
    };
    if requested.is_empty() {
        return Ok(None);
    }
    // An unreadable settings file cannot say the plugin is on.
    let Ok(settings) = PluginSettings::load(settings_path) else {
        return Ok(None);
    };
    if !settings.state(PLUGIN_ID, env).is_ok_and(|s| s.active) {
        return Ok(None);
    }
    let binary = settings
        .verified_binary(PLUGIN_ID, env)
        .map_err(|error| match error {
            SettingsError::PinMismatch { .. } => anyhow::anyhow!(
                "the surrogate-proxy plugin no longer matches its install pin; \
                 reinstall it or run 'opensesame plugins disable surrogate-proxy'"
            ),
            other => anyhow::anyhow!("the surrogate-proxy plugin cannot be run: {other}"),
        })?;
    let spec = json!({
        "run_id": format!("dev-{}", uuid::Uuid::new_v4().hyphenated()),
        "ttl_secs": RUN_TTL_SECS,
        "entries": requested,
        "passthrough_hosts": [],
        "notices_path": notices_path(settings_path, PLUGIN_ID)?,
    });
    let session = spawn(&binary, &spec)?;
    // Nothing this build can broker: the proxy would only refuse the child's
    // traffic, so the run keeps its placeholders (dropping ends the run).
    let served = requested.iter().any(|entry| {
        entry["env_var"]
            .as_str()
            .is_some_and(|var| !session.unserved.iter().any(|u| u == var))
    });
    if !served {
        return Ok(None);
    }
    Ok(Some(session))
}

/// The run-spec entries for the placeholder deliveries a surrogate can
/// replace: a legacy-token projection placed in one header.
pub(crate) fn run_entries(entries: &[ResolvedEnvEntry]) -> Vec<Value> {
    entries
        .iter()
        .filter(|entry| entry.delivery == CredentialDeliveryMode::Placeholder && !entry.omitted)
        .filter_map(|entry| {
            let projection = entry.projection.as_ref()?;
            let connection_ref = entry.connection_ref.as_deref()?;
            let site = match projection.placement.locations.as_slice() {
                [PlaceholderLocation::Header { name }] => site_for(name.as_deref()),
                _ => return None,
            };
            Some(json!({
                "env_var": entry.key,
                "provider_id": provider_of(connection_ref)?,
                "connection_ref": connection_ref,
                "site": site,
                "methods": projection.placement.methods,
                "path_prefixes": ["/"],
            }))
        })
        .collect()
}

fn site_for(header: Option<&str>) -> String {
    match header {
        None => "authorization".to_owned(),
        Some(name) if name.eq_ignore_ascii_case("authorization") => "authorization".to_owned(),
        Some(name) => format!("header:{}", name.to_ascii_lowercase()),
    }
}

/// `github` from `conn://org[/project]/github[@vN]`: a connection's logical
/// name is its provider for the connections a surrogate can serve.
pub(crate) fn provider_of(connection_ref: &str) -> Option<String> {
    let rest = connection_ref.strip_prefix("conn://")?;
    let name = rest.rsplit('/').next()?;
    let name = name.split('@').next()?;
    (!name.is_empty() && rest.contains('/')).then(|| name.to_owned())
}

fn spawn(binary: &Path, spec: &Value) -> anyhow::Result<SurrogateSession> {
    let mut command = Command::new(binary);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    // Its own process group: a Ctrl-C meant for the child does not tear the
    // proxy down under it. The run still ends when this process goes away,
    // because its end of the plugin's stdin closes with it.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command
        .spawn()
        .map_err(|error| anyhow::anyhow!("the surrogate-proxy plugin did not start: {error}"))?;
    let mut stdin = child.stdin.take();
    let stdout = child.stdout.take();
    let mut session = SurrogateSession {
        child,
        stdin: None,
        env: BTreeMap::new(),
        unserved: Vec::new(),
    };
    let mut line = serde_json::to_vec(spec)?;
    line.push(b'\n');
    if let Some(pipe) = stdin.as_mut() {
        pipe.write_all(&line)?;
        pipe.flush()?;
    }
    session.stdin = stdin;
    let reply = read_reply(stdout)?;
    if let Some(class) = reply.get("error").and_then(Value::as_str) {
        anyhow::bail!("the surrogate-proxy plugin refused the run: {class}");
    }
    let env = reply
        .get("env")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow::anyhow!("the surrogate-proxy plugin sent no environment"))?;
    for (key, value) in env {
        if let Some(value) = value.as_str() {
            session.env.insert(key.clone(), value.to_owned());
        }
    }
    session.unserved = reply
        .get("unserved")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    Ok(session)
}

fn read_reply(stdout: Option<std::process::ChildStdout>) -> anyhow::Result<Value> {
    let stdout = stdout.ok_or_else(|| anyhow::anyhow!("the plugin has no stdout"))?;
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let mut line = String::new();
        let read = BufReader::new(stdout).read_line(&mut line);
        let _ = sender.send(read.map(|_| line));
    });
    let line = receiver
        .recv_timeout(REPLY_TIMEOUT)
        .map_err(|_| anyhow::anyhow!("the surrogate-proxy plugin did not answer"))??;
    serde_json::from_str(&line)
        .map_err(|_| anyhow::anyhow!("the surrogate-proxy plugin answered malformed"))
}

#[cfg(test)]
#[path = "dev_surrogate_tests.rs"]
mod tests;
