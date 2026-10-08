//! Local breach checks (ADR 0080) — Pwned Passwords k-anonymity, no Host API.

use std::path::PathBuf;

use anyhow::Context;
use clap::Subcommand;
use opensesame_breach_intel::{occurrences, range_url, PwnedDigest, PADDING_HEADER, PADDING_VALUE};
use opensesame_sealed_store::list_names;
use serde_json::{json, Value};

use crate::store;

#[derive(Subcommand, Debug)]
pub enum SecurityCmd {
    /// Breach findings from the last local scan (metadata only).
    Findings {
        #[arg(long, default_value = "100")]
        limit: usize,
    },
    /// Scan the sealed store for compromised passwords.
    Scan {
        #[arg(long)]
        path: Option<PathBuf>,
        #[arg(long)]
        tomb: Option<String>,
    },
    /// Check one candidate secret before storing it (stdin or hidden prompt).
    Check {
        /// Store path label for the finding record.
        subject_id: String,
    },
}

pub async fn run(output: &str, cmd: SecurityCmd) -> anyhow::Result<()> {
    match cmd {
        SecurityCmd::Findings { limit } => cmd_findings(output, limit).await,
        SecurityCmd::Scan { path, tomb } => {
            cmd_scan(output, path.as_deref(), tomb.as_deref()).await
        }
        SecurityCmd::Check { subject_id } => cmd_check(output, &subject_id).await,
    }
}

fn findings_path() -> anyhow::Result<PathBuf> {
    let base = directories::ProjectDirs::from("com", "OpenSesame", "opensesame")
        .ok_or_else(|| anyhow::anyhow!("could not resolve config directory"))?
        .config_dir()
        .join("breach-findings.json");
    Ok(base)
}

async fn cmd_findings(output: &str, limit: usize) -> anyhow::Result<()> {
    let path = findings_path()?;
    let body: Value = if path.is_file() {
        serde_json::from_slice(&std::fs::read(&path)?)?
    } else {
        json!({ "findings": [] })
    };
    if output == "json" {
        return crate::print_output(output, &body);
    }
    let rows = body
        .get("findings")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if rows.is_empty() {
        println!("No local breach findings. Run: opensesame security scan");
        return Ok(());
    }
    for row in rows.iter().take(limit) {
        println!(
            "{}  {}  count={}",
            row.get("subject_id").and_then(Value::as_str).unwrap_or("-"),
            row.get("state").and_then(Value::as_str).unwrap_or("-"),
            row.get("occurrences").and_then(Value::as_u64).unwrap_or(0),
        );
    }
    Ok(())
}

async fn cmd_check(output: &str, subject_id: &str) -> anyhow::Result<()> {
    let secret = store::prompt_secret_hidden("Secret to check")?;
    if secret.is_empty() {
        anyhow::bail!("no secret provided");
    }
    let count = pwned_count(&secret).await?;
    let state = if count > 0 { "compromised" } else { "clear" };
    let finding = json!({
        "subject_id": subject_id,
        "subject_kind": "store_path",
        "state": state,
        "occurrences": count,
    });
    if output == "json" {
        crate::print_output(output, &finding)?;
    } else if count > 0 {
        println!("Compromised ({count} occurrences in Pwned Passwords).");
    } else {
        println!("Not found in Pwned Passwords.");
    }
    append_finding(&finding)?;
    Ok(())
}

async fn cmd_scan(
    output: &str,
    path: Option<&std::path::Path>,
    tomb: Option<&str>,
) -> anyhow::Result<()> {
    let root = store::resolve_root(path, tomb)?;
    let (opened, store_key) = store::open_unlocked(path, tomb)?;
    let names = list_names(&root, "")?;
    let scanned = names.len();
    let mut published = 0u64;
    let mut findings = Vec::new();
    for name in &names {
        let entry = opened.show(name, &store_key)?;
        let secret = entry.secret;
        if secret.is_empty() {
            continue;
        }
        let count = pwned_count(&secret).await?;
        if count > 0 {
            published += 1;
            let row = json!({
                "subject_id": name,
                "subject_kind": "store_path",
                "state": "compromised",
                "occurrences": count,
            });
            findings.push(row);
        }
    }
    let path = findings_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(
        &path,
        serde_json::to_vec_pretty(&json!({ "findings": findings }))?,
    )?;
    if output == "json" {
        crate::print_output(
            output,
            &json!({ "published": published, "scanned": scanned }),
        )?;
    } else {
        println!("Scanned {scanned} entries; {published} compromised.");
    }
    Ok(())
}

fn append_finding(row: &Value) -> anyhow::Result<()> {
    let path = findings_path()?;
    let mut body: Value = if path.is_file() {
        serde_json::from_slice(&std::fs::read(&path)?)?
    } else {
        json!({ "findings": [] })
    };
    if let Some(list) = body.get_mut("findings").and_then(Value::as_array_mut) {
        list.push(row.clone());
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, serde_json::to_vec_pretty(&body)?)?;
    Ok(())
}

async fn pwned_count(secret: &str) -> anyhow::Result<u64> {
    let digest = PwnedDigest::of_secret(secret);
    let url = range_url(&digest);
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(15))
        .build()?;
    let response = client
        .get(&url)
        .header(PADDING_HEADER, PADDING_VALUE)
        .send()
        .await
        .context("Pwned Passwords range request failed")?
        .error_for_status()?;
    let body = response.text().await?;
    Ok(occurrences(&body, &digest))
}
