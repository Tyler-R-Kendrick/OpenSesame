//! Surrogate delivery for `opensesame dev run --agent`, through the optional
//! `surrogate-proxy` plugin (ADR 0150 §6.1, §7).
//!
//! This binary links no proxy. When the plugin is **active** — installed,
//! switched on, not forced off — and its binary still hashes to its install
//! pin, it is spawned for the run: it receives the run spec for the
//! placeholder entries and web logins on its stdin and answers with the
//! child's environment (surrogates, the run CA's trust variables, the proxy
//! variables). After that it writes event lines — a tripwire that revoked
//! the run, a login's outcome — which [`crate::dev_run::supervise`] acts on. The
//! run ends when this process closes the plugin's stdin: when the child
//! exits, when a tripwire stops it, and — because the kernel closes the pipe
//! for a process that dies — when this process is killed by a signal too.
//!
//! - **Not installed, or not switched on:** nothing changes. The placeholders
//!   are delivered as before, a web login delivers nothing, and one line on
//!   stderr says the plugin exists.
//! - **Switched on, but the binary no longer matches its pin, or is gone:**
//!   the run fails. Falling back silently would mean the person who asked for
//!   surrogates is running with placeholders and does not know it.

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use opensesame_env_spec::ResolvedEnvEntry;
use opensesame_plugin_settings::{
    default_settings_path, notices_path, PluginSettings, SettingsError,
};
use opensesame_session_observe::RunCredentials;
use serde::Serialize;
use serde_json::Value;
use zeroize::Zeroizing;

#[cfg(test)]
pub(crate) use crate::dev_run::entries::provider_of;
pub(crate) use crate::dev_run::entries::run_entries;
use crate::dev_run::login::{self, LoginSource, LoginWire};

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
    child: Mutex<Child>,
    stdin: Mutex<Option<ChildStdin>>,
    run_id: String,
    env: BTreeMap<String, String>,
    unserved: Vec<String>,
    events: Receiver<Value>,
}

