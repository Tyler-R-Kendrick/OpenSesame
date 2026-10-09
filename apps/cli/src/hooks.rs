//! `opensesame hooks` — `OpenSesame` as an agent-hooks/0.1 interceptor
//! (ADR 0159).
//!
//! An agent framework that implements agent-hooks builds an `AgentContext` at
//! each point of its loop and asks its interceptors for a `Verdict`. A host
//! whose interceptors live out of process runs `opensesame hooks intercept`
//! once per emission: the context on standard input, the verdict on standard
//! output, one JSON document each. The command needs no Host, no daemon and
//! no network — the judgement is the local policy file and the secret guard —
//! unless an approver is configured, below.
//!
//! `opensesame hooks policy get|put` reads and replaces the organization's
//! policy on the Host instead, for hosts that ask the Host's remote
//! interceptor rather than running this command, and `opensesame hooks
//! approver get|put` says who the Host asks when that policy escalates.
//!
//! With `--approver-url`, `--approver-ref` and the requester's bearer in
//! `OPENSESAME_HOOK_APPROVER_BEARER`, `intercept` puts an escalation to that
//! person itself and answers with the outcome ([`approval`]).
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
        /// Put an escalation to a person instead of returning it.
        #[command(flatten)]
        approver: approval::ApproverArgs,
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
    /// The audit of every verdict the Host's remote interceptor answered,
    /// newest first, value-blind (no tool names, targets or messages).
    Decisions(decisions::DecisionsArgs),
    /// Who the Host puts the organization's escalated agent actions to
    /// (`GET|PUT /api/v1/agent-hooks/approver`).
    Approver {
        #[command(subcommand)]
        cmd: approver::ApproverCmd,
    },
}

#[path = "hooks_policy.rs"]
mod policy;

#[path = "hooks_decisions.rs"]
mod decisions;

#[path = "hooks_approver.rs"]
mod approver;

#[path = "hooks_approval.rs"]
mod approval;

fn load_policy(path: Option<&Path>) -> Result<HookPolicy> {
    let Some(path) = path else {
        return Ok(HookPolicy::default());
    };
    let text = std::fs::read_to_string(path)
        .with_context(|| format!("reading hook policy {}", path.display()))?;
    HookPolicy::parse(&text).with_context(|| format!("hook policy {}", path.display()))
}

async fn intercept(policy: Option<&Path>, approver: &approval::ApproverArgs) -> Result<()> {
    let interceptor = OpenSesameInterceptor::new(load_policy(policy)?);
    // A partial approver is refused here, before standard input is read.
    let approver = approval::Approver::from_args(approver)?;
    // One byte past the bound is enough to know it was exceeded; the
    // interceptor denies an oversized context rather than reading all of it.
    let mut bytes = Vec::new();
    std::io::stdin()
        .lock()
        .take(u64::try_from(MAX_CONTEXT_BYTES + 1)?)
        .read_to_end(&mut bytes)
        .context("reading the AgentContext from standard input")?;
    // The text is only kept when an approver might need it for an escalation.
    let kept = approver.as_ref().map(|_| bytes.clone());
    let mut verdict = verdict_for(&interceptor, bytes);
    if let (Some(approver), Some(bytes)) = (approver.as_ref(), kept) {
        if let Ok(text) = String::from_utf8(bytes) {
            verdict = approver.settle(verdict, &text).await;
        }
    }
    let mut out = std::io::stdout().lock();
    serde_json::to_writer(&mut out, &verdict)?;
    writeln!(out)?;
    Ok(())
}

/// The verdict for the bytes read from standard input. The size bound is
/// checked on the raw bytes, before any decoding: the read stops one byte past
/// the limit, so a context that is over it by trailing whitespace alone (or
/// that the cut splits mid-character) is the same oversized refusal, never a
/// parse of a truncated document.
fn verdict_for(interceptor: &OpenSesameInterceptor, bytes: Vec<u8>) -> Verdict {
    if bytes.len() > MAX_CONTEXT_BYTES {
        return Verdict::deny(
            Some(REASON_CONTEXT_UNREADABLE.into()),
            Some(format!(
                "context exceeds {MAX_CONTEXT_BYTES} bytes (agent-hooks/0.1 §12.3)"
            )),
        );
    }
    // Not UTF-8 is not JSON (RFC 8259 §8.1). Never repair it: a lossy
    // decode would put replacement characters into a transformed target.
    match String::from_utf8(bytes) {
        Ok(text) => interceptor.decide_json(&text),
        Err(_) => Verdict::deny(
            Some(REASON_CONTEXT_UNREADABLE.into()),
            Some("context is not UTF-8 JSON".into()),
        ),
    }
}

fn check(policy: Option<&Path>) -> Result<()> {
    let policy = load_policy(policy)?;
    let body = serde_json::json!({ "spec": SPEC_VERSION, "policy": policy });
    println!("{}", serde_json::to_string_pretty(&body)?);
    Ok(())
}

/// `opensesame hooks …`. Only `policy` and `decisions` talk to the Host at
/// `server`.
pub async fn run(server: &str, cmd: HooksCmd) -> Result<()> {
    match cmd {
        HooksCmd::Intercept { policy, approver } => intercept(policy.as_deref(), &approver).await,
        HooksCmd::Check { policy } => check(policy.as_deref()),
        HooksCmd::Policy { cmd } => policy::run(server, cmd).await,
        HooksCmd::Decisions(args) => decisions::run(server, args).await,
        HooksCmd::Approver { cmd } => approver::run(server, cmd).await,
    }
}
