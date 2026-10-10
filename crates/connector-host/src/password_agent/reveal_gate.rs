//! Human-only plaintext reveal gate (shared conformance with `cli-reveal-gate.json`).
use std::io::{IsTerminal, Write};

use serde::Deserialize;

const SOURCE: &str = include_str!("../../../../spec/conformance/cli-reveal-gate.json");

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Policy {
    migration_hint: String,
    agent_context_env: Vec<AgentRule>,
}

#[derive(Debug, Deserialize)]
struct AgentRule {
    name: String,
    #[serde(rename = "match")]
    match_kind: String,
    value: Option<String>,
}

fn policy() -> &'static Policy {
    static POLICY: std::sync::OnceLock<Policy> = std::sync::OnceLock::new();
    POLICY.get_or_init(|| serde_json::from_str(SOURCE).expect("cli-reveal-gate.json"))
}

fn rule_matches(rule: &AgentRule) -> bool {
    let raw = std::env::var(&rule.name).ok();
    let Some(raw) = raw.filter(|v| !v.is_empty()) else {
        return false;
    };
    match rule.match_kind.as_str() {
        "nonEmpty" => true,
        "truthy" => {
            let normalized = raw.to_ascii_lowercase();
            normalized == "true" || normalized == "1" || normalized == "yes"
        }
        "equals" => rule.value.as_deref() == Some(raw.as_str()),
        _ => false,
    }
}

/// Refuse-only agent detection (spoofable; never used to allow reveal).
pub fn agent_context_detected() -> bool {
    policy().agent_context_env.iter().any(rule_matches)
}

#[derive(Clone, Copy, Debug)]
pub struct HumanRevealRequest<'a> {
    pub verb: &'static str,
    pub reveal: bool,
    pub desktop: bool,
    pub reference: Option<&'a str>,
    pub stdin_tty: Option<bool>,
    pub stdout_tty: Option<bool>,
}

fn stdin_tty(request: &HumanRevealRequest) -> bool {
    request
        .stdin_tty
        .unwrap_or_else(|| std::io::stdin().is_terminal())
}

fn stdout_tty(request: &HumanRevealRequest) -> bool {
    request
        .stdout_tty
        .unwrap_or_else(|| std::io::stdout().is_terminal())
}

fn refusal_message(request: &HumanRevealRequest<'_>) -> Option<String> {
    let policy = policy();
    if agent_context_detected() {
        return Some(format!(
            "Refusing plaintext {} in an agent context. {}",
            request.verb, policy.migration_hint
        ));
    }
    if !stdin_tty(request) || !stdout_tty(request) {
        return Some(format!(
            "Refusing plaintext {}: stdin and stdout must both be interactive terminals (no pipes or capture). {}",
            request.verb,
            policy.migration_hint
        ));
    }
    if !request.reveal {
        return Some(format!(
            "Refusing plaintext {}: pass --reveal after reviewing the risk. {}",
            request.verb, policy.migration_hint
        ));
    }
    if let Some(reference) = request.reference {
        if reference.starts_with("op://") && !request.desktop {
            return Some(
                "Refusing op:// reveal without --desktop (1Password app integration).".to_string(),
            );
        }
    }
    None
}

/// Gate for `password-agent read` / `env resolve` and sealed-store reveal.
///
/// # Errors
/// Returns an error when the request fails the human-only reveal policy.
pub fn assert_human_reveal(request: HumanRevealRequest<'_>) -> anyhow::Result<()> {
    if let Some(message) = refusal_message(&request) {
        anyhow::bail!("{message}");
    }
    Ok(())
}

/// Sealed-store plaintext (`pass show`, attach get, kdbx export).
///
/// # Errors
/// Returns an error unless a human explicitly reveals in an interactive terminal.
pub fn assert_pass_reveal(reveal: bool) -> anyhow::Result<()> {
    assert_human_reveal(HumanRevealRequest {
        verb: "pass-reveal",
        reveal,
        desktop: false,
        reference: None,
        stdin_tty: None,
        stdout_tty: None,
    })
}

/// Temporarily clears verified agent-context env markers (parity / unit tests).
pub struct AgentContextGuard {
    saved: Vec<(String, Option<String>)>,
}

impl AgentContextGuard {
    pub fn clear_markers() -> Self {
        let policy = policy();
        let mut saved = Vec::new();
        for rule in &policy.agent_context_env {
            saved.push((rule.name.clone(), std::env::var(&rule.name).ok()));
            std::env::remove_var(&rule.name);
        }
        Self { saved }
    }
}

impl Drop for AgentContextGuard {
    fn drop(&mut self) {
        for (name, prev) in &self.saved {
            match prev {
                Some(value) => std::env::set_var(name, value),
                None => std::env::remove_var(name),
            }
        }
    }
}

/// Strip verified agent markers from a subprocess (integration tests, parity fixtures).
pub fn strip_agent_context_env(command: &mut std::process::Command) {
    for rule in &policy().agent_context_env {
        command.env_remove(&rule.name);
    }
}

pub fn emit_reveal_receipt(verb: &'static str, reference: Option<&str>) {
    let receipt = serde_json::json!({
        "verb": verb,
        "lane": "reveal",
        "principal": "human",
        "agentContext": agent_context_detected(),
        "reference": reference,
        "at": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_secs())
            .to_string(),
    });
    let _ = writeln!(std::io::stderr(), "{receipt}");
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct TerminalState {
        stdin_tty: bool,
        stdout_tty: bool,
    }

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Case {
        id: String,
        #[serde(flatten)]
        terminal: TerminalState,
        reveal: bool,
        desktop: bool,
        agent_context: bool,
        reference: Option<String>,
        expect: String,
    }

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct FixtureCases {
        cases: Vec<Case>,
    }

    #[test]
    fn conformance_cases_match_ts_fixture() {
        let raw: FixtureCases = serde_json::from_str(SOURCE).unwrap();
        for case in raw.cases {
            let _guard = AgentContextGuard::clear_markers();
            if case.agent_context {
                std::env::set_var("OPENSESAME_AGENT_LAUNCH_HANDLE", "test-handle");
            }
            let request = HumanRevealRequest {
                verb: "read",
                reveal: case.reveal,
                desktop: case.desktop,
                reference: case.reference.as_deref(),
                stdin_tty: Some(case.terminal.stdin_tty),
                stdout_tty: Some(case.terminal.stdout_tty),
            };
            let refused = refusal_message(&request).is_some();
            match case.expect.as_str() {
                "refuse" => assert!(refused, "case {} should refuse", case.id),
                "allow" => assert!(!refused, "case {} should allow", case.id),
                other => panic!("unknown expect {other}"),
            }
        }
        std::env::remove_var("OPENSESAME_AGENT_LAUNCH_HANDLE");
        let _ = AgentContextGuard::clear_markers();
    }
}
