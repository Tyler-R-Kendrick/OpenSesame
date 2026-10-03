//! One run, start to finish: read the spec, open the run, reply, serve until
//! told to stop, then revoke and clean up.
//!
//! The run ends on the first of: the parent closing the plugin's stdin (which
//! the kernel does for it when the parent exits for any reason, a signal
//! included), `SIGTERM`/`SIGINT` to the plugin, or the run's TTL. Every exit
//! path revokes through the run lease's own mechanism —
//! [`end_and_revoke`] over the registry, which is [`SurrogateRuns::end_run`]:
//! the surrogates and logins are revoked before the listener stops — and
//! removes the run's CA file. While it runs, a misdirected surrogate revokes
//! the run in place ([`crate::RunRevoker`]) and the parent hears it as an
//! event line ([`super::events`]).

use std::collections::BTreeMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use opensesame_invoke_through::Invoker;
use opensesame_plugin_settings::plugin_state_dir;
use opensesame_rotation_web::DeclareError;
use opensesame_session_observe::end_and_revoke;
use secrecy::ExposeSecret;
use serde_json::Value;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::mpsc::UnboundedReceiver;
use zeroize::Zeroizing;

use super::events;
use super::gate::{Admitted, PLUGIN_ID};
use super::notices::{create_private_dir, NoticeLog};
use super::source::CliTokenSource;
use super::wire::{self, ErrorReply, RunReply, SpecError, MAX_SPEC_BYTES};
use crate::{LoginError, ProviderSources, ProxyConfig, RunHandle, SurrogateRuns};

/// Why a run ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stopped {
    /// The parent closed stdin.
    InputClosed,
    /// The embedder's stop signal fired.
    Signalled,
    /// The run's TTL elapsed.
    Expired,
}

/// Why a run never started. A class the parent reads; never a value.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct StartError(pub String);

impl From<SpecError> for StartError {
    fn from(error: SpecError) -> Self {
        Self(error.class())
    }
}

/// What the run is served with. Production is [`ServeOptions::production`];
/// tests pin the broker to a stub.
pub struct ServeOptions {
    pub invoker: Arc<Invoker>,
    /// The environment snapshot provider tools are scrubbed from.
    pub env: BTreeMap<String, String>,
}

impl ServeOptions {
    /// invoke-through's own egress rules and this process's environment.
    #[must_use]
    pub fn production() -> Self {
        Self {
            invoker: Arc::new(Invoker::new()),
            env: std::env::vars().collect(),
        }
    }
}

/// Serve one run over `input`/`output`, ending on `stop`, TTL or EOF.
///
/// # Errors
///
/// A [`StartError`] when the run could not start; it has already been written
/// to `output` as an error line.
pub async fn serve<R, W, S>(
    admitted: &Admitted,
    options: ServeOptions,
    mut input: R,
    mut output: W,
    stop: S,
) -> Result<Stopped, StartError>
where
    R: AsyncBufRead + Unpin,
    W: AsyncWrite + Unpin,
    S: Future<Output = ()>,
{
    let mut run = match start(admitted, &options, &mut input).await {
        Ok(run) => run,
        Err(error) => {
            let _ = write_line(
                &mut output,
                &ErrorReply {
                    error: error.0.clone(),
                },
            )
            .await;
            return Err(error);
        }
    };
    let outcome = match reply(&run) {
        Ok(reply) => match write_line(&mut output, &reply).await {
            Ok(()) => Ok(wait(&mut input, &mut output, &mut run.events, stop, run.ttl).await),
            Err(_) => Err(StartError("reply_unwritable".into())),
        },
        Err(error) => {
            let _ = write_line(
                &mut output,
                &ErrorReply {
                    error: error.clone(),
                },
            )
            .await;
            Err(StartError(error))
        }
    };
    end_and_revoke(run.handle.run_id(), &run.runs);
    run.notices.flush_and_close();
    let _ = std::fs::remove_dir_all(&run.run_dir);
    outcome
}

/// A run that has started and not yet ended.
struct Started {
    runs: SurrogateRuns,
    handle: RunHandle,
    notices: Arc<NoticeLog>,
    events: UnboundedReceiver<Value>,
    unserved: Vec<String>,
    run_dir: PathBuf,
    ttl: Duration,
}

