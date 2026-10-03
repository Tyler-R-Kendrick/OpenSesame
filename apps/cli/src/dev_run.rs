//! `opensesame dev check|resolve|run` (ADR 0006): env-spec delivery for a
//! child process.
//!
//! `dev run --agent` hands a child `ostest_…` placeholders for its
//! legacy-token connections. When the optional `surrogate-proxy` plugin is
//! installed and switched on, those placeholders are replaced by surrogates the
//! plugin redeems at the last hop (ADR 0150 §6.1, [`crate::dev_surrogate`]),
//! web logins (`opensesameLogin(…)`) become surrogates the plugin substitutes
//! into their one declared form field (§6.3, [`crate::dev_run::login`]), and a
//! misdirected surrogate stops the run (§6.2, [`crate::dev_run::supervise`]).
//! When it is not, the run is exactly what it was before the plugin existed,
//! plus one line saying the plugin exists; a web login delivers nothing.
//!
//! An agent child never inherits `OPENSESAME_STORE_PASSWORD`: this process
//! may unlock the sealed store with it, and the child is who the store is
//! kept from.

use std::path::Path;
use std::process::{Command, Stdio};

use clap::Subcommand;
use opensesame_domain::{CredentialDeliveryMode, DevDeliveryPolicy};
use opensesame_env_spec::{parse_schema_file, resolve_for_delivery, schema_summary};
use serde_json::json;

use crate::dev_surrogate;
use login::SealedStoreLogins;

#[path = "dev_entries.rs"]
pub(crate) mod entries;
#[path = "dev_login.rs"]
pub(crate) mod login;
#[path = "dev_supervise.rs"]
pub(crate) mod supervise;

/// What unlocks the sealed store non-interactively; never an agent's.
const STORE_PASSWORD_ENV: &str = "OPENSESAME_STORE_PASSWORD";

#[derive(Subcommand, Debug)]
pub(crate) enum DevCmd {
    /// Parse schema; print metadata without secrets.
    Check,
    /// Resolve env under delivery policy (redacted summary + projected values).
    Resolve,
    /// Run a child process with projected env (`opensesame dev run -- npm run dev`).
    Run {
        #[arg(trailing_var_arg = true, allow_hyphen_values = true, required = true)]
        args: Vec<String>,
    },
}

fn policy(agent: bool) -> DevDeliveryPolicy {
    if agent {
        DevDeliveryPolicy::agent_default()
    } else {
        DevDeliveryPolicy::development_default()
    }
}

pub(crate) fn dev_cmd(cmd: DevCmd, agent: bool, schema: &Path) -> anyhow::Result<()> {
    let doc =
        parse_schema_file(schema).map_err(|e| anyhow::anyhow!("env-spec parse failed: {e}"))?;
    match cmd {
        DevCmd::Check => {
            println!("{}", serde_json::to_string_pretty(&schema_summary(&doc))?);
        }
        DevCmd::Resolve => {
            let policy = policy(agent);
            let entries = resolve_for_delivery(&doc, &policy, agent)
                .map_err(|e| anyhow::anyhow!("resolve failed: {e}"))?;
            println!(
                "{}",
                serde_json::to_string_pretty(&json!({
                    "agent": agent,
                    "policy_denies_materialize": !policy.allows(CredentialDeliveryMode::Materialize),
                    "summary": schema_summary(&doc),
                    "entries": entries,
                }))?
            );
        }
        DevCmd::Run { args } => {
            let Some((program, rest)) = args.split_first() else {
                anyhow::bail!("usage: opensesame dev run [--agent] -- <cmd>");
            };
            let entries = resolve_for_delivery(&doc, &policy(agent), agent)
                .map_err(|e| anyhow::anyhow!("resolve failed: {e}"))?;
            let mut child = Command::new(program);
            child.args(rest);
            if agent {
                child.env_remove(STORE_PASSWORD_ENV);
            }
            for e in entries.iter().filter(|entry| !entry.omitted) {
                if let Some(v) = &e.env_value {
                    child.env(&e.key, v);
                }
            }
            // Surrogates, when the plugin is on, override the placeholders
            // set above; otherwise nothing changes. The session is dropped —
            // and the run revoked — before this process can exit.
            let session = if agent {
                dev_surrogate::for_run(&entries, &SealedStoreLogins::default())?
            } else {
                None
            };
            if let Some(session) = &session {
                child.envs(session.env());
            }
            child
                .stdin(Stdio::inherit())
                .stdout(Stdio::inherit())
                .stderr(Stdio::inherit());
            let end = child
                .spawn()
                .and_then(|mut child| supervise::supervise(&mut child, session.as_ref()));
            drop(session);
            let end = end?;
            end.report();
            if let Some(code) = end.exit_code() {
                std::process::exit(code);
            }
        }
    }
    Ok(())
}
