//! `.env` file scan: names only, never values.

use super::scan::{small_file, walk};
use std::path::Path;

const ENV_DEPTH: usize = 4;
const ENV_ROOTS: &[&str] = &[
    "code",
    "dev",
    "Developer",
    "git",
    "projects",
    "Projects",
    "repos",
    "src",
    "work",
];

pub struct EnvFinding {
    pub path: String,
    pub names: Vec<String>,
}

fn sensitive_name(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    [
        "TOKEN",
        "SECRET",
        "PASSWORD",
        "PASSWD",
        "API_KEY",
        "PRIVATE_KEY",
        "ACCESS_KEY",
        "CLIENT_SECRET",
        "CREDENTIAL",
        "AUTH",
        "WEBHOOK",
    ]
    .iter()
    .any(|needle| upper.contains(needle))
}

fn env_names(text: &str) -> Vec<String> {
    let mut names = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        let key = key.strip_prefix("export ").unwrap_or(key).trim_start();
        let value = value.trim().trim_matches(['"', '\'']);
        if key.is_empty() || value.is_empty() || !sensitive_name(key) {
            continue;
        }
        names.push(key.to_owned());
    }
    names.sort();
    names.dedup();
    names
}

pub(crate) fn scan_env(home: &Path) -> Vec<EnvFinding> {
    let mut findings = Vec::new();
    for root_name in ENV_ROOTS {
        let root = home.join(root_name);
        let mut files = Vec::new();
        walk(
            &root,
            0,
            ENV_DEPTH,
            &[".git", "node_modules", "target", "vendor"],
            &mut files,
        );
        for path in files {
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if name != ".env" && !name.starts_with(".env.") {
                continue;
            }
            let Some(text) = small_file(&path) else {
                continue;
            };
            let names = env_names(&text);
            if !names.is_empty() {
                findings.push(EnvFinding {
                    path: path.display().to_string(),
                    names,
                });
            }
        }
    }
    findings.sort_by(|a, b| a.path.cmp(&b.path));
    findings
}
