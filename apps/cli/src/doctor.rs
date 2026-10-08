//! Local health checks — no Host, Identity, or daemon HTTP.

use std::path::Path;

use opensesame_gateway::bindings_for_relay;
use opensesame_sealed_store::resolve_store_dir;
use serde_json::json;

/// `opensesame doctor` — sealed store, optional relay bindings, crypto tools.
pub fn run(output: &str) -> anyhow::Result<()> {
    let path = resolve_store_dir();
    let exists = path.is_dir();
    let sealed_store = json!({
        "path": path.display().to_string(),
        "exists": exists,
        "writable": exists && path_is_writable(&path),
    });

    let relay_bindings = std::env::var("OPENSESAME_SERVICE_BINDINGS_FILE")
        .ok()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .map(|body| bindings_for_relay(Some(&body)).is_ok())
        .unwrap_or(true);

    let relay_env = json!({
        "vault_relay_url": std::env::var("OPENSESAME_VAULT_RELAY_URL").ok(),
        "service_bindings_file": std::env::var("OPENSESAME_SERVICE_BINDINGS_FILE").ok(),
        "bindings_valid": relay_bindings,
    });

    let age = which("age");
    let gpg = which("gpg");

    let report = json!({
        "profile": "local",
        "sealed_store": sealed_store,
        "relay": relay_env,
        "crypto_tools": {
            "age": age,
            "gpg": gpg,
        },
        "headless": std::env::var("SSH_CONNECTION").is_ok()
            || std::env::var("CODESPACES").is_ok()
            || std::env::var("DEVCONTAINER").is_ok(),
    });

    if output == "json" {
        println!("{}", serde_json::to_string_pretty(&report)?);
    } else {
        println!("{report}");
    }
    Ok(())
}

fn path_is_writable(path: &Path) -> bool {
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path.join(format!(".doctor-write-{}", std::process::id())))
        .map(|file| {
            drop(file);
            let _ = std::fs::remove_file(path.join(format!(".doctor-write-{}", std::process::id())));
            true
        })
        .unwrap_or(false)
}

fn which(name: &str) -> bool {
    std::process::Command::new("sh")
        .arg("-c")
        .arg(format!("command -v {name}"))
        .output()
        .is_ok_and(|out| out.status.success())
}
