//! Automatic Host certificate issuance commands.
//!
//! The Host issues the certificate. This CLI never prints a private key unless
//! `--reveal` or `--out-dir` is given (human operator only).

use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
};

use crate::connect;

pub async fn cmd_ca(server: &str, output: &str, out: Option<PathBuf>) -> Result<()> {
    let body = connect::api(server, reqwest::Method::GET, "/api/v1/certs/ca", None).await?;
    let pem = body
        .pointer("/ca/certificate")
        .and_then(Value::as_str)
        .context("Host did not return a CA certificate")?;
    if let Some(path) = out {
        write_pem(&path, pem, 0o644)?;
        eprintln!("wrote {}", path.display());
    }
    if output == "json" {
        println!("{}", serde_json::to_string_pretty(&body)?);
    } else {
        print!("{pem}");
        if !pem.ends_with('\n') {
            println!();
        }
        eprintln!(
            "Trust this CA on this machine for local TLS. Do not ship it as a public trust root."
        );
    }
    Ok(())
}

pub async fn cmd_ls(server: &str, output: &str) -> Result<()> {
    let body = connect::api(server, reqwest::Method::GET, "/api/v1/certs", None).await?;
    if output == "json" {
        println!("{}", serde_json::to_string_pretty(&body)?);
        return Ok(());
    }
    let rows = body
        .get("certificates")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if rows.is_empty() {
        println!("No issued certificates on this Host.");
        return Ok(());
    }
    println!("{:<20} {:<18} SERIAL", "COMMON NAME", "EXPIRES");
    for row in rows {
        println!(
            "{:<20} {:<18} {}",
            row.get("common_name")
                .and_then(Value::as_str)
                .unwrap_or("-"),
            row.get("not_after").and_then(Value::as_str).unwrap_or("-"),
            row.get("serial").and_then(Value::as_str).unwrap_or("-"),
        );
    }
    Ok(())
}

pub struct IssueOptions {
    pub common_name: String,
    pub dns: Vec<String>,
    pub ips: Vec<String>,
    pub ttl_hours: u64,
    pub out_dir: Option<PathBuf>,
    pub reveal: bool,
}

pub async fn cmd_issue(server: &str, output: &str, options: IssueOptions) -> Result<()> {
    let IssueOptions {
        common_name,
        dns,
        ips,
        ttl_hours,
        out_dir,
        reveal,
    } = options;
    if out_dir.is_none() && !reveal {
        bail!("refusing to issue private-key material without --out-dir or --reveal");
    }
    let mut dns_names = dns;
    if dns_names.is_empty() {
        dns_names.push(common_name.clone());
    }
    let mut ip_addrs = ips;
    if ip_addrs.is_empty()
        && (common_name == "localhost" || dns_names.iter().any(|d| d == "localhost"))
    {
        ip_addrs.push("127.0.0.1".into());
    }
    let body = connect::api(
        server,
        reqwest::Method::POST,
        "/api/v1/certs/issue",
        Some(&json!({
            "common_name": common_name,
            "dns_names": dns_names,
            "ip_addrs": ip_addrs,
            "ttl_hours": ttl_hours,
        })),
    )
    .await?;
    let cert = body
        .get("certificate")
        .and_then(Value::as_str)
        .context("Host did not return a certificate")?;
    let key = body
        .get("private_key")
        .and_then(Value::as_str)
        .context("Host did not return a private key")?;
    let ca = body
        .get("ca_certificate")
        .and_then(Value::as_str)
        .unwrap_or("");
    let delivery_id = body.get("delivery_id").and_then(Value::as_str);

    if let Some(ref dir) = out_dir {
        fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
        let stem = sanitize_stem(&common_name);
        write_pem(&dir.join(format!("{stem}.crt.pem")), cert, 0o644)?;
        write_pem(&dir.join(format!("{stem}.key.pem")), key, 0o600)?;
        if !ca.is_empty() {
            write_pem(&dir.join("ca.crt.pem"), ca, 0o644)?;
        }
        eprintln!("wrote certs to {}", dir.display());
    }

    if output == "json" {
        let mut printed = body.clone();
        if !reveal && out_dir.is_some() {
            if let Some(obj) = printed.as_object_mut() {
                obj.insert(
                    "private_key".into(),
                    json!("[written to disk — pass --reveal to print]"),
                );
            }
        } else if !reveal {
            bail!("refusing to print a private key on stdout; pass --out-dir or --reveal");
        }
        println!("{}", serde_json::to_string_pretty(&printed)?);
        acknowledge_delivery(server, delivery_id).await?;
        return Ok(());
    }

    print!("{cert}");
    if !cert.ends_with('\n') {
        println!();
    }
    if reveal {
        eprint!("{key}");
        if !key.ends_with('\n') {
            eprintln!();
        }
    }
    acknowledge_delivery(server, delivery_id).await?;
    Ok(())
}

async fn acknowledge_delivery(server: &str, delivery_id: Option<&str>) -> Result<()> {
    if let Some(id) = delivery_id {
        connect::api(
            server,
            reqwest::Method::POST,
            &format!("/api/v1/certs/deliveries/{id}/ack"),
            None,
        )
        .await?;
    }
    Ok(())
}

fn sanitize_stem(cn: &str) -> String {
    let stem: String = cn
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if stem.is_empty() {
        "cert".into()
    } else {
        stem
    }
}

fn write_pem(path: &Path, pem: &str, mode: u32) -> Result<()> {
    fs::write(path, pem).with_context(|| format!("writing {}", path.display()))?;
    fs::set_permissions(path, fs::Permissions::from_mode(mode))?;
    Ok(())
}

/// `opensesame cert key` — collect a host-custody private key (ADR 0075).
///
/// The one certificate command that prints key material, and it requires
/// `--reveal` for the same reason `pass show` does: a private key should never
/// reach a terminal because someone tab-completed their way into it.
pub async fn cmd_key(
    server: &str,
    output: &str,
    id: &str,
    reveal: bool,
    out: Option<PathBuf>,
) -> Result<()> {
    if !reveal && out.is_none() {
        bail!("refusing to print a private key; pass --reveal or --out <path>");
    }
    let path = format!("/api/v1/certs/{id}/key");
    let body = connect::api(server, reqwest::Method::GET, &path, None).await?;
    let pem = body
        .get("private_key")
        .and_then(Value::as_str)
        .context("Host did not return a managed private key")?;
    if let Some(path) = out {
        write_pem(&path, pem, 0o600)?;
        eprintln!("wrote {}", path.display());
        return Ok(());
    }
    if output == "json" {
        println!("{}", serde_json::to_string_pretty(&body)?);
    } else {
        print!("{pem}");
        if !pem.ends_with('\n') {
            println!();
        }
    }
    Ok(())
}
