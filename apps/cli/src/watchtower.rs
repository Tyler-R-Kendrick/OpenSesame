//! User-invoked local disk scan: SSH private keys and plaintext `.env` files.
//!
//! This is the CLI counterpart of 1Password Developer Watchtower. It reads
//! only metadata: paths, key type, encryption state, sensitive variable names.
//! A value, private key, passphrase or signature never enters the report.

use crate::watchtower_env::scan_env;
use crate::watchtower_scan::{home_default, scan_ssh};
use anyhow::Result;
use serde_json::json;
use std::path::PathBuf;

/// `opensesame security watchtower` — user-triggered local metadata scan.
pub fn run(home: Option<PathBuf>, ssh_only: bool, env_only: bool, output: &str) -> Result<()> {
    let home = home.unwrap_or_else(home_default);
    let with_ssh = !env_only;
    let with_env = !ssh_only;
    let ssh = if with_ssh {
        scan_ssh(&home.join(".ssh"))
    } else {
        Vec::new()
    };
    let env = if with_env {
        scan_env(&home)
    } else {
        Vec::new()
    };
    let body = json!({
        "ssh": ssh.iter().map(|f| json!({
            "path": f.path,
            "keyType": f.key_type,
            "bits": f.bits,
            "encrypted": f.encrypted,
            "finding": f.finding.as_str(),
        })).collect::<Vec<_>>(),
        "env": env.iter().map(|f| json!({
            "path": f.path,
            "sensitiveVariables": f.names,
        })).collect::<Vec<_>>(),
        "summary": {
            "sshKeys": ssh.len(),
            "envFiles": env.len(),
        }
    });
    if output == "json" {
        println!("{}", serde_json::to_string_pretty(&body)?);
        return Ok(());
    }
    if ssh.is_empty() && env.is_empty() {
        println!("No developer secrets found in the scanned locations.");
        return Ok(());
    }
    if !ssh.is_empty() {
        println!("SSH keys");
        println!(
            "{:<60} {:<12} {:>6} {:<10} FINDING",
            "PATH", "TYPE", "BITS", "ENCRYPTED"
        );
        for f in &ssh {
            println!(
                "{:<60} {:<12} {:>6} {:<10} {}",
                f.path,
                f.key_type,
                f.bits.map_or_else(|| "-".into(), |b| b.to_string()),
                if f.encrypted { "yes" } else { "no" },
                f.finding.label()
            );
        }
    }
    if !env.is_empty() {
        println!("\n.env files");
        println!("{:<80} SENSITIVE VARIABLES", "PATH");
        for f in &env {
            println!("{:<80} {}", f.path, f.names.join(", "));
        }
    }
    println!("\nMetadata only. No key, value or passphrase was read into this report.");
    Ok(())
}
