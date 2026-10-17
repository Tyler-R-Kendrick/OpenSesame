//! Broker mode of `run` (`run --agent-proxy`, R8 PR3 of #786): the
//! surrogate last-hop swap on the same `run` wrapper the inject lane uses.
//! Each `--env` assignment names an `os://` item under
//! `connections/<org>[/<project>]/<provider>`; the child receives a scoped
//! `osr_…` surrogate from the `surrogate-proxy` plugin (ADR 0150 §6.1) and
//! the run's proxy environment, and the credential itself travels only
//! from the sealed store to the plugin over its stdin pipe — for the
//! providers whose token is the connection's own. A provider the plugin
//! draws a credential for from a local tool is read from no store at all.
//!
//! Broker mode fails closed at every step the `dev run` lane degrades
//! quietly: an `op://` or non-connections reference, a missing or
//! unbounded `--paths`/`--methods` scope, a provider nothing can broker,
//! or a plugin that is not active ends the run before the child starts,
//! and no value is ever injected in a surrogate's place. The child is
//! supervised like a `dev run` child (a tripwire or a run-ending signal
//! stops it and revokes the run), and its output is masked like an inject
//! run's: the real values it never held, and the surrogates and proxy
//! credential it did, never reach the terminal or a log in the clear.

use super::os_child::pump_masked;
use super::os_run::LocalVault;
use crate::dev_run::credentials::{self, CredentialWire};
use crate::dev_run::{signal, supervise};
use crate::dev_surrogate::{self, SurrogateSession};
use opensesame_connector_host::password_agent::env as core;
use opensesame_session_observe::{end_and_revoke, RunCredentials};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    io::Write,
    process::{Command, Stdio},
};

/// The run-spec entries of a broker plan: the same wire shape the
/// `dev run` lane sends the plugin, at the `authorization` site every
/// provider this build brokers presents its token at.
pub(super) fn run_entries(plan: &[core::BrokerEntry]) -> Vec<Value> {
    plan.iter()
        .map(|entry| {
            json!({
                "env_var": entry.name,
                "provider_id": entry.provider_id,
                "connection_ref": entry.connection_ref,
                "site": "authorization",
                "methods": entry.methods,
                "path_prefixes": entry.path_prefixes,
            })
        })
        .collect()
}

/// What the child's output is masked for: the real values (defense in
/// depth — the child never held one, but an upstream echo must still not
/// reach a log) and everything the plugin put in the child's environment,
/// surrogates and the proxy credential included.
pub(super) fn mask_list(real: &[String], env: &BTreeMap<String, String>) -> Vec<String> {
    let mut masked: Vec<String> = real.to_vec();
    masked.extend(env.values().cloned());
    masked
}

pub(super) fn run_brokered(
    assignments: &[String],
    paths: &[String],
    methods: &[String],
    command: &[String],
    grant_approved: bool,
) -> anyhow::Result<()> {
    core::validate_run_assignments(assignments)?;
    if !grant_approved {
        crate::cli_app_integration::ensure_reveal("run", None)?;
    }
    let plan = core::broker_plan(assignments, paths, methods)?;
    // A provider with no credential source is refused before any secret
    // is read: starting the plugin for it could only end unserved.
    for entry in &plan {
        anyhow::ensure!(
            credentials::has_credential_source(&entry.provider_id),
            "{} cannot be brokered: the surrogate-proxy plugin brokers no '{}' connection; \
             nothing was injected",
            entry.name,
            entry.provider_id
        );
    }
    let (wires, real) = stored_credentials(&plan)?;
    let session = dev_surrogate::brokered(&run_entries(&plan), &wires)?;
    drop(wires);
    let secrets = mask_list(&real, session.env());
    drop(real);
    let mut stdout = std::io::stdout();
    let mut stderr = std::io::stderr();
    let end = spawn_supervised(
        command,
        session.env(),
        Some(&session),
        &secrets,
        &mut stdout,
        &mut stderr,
    );
    drop(session);
    let end = end?;
    end.report();
    if let Some(code) = end.exit_code() {
        std::process::exit(code);
    }
    Ok(())
}