async fn start<R>(
    admitted: &Admitted,
    options: &ServeOptions,
    input: &mut R,
) -> Result<Started, StartError>
where
    R: AsyncBufRead + Unpin,
{
    let line = read_spec(input).await?;
    let request = wire::parse_request(&line)?;
    drop(line);
    let (spec, unserved) = wire::to_run_spec(&request)?;
    drop(request.logins);
    let mut sources = ProviderSources::new();
    for grant in &spec.grants {
        if let Some(source) = CliTokenSource::for_provider(&grant.provider_id, &options.env) {
            sources = sources.with(&grant.provider_id, Arc::new(source));
        }
    }
    let notices = Arc::new(
        NoticeLog::open(&request.notices_path)
            .map_err(|_| StartError("notices_unwritable".into()))?,
    );
    let refusals: Arc<dyn crate::RefusalSink> = notices.clone();
    let (observer, events) = events::pipe();
    let config = ProxyConfig::new(Arc::clone(&options.invoker), Arc::new(sources), refusals)
        .with_observer(observer)
        .with_login_switch(admitted.state().clone());
    let runs = SurrogateRuns::new(config);
    let run_dir = plugin_state_dir(admitted.settings_path(), PLUGIN_ID)
        .map_err(|_| StartError("state_dir".into()))?
        .join("runs")
        .join(&request.run_id);
    let handle = runs
        .create_run(&request.run_id, &spec)
        .map_err(|error| StartError(run_error_class(&error).into()))?;
    Ok(Started {
        runs,
        handle,
        notices,
        events,
        unserved,
        run_dir,
        ttl: Duration::from_secs(request.ttl_secs),
    })
}

fn run_error_class(error: &crate::RunError) -> &'static str {
    use crate::RunError;
    match error {
        RunError::EmptyRunId => "spec_run_id",
        RunError::AlreadyActive(_) => "run_active",
        RunError::EnvVar(_) => "spec_env_var",
        RunError::PassthroughHost(_) => "spec_passthrough_host",
        RunError::Issue(_) => "spec_scope",
        RunError::Login(LoginError::Declare(DeclareError::PasswordSetField)) => {
            "login_password_set_field"
        }
        RunError::Login(LoginError::Declare(_)) => "login_declaration",
        RunError::Login(LoginError::NotArmed(_)) => "login_not_armed",
        RunError::Login(LoginError::Trust) => "login_trust",
        RunError::Certificate(_) => "run_certificate",
        RunError::Listener(_) => "run_listener",
    }
}

/// Write the CA certificate (never its key) and build the reply.
fn reply(run: &Started) -> Result<RunReply, String> {
    let ca_path = run.run_dir.join("ca.pem");
    create_private_dir(&run.run_dir).map_err(|_| "state_unwritable".to_owned())?;
    write_private_new(&ca_path, run.handle.ca_pem().as_bytes())
        .map_err(|_| "state_unwritable".to_owned())?;
    let mut env = BTreeMap::new();
    for (name, value) in run.handle.child_env(&ca_path) {
        let value = value
            .into_string()
            .map_err(|_| "state_path_not_utf8".to_owned())?;
        env.insert(name, value);
    }
    Ok(RunReply {
        proxy_url: run.handle.proxy_url().expose_secret().to_owned(),
        ca_pem_path: ca_path,
        env,
        unserved: run.unserved.clone(),
    })
}

fn write_private_new(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    // A file left by a run that died uncleanly is replaced, not appended to.
    let _ = std::fs::remove_file(path);
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)?.write_all(bytes)
}

/// The spec line, zeroized when dropped: a login's secret rides in it.
async fn read_spec<R: AsyncBufRead + Unpin>(
    input: &mut R,
) -> Result<Zeroizing<Vec<u8>>, StartError> {
    let mut line = Zeroizing::new(Vec::new());
    let limit = u64::try_from(MAX_SPEC_BYTES).unwrap_or(u64::MAX) + 1;
    (&mut *input)
        .take(limit)
        .read_until(b'\n', &mut line)
        .await
        .map_err(|_| StartError::from(SpecError::Malformed))?;
    if line.len() > MAX_SPEC_BYTES {
        return Err(SpecError::TooLarge.into());
    }
    if line.is_empty() {
        return Err(SpecError::Malformed.into());
    }
    Ok(line)
}

async fn write_line<W, T>(output: &mut W, value: &T) -> std::io::Result<()>
where
    W: AsyncWrite + Unpin,
    T: serde::Serialize,
{
    let mut bytes = serde_json::to_vec(value).map_err(std::io::Error::other)?;
    bytes.push(b'\n');
    output.write_all(&bytes).await?;
    output.flush().await
}

/// Serve until the run ends, writing each event line as it comes.
async fn wait<R, W, S>(
    input: &mut R,
    output: &mut W,
    events: &mut UnboundedReceiver<Value>,
    stop: S,
    ttl: Duration,
) -> Stopped
where
    R: AsyncBufRead + Unpin,
    W: AsyncWrite + Unpin,
    S: Future<Output = ()>,
{
    let drained = drain(input);
    let expired = tokio::time::sleep(ttl);
    tokio::pin!(drained, stop, expired);
    loop {
        tokio::select! {
            () = &mut drained => return Stopped::InputClosed,
            () = &mut stop => return Stopped::Signalled,
            () = &mut expired => return Stopped::Expired,
            Some(event) = events.recv() => {
                // A parent that stopped reading still has its run revoked;
                // the line is the report, not the revocation.
                let _ = write_line(output, &event).await;
            }
        }
    }
}

/// Read and discard until EOF: nothing after the spec means anything.
async fn drain<R: AsyncBufRead + Unpin>(input: &mut R) {
    let mut sink = [0_u8; 1024];
    loop {
        match input.read(&mut sink).await {
            Ok(0) | Err(_) => return,
            Ok(_) => {}
        }
    }
}