impl std::fmt::Debug for SurrogateSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SurrogateSession")
            .field("run_id", &self.run_id)
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

    pub(crate) fn run_id(&self) -> &str {
        &self.run_id
    }

    /// The plugin's event lines, as they arrive.
    pub(crate) fn events(&self) -> &Receiver<Value> {
        &self.events
    }

    /// Close the plugin's stdin and wait for it to revoke and exit.
    fn end(&self) {
        drop(lock(&self.stdin).take());
        let mut child = lock(&self.child);
        let deadline = Instant::now() + EXIT_GRACE;
        while Instant::now() < deadline {
            if matches!(child.try_wait(), Ok(Some(_))) {
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// The session is the run's credentials on this side of the pipe: revoking
/// them ends the plugin's run, which revokes every surrogate and login it
/// issued before its listener stops.
impl RunCredentials for SurrogateSession {
    fn revoke(&self, run_id: &str) -> usize {
        if run_id != self.run_id {
            return 0;
        }
        let live = lock(&self.stdin).is_some();
        self.end();
        if live {
            self.env.values().filter(|v| v.starts_with("osr_")).count()
        } else {
            0
        }
    }
}

impl Drop for SurrogateSession {
    fn drop(&mut self) {
        self.end();
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Surrogates for `entries`' placeholders and web logins from the plugin, or
/// `None` when the run keeps its placeholders.
///
/// # Errors
///
/// When the plugin is active but its binary fails its pin or is missing, a
/// web login cannot be read or bound to its origin, or the plugin cannot
/// start the run.
pub(crate) fn for_run(
    entries: &[ResolvedEnvEntry],
    logins: &dyn LoginSource,
) -> anyhow::Result<Option<SurrogateSession>> {
    let env = |key: &str| std::env::var(key).ok();
    let settings_path = default_settings_path().ok();
    let session = start(entries, settings_path.as_deref(), &env, logins)?;
    let web_logins = login::declared(entries);
    match &session {
        Some(session) if !session.unserved().is_empty() => eprintln!(
            "opensesame: no surrogate for {}; delivering placeholders for those",
            session.unserved().join(", ")
        ),
        Some(_) => {}
        None if run_entries(entries).is_empty() && web_logins.is_empty() => {}
        None if is_active(settings_path.as_deref(), &env) => eprintln!(
            "opensesame: the surrogate-proxy plugin brokers none of these connections; \
             delivering placeholders"
        ),
        None => eprintln!("{HINT}"),
    }
    if session.is_none() && !web_logins.is_empty() {
        let names: Vec<&str> = web_logins.iter().map(|(name, _)| *name).collect();
        eprintln!(
            "opensesame: {} delivered nothing: a web login is only ever a surrogate from the \
             surrogate-proxy plugin",
            names.join(", ")
        );
    }
    Ok(session)
}

fn is_active(settings_path: Option<&Path>, env: &dyn Fn(&str) -> Option<String>) -> bool {
    settings_path
        .and_then(|path| PluginSettings::load(path).ok())
        .and_then(|settings| settings.state(PLUGIN_ID, env).ok())
        .is_some_and(|state| state.active)
}

/// The one line the plugin reads. It carries login passwords, so it is
/// serialized straight into a zeroizing buffer and written to the pipe.
#[derive(Serialize)]
struct RunSpecWire<'a> {
    run_id: &'a str,
    ttl_secs: u64,
    entries: &'a [Value],
    logins: &'a [LoginWire],
    passthrough_hosts: [&'a str; 0],
    watched: bool,
    notices_path: &'a Path,
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
    logins: &dyn LoginSource,
) -> anyhow::Result<Option<SurrogateSession>> {
    let requested = run_entries(entries);
    let web_logins = login::declared(entries);
    let Some(settings_path) = settings_path else {
        return Ok(None);
    };
    if requested.is_empty() && web_logins.is_empty() {
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
    // Only now, with a plugin that will take them, are passwords read.
    let logins = login::resolve(&web_logins, logins)?;
    let run_id = format!("dev-{}", uuid::Uuid::new_v4().hyphenated());
    let notices = notices_path(settings_path, PLUGIN_ID)?;
    let mut line = Zeroizing::new(Vec::new());
    serde_json::to_writer(
        &mut *line,
        &RunSpecWire {
            run_id: &run_id,
            ttl_secs: RUN_TTL_SECS,
            entries: &requested,
            logins: &logins,
            passthrough_hosts: [],
            watched: true,
            notices_path: &notices,
        },
    )?;
    drop(logins);
    line.push(b'\n');
    let session = spawn(&binary, &line, run_id)?;
    drop(line);
    // Nothing this build can broker: the proxy would only refuse the child's
    // traffic, so the run keeps its placeholders (dropping ends the run).
    let served = !web_logins.is_empty()
        || requested.iter().any(|entry| {
            entry["env_var"]
                .as_str()
                .is_some_and(|var| !session.unserved.iter().any(|u| u == var))
        });
    if !served {
        return Ok(None);
    }
    Ok(Some(session))
}

fn spawn(binary: &Path, line: &[u8], run_id: String) -> anyhow::Result<SurrogateSession> {
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
    let (reply, events) = read_lines(child.stdout.take())?;
    let mut session = SurrogateSession {
        child: Mutex::new(child),
        stdin: Mutex::new(None),
        run_id,
        env: BTreeMap::new(),
        unserved: Vec::new(),
        events,
    };
    if let Some(pipe) = stdin.as_mut() {
        pipe.write_all(line)?;
        pipe.flush()?;
    }
    *lock(&session.stdin) = stdin;
    let reply = await_reply(&reply)?;
    if let Some(class) = reply.get("error").and_then(Value::as_str) {
        anyhow::bail!("{}", refusal(class));
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

/// What a refusal class means to the person who ran the command.
fn refusal(class: &str) -> String {
    match class.strip_prefix("spec_path_scope:") {
        Some(var) => format!(
            "the surrogate-proxy plugin refused the run and issued nothing: {var} has no bounded \
             scope. Declare what the child may reach on its env-spec entry, for example \
             paths=\"/repos/acme,/user\" (and methods=\"GET\"); the root is not a scope"
        ),
        None => format!("the surrogate-proxy plugin refused the run: {class}"),
    }
}

/// One thread reads the plugin's stdout for the life of the run: the first
/// line is the reply, every later one an event.
fn read_lines(
    stdout: Option<std::process::ChildStdout>,
) -> anyhow::Result<(Receiver<std::io::Result<String>>, Receiver<Value>)> {
    let stdout = stdout.ok_or_else(|| anyhow::anyhow!("the plugin has no stdout"))?;
    let (reply, first) = mpsc::channel();
    let (event, events) = mpsc::channel();
    std::thread::spawn(move || {
        let mut lines = BufReader::new(stdout).lines();
        let _ = reply.send(lines.next().unwrap_or_else(|| Ok(String::new())));
        lines
            .map_while(Result::ok)
            .filter_map(|line| serde_json::from_str::<Value>(&line).ok())
            .try_for_each(|value| event.send(value))
    });
    Ok((first, events))
}

fn await_reply(first: &Receiver<std::io::Result<String>>) -> anyhow::Result<Value> {
    let line = first
        .recv_timeout(REPLY_TIMEOUT)
        .map_err(|_| anyhow::anyhow!("the surrogate-proxy plugin did not answer"))??;
    serde_json::from_str(&line)
        .map_err(|_| anyhow::anyhow!("the surrogate-proxy plugin answered malformed"))
}

#[cfg(test)]
#[path = "dev_surrogate_tests.rs"]
pub(crate) mod tests;
