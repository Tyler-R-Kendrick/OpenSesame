//! No-arg interactive session, and the first-run setup ceremony (ADR 0154).
//!
//! Registry surface: `opensesame session`.
//!
//! The first-run folder is `{state}/.opensesame`, where `state` is
//! `OPENSESAME_CLI_STATE` or the CLI's own data directory. A `.opensesame`
//! directory in the working directory is the item-type marketplace and is
//! not a previous run.

use clap::Parser;
use std::ffi::OsString;
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::process::Command;

/// Optional extensions Default selects. Same ids as
/// `apps/pages/src/screens/setup/default-extensions.ts`.
const DEFAULT_EXTENSIONS: &[&str] = &[
    "access.authority",
    "connectors.external",
    "identity.federation",
    "identity.local-iam",
    "identity.siop",
    "vault.certificate-records",
    "vault.derived-records",
    "vault.passkey-records",
];

/// Roads on the capabilities tab (`CapabilitySetup` `ROADS`). Join is offered
/// there only when an instance already requires capabilities, so a first run
/// offers the other two.
const CAPABILITY_ROADS: &[&str] = &[
    "Use the minimal configuration",
    "Customize this installation",
];

/// Optional-tier capability ids the capabilities tab cards offer.
const OPTIONAL_CAPABILITIES: &[&str] = &[
    "identity.local-iam",
    "identity.siop",
    "vault.passkey-records",
    "vault.certificate-records",
    "connectors.external",
    "access.authority",
    "identity.federation",
    "identity.ambient-sso",
    "enterprise.directory-provisioning",
    "enterprise.ca-administration",
    "agents.surrogate-credentials",
    "vault.browser-autofill",
    "agents.webmcp",
    "support.local-ai",
    "ai.password-reset",
    "support.remote-ai",
    "wallet.spending",
    "notifications.web-push",
    "notifications.routing",
    "telemetry.external",
    "networking.tailnet",
    "vault.derived-records",
    "sharing.live",
    "sharing.household",
];

/// One-shot verbs return the parsed command. No arguments run the session
/// and do not return.
pub fn verb() -> anyhow::Result<crate::Cli> {
    let args = legacy_args();
    if args.len() < 2 {
        enter()?;
        std::process::exit(0);
    }
    Ok(crate::Cli::parse_from(args))
}

/// Globals that take a separate value. `--output json pass` is still `pass`.
const VALUE_FLAGS: &[&str] = &["--server", "--output"];

fn legacy_args() -> Vec<OsString> {
    let args: Vec<OsString> = std::env::args_os().collect();
    let Some(index) = verb_index(&args) else {
        return args;
    };
    let token = args[index].to_string_lossy();
    let Some(path) = legacy_path(token.as_ref()) else {
        return args;
    };
    let mut rewritten = Vec::with_capacity(args.len() + path.len());
    rewritten.extend(args[..index].iter().cloned());
    rewritten.extend(path.iter().map(OsString::from));
    rewritten.extend(args[index + 1..].iter().cloned());
    rewritten
}

fn verb_index(args: &[OsString]) -> Option<usize> {
    let mut index = 1;
    while index < args.len() {
        let arg = args[index].to_string_lossy();
        if arg == "--" {
            return (index + 1 < args.len()).then_some(index + 1);
        }
        let name = arg.split('=').next().unwrap_or(arg.as_ref());
        if VALUE_FLAGS.contains(&name) && !arg.contains('=') {
            index += 2;
            continue;
        }
        if arg.starts_with('-') {
            index += 1;
            continue;
        }
        return Some(index);
    }
    None
}

/// Former top-level verbs, now under vault, access, or identity.
fn legacy_path(token: &str) -> Option<&'static [&'static str]> {
    Some(match token {
        "local-authority" => &["access", "grants", "local-authority"],
        "lease" => &["access", "grants", "lease"],
        "task" => &["access", "grants", "task"],
        "intent" => &["access", "grants", "intent"],
        "receipt" => &["access", "sessions", "receipt"],
        "connect" => &["access", "connectors", "connect"],
        "connection" | "connector" => &["access", "connectors", "connection"],
        "export" => &["access", "connectors", "export"],
        "import" => &["access", "connectors", "import"],
        "rotate" => &["access", "connectors", "rotate"],
        "ceremony" => &["access", "connectors", "ceremony"],
        "invoke" => &["access", "resources", "invoke"],
        "cert" => &["access", "resources", "cert"],
        "lifecycle" => &["access", "resources", "lifecycle"],
        "status" => &["identity", "status"],
        "whoami" => &["identity", "whoami"],
        "auth" => &["identity", "auth"],
        "provider" => &["identity", "providers"],
        "vault-inspect" => &["vault", "inspect"],
        "vault-migrate" => &["vault", "migrate"],
        "pass" => &["vault", "pass"],
        "secret" => &["vault", "secret"],
        "sync" => &["vault", "sync"],
        "crypto" => &["vault", "crypto"],
        _ => return None,
    })
}

