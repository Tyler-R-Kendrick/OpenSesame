//! Connector discovery for this machine (ADR 0047).
//!
//! Reports which providers *look* configured here — a provider-shaped
//! environment variable, a provider dotfile, an MCP server declared in a
//! client config — so the operator can decide whether to promote any of them
//! into a broker connection. It offers; it never imports.
//!
//! The response is value-blind by contract: a provider id and the name of the
//! variable, file, or server that matched. No values, no masked prefixes, and
//! no lengths — a prefix narrows an offline guess, and "it starts with
//! `sk_live_`" is itself a disclosure. Nothing here opens a network connection
//! or writes state, and there is deliberately no "test this credential"
//! action, because a test is an oracle.

use opensesame_connection_detect::{mcp_server_names, scan, Detection, Source, SourceKind};
use serde::Serialize;
use std::path::PathBuf;
use std::{env, fs};

/// Largest config file worth parsing. Matches the broker's credential bound.
const MAX_CONFIG_BYTES: u64 = 8 * 1024;

/// MCP client configurations, relative to `$HOME` unless already absolute.
const MCP_CONFIG_PATHS: &[&str] = &[
    ".mcp.json",
    ".cursor/mcp.json",
    ".codeium/windsurf/mcp_config.json",
    ".config/Claude/claude_desktop_config.json",
    "Library/Application Support/Claude/claude_desktop_config.json",
    "AppData/Roaming/Claude/claude_desktop_config.json",
];

#[derive(Debug, Serialize)]
pub struct DiscoveryReport {
    pub discovered: Vec<Detection>,
    /// Wording matters: detection is best effort in both directions.
    pub note: &'static str,
}

fn read_env(name: &str) -> Option<String> {
    env::var(name).ok().filter(|v| !v.is_empty())
}

fn read_file(path: &PathBuf) -> Option<String> {
    (fs::metadata(path).ok()?.len() <= MAX_CONFIG_BYTES)
        .then(|| fs::read_to_string(path).ok())?
}

/// MCP servers declared on this machine, as `Detection`s carrying names only.
///
/// These files routinely hold raw API keys inside each server's `env` block,
/// so only server names are read — never a value from that block.
fn scan_mcp(home: Option<&str>, read_file: &impl Fn(&PathBuf) -> Option<String>) -> Vec<Detection> {
    let mut out: Vec<Detection> = Vec::new();
    for relative in MCP_CONFIG_PATHS {
        let path = match home {
            Some(home) => PathBuf::from(home).join(relative),
            None => PathBuf::from(relative),
        };
        let Some(contents) = read_file(&path) else {
            continue;
        };
        for server in mcp_server_names(&contents) {
            let source = Source {
                kind: SourceKind::Mcp,
                name: format!("{relative}:{server}"),
            };
            match out.iter_mut().find(|d| d.provider_id == server) {
                Some(existing) => existing.sources.push(source),
                None => out.push(Detection {
                    provider_id: server,
                    sources: vec![source],
                }),
            }
        }
    }
    out
}

/// Scan this host with injected readers. The daemon passes the real process
/// environment; tests pass fixtures.
pub fn report_with(
    read_env: &impl Fn(&str) -> Option<String>,
    read_file: &impl Fn(&PathBuf) -> Option<String>,
) -> DiscoveryReport {
    let mut discovered = scan(read_env, read_file);
    let home = read_env("HOME");
    for mcp in scan_mcp(home.as_deref(), read_file) {
        match discovered.iter_mut().find(|d| d.provider_id == mcp.provider_id) {
            Some(existing) => existing.sources.extend(mcp.sources),
            None => discovered.push(mcp),
        }
    }
    discovered.sort_by(|a, b| a.provider_id.cmp(&b.provider_id));
    DiscoveryReport {
        discovered,
        note: "these look configured on this machine; promoting one is a separate, explicit step",
    }
}

/// Scan the daemon's real environment and home directory.
pub fn report() -> DiscoveryReport {
    report_with(&read_env, &read_file)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn files(pairs: Vec<(String, String)>) -> impl Fn(&PathBuf) -> Option<String> {
        move |path: &PathBuf| {
            pairs
                .iter()
                .find(|(p, _)| PathBuf::from(p) == *path)
                .map(|(_, c)| c.clone())
        }
    }

    #[test]
    fn adversarial_report_never_carries_a_planted_secret() {
        let stripe = "PLANTED-STRIPE-VALUE-MUST-NOT-ESCAPE";
        let github = "PLANTED-GITHUB-VALUE-MUST-NOT-ESCAPE";
        let mcp_token = "PLANTED-MCP-ENV-VALUE-MUST-NOT-ESCAPE";
        let env = |name: &str| match name {
            "HOME" => Some("/home/tester".to_string()),
            "STRIPE_SECRET_KEY" => Some(stripe.to_string()),
            "GITHUB_TOKEN" => Some(github.to_string()),
            _ => None,
        };
        let config = format!(
            r#"{{"mcpServers": {{"github": {{"command": "npx", "env": {{"GITHUB_TOKEN": "{mcp_token}"}}}}}}}}"#
        );
        let read_file = files(vec![("/home/tester/.mcp.json".into(), config)]);

        let report = report_with(&env, &read_file);
        let rendered = serde_json::to_string(&report).expect("serializable");

        assert!(rendered.contains("stripe"), "{rendered}");
        assert!(rendered.contains("STRIPE_SECRET_KEY"));
        assert!(rendered.contains(".mcp.json:github"));
        // The contract this route lives or dies by.
        assert!(!rendered.contains(stripe));
        assert!(!rendered.contains(github));
        assert!(!rendered.contains(mcp_token));
    }

    #[test]
    fn contract_a_clean_machine_reports_nothing() {
        let env = |name: &str| (name == "HOME").then(|| "/home/tester".to_string());
        let report = report_with(&env, &files(vec![]));
        assert!(report.discovered.is_empty());
    }

    #[test]
    fn property_mcp_servers_merge_into_an_existing_provider() {
        let env = |name: &str| match name {
            "HOME" => Some("/home/tester".to_string()),
            "GITHUB_TOKEN" => Some("ghp_x".to_string()),
            _ => None,
        };
        let read_file = files(vec![(
            "/home/tester/.mcp.json".into(),
            r#"{"mcpServers": {"github": {"command": "npx"}}}"#.into(),
        )]);
        let report = report_with(&env, &read_file);
        let github: Vec<_> = report
            .discovered
            .iter()
            .filter(|d| d.provider_id == "github")
            .collect();
        assert_eq!(github.len(), 1, "one entry per provider");
        assert!(github[0].sources.iter().any(|s| s.kind == SourceKind::Env));
        assert!(github[0].sources.iter().any(|s| s.kind == SourceKind::Mcp));
    }
}
