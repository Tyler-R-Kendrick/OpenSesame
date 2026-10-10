//! Human-only plaintext reveal gate (shared conformance with `cli-reveal-gate.json`).
use std::io::{IsTerminal, Write};

use serde::Deserialize;

const SOURCE: &str = include_str!("../../../../spec/conformance/cli-reveal-gate.json");

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Policy {
    migration_hint: String,
}

fn policy() -> &'static Policy {
    static POLICY: std::sync::OnceLock<Policy> = std::sync::OnceLock::new();
    POLICY.get_or_init(|| serde_json::from_str(SOURCE).expect("cli-reveal-gate.json"))
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

fn static_refusal(request: &HumanRevealRequest<'_>) -> Option<String> {
    let policy = policy();
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
    if let Some(message) = static_refusal(&request) {
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

pub fn emit_reveal_receipt(verb: &'static str, reference: Option<&str>) {
    let receipt = serde_json::json!({
        "verb": verb,
        "lane": "reveal",
        "principal": "human",
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
            let request = HumanRevealRequest {
                verb: "read",
                reveal: case.reveal,
                desktop: case.desktop,
                reference: case.reference.as_deref(),
                stdin_tty: Some(case.terminal.stdin_tty),
                stdout_tty: Some(case.terminal.stdout_tty),
            };
            let refused = static_refusal(&request).is_some();
            match case.expect.as_str() {
                "refuse" => assert!(refused, "case {} should refuse", case.id),
                "allow" => assert!(!refused, "case {} should allow static checks", case.id),
                other => panic!("unknown expect {other}"),
            }
        }
    }
}