fn state_dir() -> anyhow::Result<PathBuf> {
    if let Some(value) = std::env::var_os("OPENSESAME_CLI_STATE") {
        return Ok(PathBuf::from(value));
    }
    let dirs = directories::ProjectDirs::from("dev", "OpenSesame", "opensesame")
        .ok_or_else(|| anyhow::anyhow!("no project dirs"))?;
    Ok(dirs.data_local_dir().join("cli"))
}

fn marker(state: &Path) -> PathBuf {
    state.join(".opensesame")
}

pub(crate) fn enter() -> anyhow::Result<()> {
    let state = state_dir()?;
    let stdin = std::io::stdin();
    let mut input = stdin.lock();
    if !marker(&state).is_dir() {
        let ready = ceremony(&state, &mut input)?;
        if !ready {
            return Ok(());
        }
    }
    session(&mut input)
}

fn ceremony(state: &Path, input: &mut impl BufRead) -> anyhow::Result<bool> {
    loop {
        say(&["Minimal", "Default", "Custom", "Skip"])?;
        let Some(line) = read_line(input)? else {
            return Ok(false);
        };
        match line.trim().to_ascii_lowercase().as_str() {
            "minimal" => {
                record(
                    state,
                    &serde_json::json!({"plan": "minimal", "optional": []}),
                )?;
                return Ok(true);
            }
            "default" => {
                record(
                    state,
                    &serde_json::json!({"plan": "default", "optional": DEFAULT_EXTENSIONS}),
                )?;
                return Ok(true);
            }
            "custom" => return custom(state, input),
            "skip" | "skip all" => {
                record(state, &serde_json::json!({"plan": "skip"}))?;
                return Ok(true);
            }
            _ => {}
        }
    }
}

fn custom(state: &Path, input: &mut impl BufRead) -> anyhow::Result<bool> {
    say(&["capabilities"])?;
    say(CAPABILITY_ROADS)?;
    say(&["finish"])?;
    let mut road: Option<&str> = None;
    loop {
        let Some(line) = read_line(input)? else {
            return Ok(false);
        };
        match line.trim().to_ascii_lowercase().as_str() {
            "use the minimal configuration" | "minimal" => road = Some("minimal"),
            "customize this installation" | "customize" => return customize(state, input),
            "finish" => {
                let body = match road {
                    Some(road) => {
                        serde_json::json!({"plan": "custom", "road": road, "optional": []})
                    }
                    None => serde_json::json!({"plan": "custom", "optional": []}),
                };
                record(state, &body)?;
                return Ok(true);
            }
            _ => {}
        }
    }
}

fn customize(state: &Path, input: &mut impl BufRead) -> anyhow::Result<bool> {
    say(OPTIONAL_CAPABILITIES)?;
    say(&["finish"])?;
    let mut chosen: Vec<&str> = Vec::new();
    loop {
        let Some(line) = read_line(input)? else {
            return Ok(false);
        };
        let line = line.trim();
        if line.eq_ignore_ascii_case("finish") {
            record(
                state,
                &serde_json::json!({"plan": "custom", "road": "customize", "optional": chosen}),
            )?;
            return Ok(true);
        }
        if let Some(id) = OPTIONAL_CAPABILITIES
            .iter()
            .copied()
            .find(|id| id.eq_ignore_ascii_case(line))
        {
            if !chosen.contains(&id) {
                chosen.push(id);
            }
        }
    }
}

fn session(input: &mut impl BufRead) -> anyhow::Result<()> {
    loop {
        say(&["opensesame>"])?;
        let Some(line) = read_line(input)? else {
            return Ok(());
        };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if line.eq_ignore_ascii_case("exit") || line.eq_ignore_ascii_case("quit") {
            return Ok(());
        }
        let words: Vec<String> = line.split_whitespace().map(str::to_string).collect();
        let _status = Command::new(std::env::current_exe()?)
            .args(&words)
            .status()?;
    }
}

fn record(state: &Path, body: &serde_json::Value) -> anyhow::Result<()> {
    let dir = marker(state);
    std::fs::create_dir_all(&dir)?;
    std::fs::write(dir.join("plan.json"), serde_json::to_vec(body)?)?;
    Ok(())
}

fn say(lines: &[&str]) -> anyhow::Result<()> {
    let mut output = std::io::stdout().lock();
    for line in lines {
        writeln!(output, "{line}")?;
    }
    output.flush()?;
    Ok(())
}

fn read_line(input: &mut impl BufRead) -> anyhow::Result<Option<String>> {
    let mut line = String::new();
    if input.read_line(&mut line)? == 0 {
        return Ok(None);
    }
    Ok(Some(line))
}