/// One credential per brokered connection whose token is its own, read
/// from the sealed store through the same `os://` resolution the inject
/// lane uses. The second list is those values again, for masking.
fn stored_credentials(
    plan: &[core::BrokerEntry],
) -> anyhow::Result<(Vec<CredentialWire>, Vec<String>)> {
    let mut vault = LocalVault::new();
    let mut wires = Vec::new();
    let mut real = Vec::new();
    let mut seen: BTreeSet<&str> = BTreeSet::new();
    for entry in plan {
        if !credentials::needs_stored_credential(&entry.provider_id)
            || !seen.insert(&entry.connection_ref)
        {
            continue;
        }
        let value = vault.resolve(&entry.reference)?;
        real.push(value.as_str().to_string());
        wires.push(CredentialWire::new(entry.connection_ref.clone(), value));
    }
    Ok((wires, real))
}

/// Spawn the brokered child with the plugin's environment, pipe its
/// output through the masker, and supervise it to its end: the
/// `dev run` watch (tripwire, `SIGTERM`/`SIGHUP`) over the inject lane's
/// masked pipes. The provider token, interpreter startup hooks and the
/// store password never enter the child.
pub(super) fn spawn_supervised(
    command: &[String],
    env: &BTreeMap<String, String>,
    session: Option<&SurrogateSession>,
    secrets: &[String],
    stdout: &mut (dyn Write + Send),
    stderr: &mut (dyn Write + Send),
) -> anyhow::Result<supervise::RunEnd> {
    let (program, args) = command
        .split_first()
        .ok_or_else(|| anyhow::anyhow!("A child command is required"))?;
    let mut child_command = Command::new(program);
    child_command
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    child_command.env_remove("OP_SERVICE_ACCOUNT_TOKEN");
    child_command.env_remove("OPENSESAME_STORE_PASSWORD");
    for key in
        &opensesame_connector_host::password_agent::policy::policy().credential_startup_env_keys
    {
        child_command.env_remove(key);
    }
    for (key, _) in std::env::vars_os() {
        if key.to_str().is_some_and(core::credential_startup_key) {
            child_command.env_remove(key);
        }
    }
    child_command.envs(env);
    let handlers = signal::install()?;
    let run_end = run_child(&mut child_command, session, secrets, stdout, stderr);
    handlers.release(matches!(
        run_end,
        Ok(supervise::RunEnd::Signalled { .. } | supervise::RunEnd::Tripped { .. })
    ));
    run_end
}

fn run_child(
    child_command: &mut Command,
    session: Option<&SurrogateSession>,
    secrets: &[String],
    stdout: &mut (dyn Write + Send),
    stderr: &mut (dyn Write + Send),
) -> anyhow::Result<supervise::RunEnd> {
    // A signal that came while the plugin was starting is honoured before
    // the child exists, not after it has been given an environment to use.
    if let Some(signal) = signal::pending() {
        let revoked = session.map_or(0, |session| {
            let ended: &dyn RunCredentials = session;
            end_and_revoke(session.run_id(), ended)
        });
        return Ok(supervise::RunEnd::Signalled {
            signal,
            revoked,
            killed: false,
            child_started: false,
        });
    }
    let mut child = child_command
        .spawn()
        .map_err(|_| anyhow::anyhow!("The child command could not be started"))?;
    let mut out_pipe = child.stdout.take();
    let mut err_pipe = child.stderr.take();
    let mut out_mask = core::SecretMasker::new(secrets);
    let mut err_mask = core::SecretMasker::new(secrets);
    let end = std::thread::scope(|scope| {
        let out_thread = scope.spawn(|| match (&mut out_pipe, &mut *stdout) {
            (Some(pipe), writer) => pump_masked(pipe, writer, &mut out_mask),
            (None, _) => Ok(()),
        });
        let err_thread = scope.spawn(|| match (&mut err_pipe, &mut *stderr) {
            (Some(pipe), writer) => pump_masked(pipe, writer, &mut err_mask),
            (None, _) => Ok(()),
        });
        let end = supervise::supervise_until(
            &mut child,
            session,
            &signal::pending,
            supervise::STOP_GRACE,
        );
        let _ = out_thread.join();
        let _ = err_thread.join();
        end
    })?;
    Ok(end)
}

#[cfg(test)]
#[path = "os_broker_tests.rs"]
mod tests;
