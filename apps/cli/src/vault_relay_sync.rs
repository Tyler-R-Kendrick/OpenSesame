//! Push/pull vault-relay snapshots (ADR 0181) — optional peer, not Host sync API.

use clap::Subcommand;
use opensesame_gateway::vault_relay::SNAPSHOT_FORMAT;
use serde_json::{json, Value};

#[derive(Subcommand)]
pub enum SyncCmd {
    /// Upload a sealed snapshot JSON to a paired relay.
    Push {
        file: std::path::PathBuf,
        #[arg(long)]
        base_url: String,
        #[arg(long)]
        owner: String,
        #[arg(long)]
        slug: String,
        #[arg(long)]
        slot_key: String,
        #[arg(long, default_value_t = 0)]
        expected_generation: u64,
        #[arg(long)]
        token: Option<String>,
        #[arg(long)]
        principal: Option<String>,
        #[arg(long)]
        owner_kind: Option<String>,
    },
    /// Download the relay snapshot to a file.
    Pull {
        output: std::path::PathBuf,
        #[arg(long)]
        base_url: String,
        #[arg(long)]
        owner: String,
        #[arg(long)]
        slug: String,
        #[arg(long)]
        slot_key: String,
        #[arg(long)]
        token: Option<String>,
        #[arg(long)]
        principal: Option<String>,
        #[arg(long)]
        owner_kind: Option<String>,
    },
}

impl std::fmt::Debug for SyncCmd {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Push {
                file,
                base_url,
                owner,
                slug,
                expected_generation,
                principal,
                owner_kind,
                ..
            } => f
                .debug_struct("Push")
                .field("file", file)
                .field("base_url", base_url)
                .field("owner", owner)
                .field("slug", slug)
                .field("slot_key", &"[REDACTED]")
                .field("expected_generation", expected_generation)
                .field("token", &"[REDACTED]")
                .field("principal", principal)
                .field("owner_kind", owner_kind)
                .finish(),
            Self::Pull {
                output,
                base_url,
                owner,
                slug,
                principal,
                owner_kind,
                ..
            } => f
                .debug_struct("Pull")
                .field("output", output)
                .field("base_url", base_url)
                .field("owner", owner)
                .field("slug", slug)
                .field("slot_key", &"[REDACTED]")
                .field("token", &"[REDACTED]")
                .field("principal", principal)
                .field("owner_kind", owner_kind)
                .finish(),
        }
    }
}

pub async fn run(cmd: SyncCmd) -> anyhow::Result<()> {
    match cmd {
        SyncCmd::Push {
            file,
            base_url,
            owner,
            slug,
            slot_key,
            expected_generation,
            token,
            principal,
            owner_kind,
        } => {
            let snapshot: Value = serde_json::from_slice(&std::fs::read(&file)?)?;
            validate_snapshot(&snapshot)?;
            let body = put_snapshot(
                &base_url,
                &owner,
                &slug,
                &slot_key,
                expected_generation,
                snapshot,
                token.as_deref(),
                principal.as_deref(),
                owner_kind.as_deref(),
            )
            .await?;
            println!("{}", serde_json::to_string_pretty(&body)?);
        }
        SyncCmd::Pull {
            output,
            base_url,
            owner,
            slug,
            slot_key,
            token,
            principal,
            owner_kind,
        } => {
            let body = get_snapshot(
                &base_url,
                &owner,
                &slug,
                &slot_key,
                token.as_deref(),
                principal.as_deref(),
                owner_kind.as_deref(),
            )
            .await?;
            if let Some(parent) = output.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(&output, serde_json::to_vec_pretty(&body)?)?;
            println!(
                "{}",
                json!({ "written": output, "generation": body.get("generation") })
            );
        }
    }
    Ok(())
}

fn validate_snapshot(snapshot: &Value) -> anyhow::Result<()> {
    let format = snapshot.get("format").and_then(Value::as_str).unwrap_or("");
    if format != SNAPSHOT_FORMAT {
        anyhow::bail!("snapshot format must be {SNAPSHOT_FORMAT}");
    }
    Ok(())
}

fn endpoint(base_url: &str, owner: &str, slug: &str) -> String {
    format!(
        "{}/v1/vault-relay/{}/{}/snapshot",
        base_url.trim_end_matches('/'),
        encode_segment(owner),
        encode_segment(slug),
    )
}

fn relay_headers(
    slot_key: &str,
    token: Option<&str>,
    principal: Option<&str>,
    owner_kind: Option<&str>,
) -> reqwest::header::HeaderMap {
    use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION};
    let mut headers = HeaderMap::new();
    headers.insert(
        "x-opensesame-slot-key",
        HeaderValue::from_str(slot_key).unwrap_or(HeaderValue::from_static("")),
    );
    if let Some(value) = principal {
        if let Ok(header) = HeaderValue::from_str(value) {
            headers.insert("x-opensesame-principal", header);
        }
    }
    if let Some(value) = owner_kind {
        if let Ok(header) = HeaderValue::from_str(value) {
            headers.insert("x-opensesame-owner-kind", header);
        }
    }
    if let Some(value) = token {
        if let Ok(header) = HeaderValue::from_str(&format!("Bearer {value}")) {
            headers.insert(AUTHORIZATION, header);
        }
    }
    headers
}

async fn get_snapshot(
    base_url: &str,
    owner: &str,
    slug: &str,
    slot_key: &str,
    token: Option<&str>,
    principal: Option<&str>,
    owner_kind: Option<&str>,
) -> anyhow::Result<Value> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(30))
        .build()?;
    let response = client
        .get(endpoint(base_url, owner, slug))
        .headers(relay_headers(slot_key, token, principal, owner_kind))
        .send()
        .await?
        .error_for_status()?;
    Ok(response.json().await?)
}

fn encode_segment(value: &str) -> String {
    value
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (byte as char).to_string()
            }
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

async fn put_snapshot(
    base_url: &str,
    owner: &str,
    slug: &str,
    slot_key: &str,
    expected_generation: u64,
    snapshot: Value,
    token: Option<&str>,
    principal: Option<&str>,
    owner_kind: Option<&str>,
) -> anyhow::Result<Value> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(30))
        .build()?;
    let body = json!({
        "expected_generation": expected_generation,
        "snapshot": snapshot,
    });
    let response = client
        .put(endpoint(base_url, owner, slug))
        .headers(relay_headers(slot_key, token, principal, owner_kind))
        .json(&body)
        .send()
        .await?
        .error_for_status()?;
    Ok(response.json().await?)
}
