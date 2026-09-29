//! `opensesame hooks` — `OpenSesame` as an agent-hooks/0.1 interceptor
//! (ADR 0150).
//!
//! An agent framework that implements agent-hooks builds an `AgentContext` at
//! each point of its loop and asks its interceptors for a `Verdict`. A host
//! whose interceptors live out of process runs `opensesame hooks intercept`
//! once per emission: the context on standard input, the verdict on standard
//! output, one JSON document each. The command needs no Host, no daemon and
//! no network — the judgement is the local policy file and the secret guard.
//!
//! `opensesame hooks policy get|put` reads and replaces the organization's
//! policy on the Host instead, for hosts that ask the Host's remote
//! interceptor rather than running this command.
//!
//! A failure to decide is never an `allow`. A context this command cannot read
//! is answered with a deny verdict; a policy it cannot load exits non-zero
//! with nothing on standard output, which a conformant host turns into
//! `deny host_error:interceptor_failed` (spec §6.3).

use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use clap::Subcommand;
use opensesame_agent_hooks::interceptor::{MAX_CONTEXT_BYTES, REASON_CONTEXT_UNREADABLE};
use opensesame_agent_hooks::sdk::Verdict;
use opensesame_agent_hooks::{HookPolicy, OpenSesameInterceptor, SPEC_VERSION};

#[derive(Subcommand, Debug)]
pub enum HooksCmd {
    /// Answer one interception: an agent-hooks/0.1 `AgentContext` on standard
    /// input, its `Verdict` on standard output.
    Intercept {
        /// Hook policy (JSON). Without one, every tool escalates and
        /// credential-shaped content is redacted.
        #[arg(long, env = "OPENSESAME_HOOK_POLICY")]
        policy: Option<PathBuf>,
    },
    /// Check a hook policy and print it with every default filled in.
    Check {
        /// Hook policy (JSON).
        #[arg(long, env = "OPENSESAME_HOOK_POLICY")]
        policy: Option<PathBuf>,
    },
    /// The organization's hook policy on the Host, which its remote
    /// interceptor (`POST /api/v1/agent-hooks/intercept`) decides under.
    Policy {
        #[command(subcommand)]
        cmd: policy::PolicyCmd,
    },
}

#[path = "hooks_policy.rs"]
mod policy;

fn load_policy(path: Option<&Path>) -> Result<HookPolicy> {
    let Some(path) = path else {
        return Ok(HookPolicy::default());
    };
    let text = std::fs::read_to_string(path)
        .with_context(|| format!("reading hook policy {}", path.display()))?;
    HookPolicy::parse(&text).with_context(|| format!("hook policy {}", path.display()))
}

fn intercept(policy: Option<&Path>) -> Result<()> {
    let interceptor = OpenSesameInterceptor::new(load_policy(policy)?);
    // One byte past the bound is enough to know it was exceeded; the
    // interceptor denies an oversized context rather than reading all of it.
    let mut bytes = Vec::new();
    std::io::stdin()
        .lock()
        .take(u64::try_from(MAX_CONTEXT_BYTES + 1)?)
        .read_to_end(&mut bytes)
        .context("reading the AgentContext from standard input")?;
    // Not UTF-8 is not JSON (RFC 8259 §8.1). Never repair it: a lossy
    // decode would put replacement characters into a transformed target.
    let verdict = match String::from_utf8(bytes) {
        Ok(text) => interceptor.decide_json(&text),
        Err(_) => Verdict::deny(
            Some(REASON_CONTEXT_UNREADABLE.into()),
            Some("context is not UTF-8 JSON".into()),
        ),
    };
    let mut out = std::io::stdout().lock();
    serde_json::to_writer(&mut out, &verdict)?;
    writeln!(out)?;
    Ok(())
}

fn check(policy: Option<&Path>) -> Result<()> {
    let policy = load_policy(policy)?;
    let body = serde_json::json!({ "spec": SPEC_VERSION, "policy": policy });
    println!("{}", serde_json::to_string_pretty(&body)?);
    Ok(())
}

/// `opensesame hooks …`. Only `policy` talks to the Host at `server`.
pub async fn run(server: &str, cmd: HooksCmd) -> Result<()> {
    match cmd {
        HooksCmd::Intercept { policy } => intercept(policy.as_deref()),
        HooksCmd::Check { policy } => check(policy.as_deref()),
        HooksCmd::Policy { cmd } => policy::run(server, cmd).await,
    }
}
