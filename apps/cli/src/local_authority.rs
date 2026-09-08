//! Native ceremonies: operator authority remains in this process, never the browser/child.
use anyhow::{bail, Context, Result};
use clap::{Args, Subcommand};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    io::{self, IsTerminal, Write},
    path::PathBuf,
    process::Command,
    time::Duration,
};

#[derive(Subcommand, Debug)]
pub enum LocalAuthorityCommand {
    Pair(PairArgs),
    Launch(LaunchArgs),
}

#[derive(Args, Debug)]
pub struct PairArgs {
    #[arg(long)]
    pub user_code: String,
    #[arg(long)]
    pub principal_id: String,
    #[arg(long)]
    pub organization_id: String,
    #[arg(long)]
    pub deny: bool,
}

#[derive(Args, Debug)]
pub struct LaunchArgs {
    #[arg(long)]
    pub principal_id: String,
    #[arg(long)]
    pub organization_id: String,
    #[arg(long, value_parser=["mcp-host", "mcp-client"])]
    pub audience: String,
    #[arg(long, required = true, value_delimiter = ',')]
    pub capability: Vec<String>,
    #[arg(long)]
    pub socket: PathBuf,
    /// An explicitly selected MCP executable; arguments follow --.
    #[arg(long)]
    pub executable: PathBuf,
    #[arg(last = true)]
    pub arguments: Vec<String>,
}

pub async fn run(server: &str, command: LocalAuthorityCommand) -> Result<()> {
    let base = safe_base(server)?;
    let operator = std::env::var("OPENSESAME_OPERATOR_TOKEN")
        .context("OPENSESAME_OPERATOR_TOKEN must be explicitly configured")?;
    if operator.len() < 32 || operator.len() > 4096 || operator.trim() != operator {
        bail!("operator credential is not a configured high-entropy secret");
    }
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(2))
        .timeout(Duration::from_secs(5))
        .build()?;
    match command {
        LocalAuthorityCommand::Pair(args) => pair(&client, &base, &operator, args).await,
        LocalAuthorityCommand::Launch(args) => launch(&client, &base, &operator, args).await,
    }
}

fn safe_base(raw: &str) -> Result<String> {
    let url = reqwest::Url::parse(raw).context("invalid Host origin")?;
    let local = matches!(
        url.host_str(),
        Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
    );
    let origin = url.origin().ascii_serialization();
    if url.username() != ""
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
        || (raw != origin && raw != format!("{origin}/"))
        || (url.scheme() != "https" && !(url.scheme() == "http" && local))
    {
        bail!("Host must be an exact HTTPS or loopback HTTP origin");
    }
    Ok(origin)
}

async fn post(
    client: &reqwest::Client,
    base: &str,
    operator: &str,
    path: &str,
    body: Value,
) -> Result<Vec<u8>> {
    let mut response = client
        .post(format!("{base}{path}"))
        .header("x-opensesame-operator", operator)
        .json(&body)
        .send()
        .await
        .map_err(|_| anyhow::anyhow!("native authority request failed"))?;
    if !response.status().is_success() {
        bail!(
            "native authority request refused ({})",
            response.status().as_u16()
        );
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| anyhow::anyhow!("authority response failed"))?
    {
        if chunk.len() > 8192 - bytes.len() {
            bail!("authority response exceeds its bound");
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn confirm(summary: &str) -> Result<()> {
    if !io::stdin().is_terminal() {
        bail!("native approval requires an interactive terminal");
    }
    eprintln!("{summary}\nType approve to continue:");
    io::stderr().flush()?;
    let mut answer = String::new();
    io::stdin().read_line(&mut answer)?;
    if answer.trim() != "approve" {
        bail!("approval cancelled");
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PairView {
    origin: String,
    audience: String,
    dpop_jkt: String,
    capabilities: Vec<String>,
}

async fn pair(client: &reqwest::Client, base: &str, operator: &str, args: PairArgs) -> Result<()> {
    if args.user_code.len() > 32 {
        bail!("invalid pairing code");
    }
    let bytes = post(
        client,
        base,
        operator,
        "/api/v1/browser-pairings/inspect",
        json!({"user_code":args.user_code}),
    )
    .await?;
    let view: PairView =
        serde_json::from_slice(&bytes).map_err(|_| anyhow::anyhow!("invalid pairing summary"))?;
    // JSON encoding prevents terminal escape/control injection from displayed configuration.
    confirm(&serde_json::to_string_pretty(
        &json!({"origin":view.origin,"audience":view.audience,"dpop_jkt":view.dpop_jkt,"capabilities":view.capabilities,"principal_id":args.principal_id,"organization_id":args.organization_id,"decision":if args.deny{"deny"}else{"approve"}}),
    )?)?;
    post(client,base,operator,"/pair/decision",json!({"user_code":args.user_code,"principal_id":args.principal_id,"organization_id":args.organization_id,"decision":if args.deny{"deny"}else{"approve"}})).await?;
    eprintln!("Pairing decision recorded; no operator credential was sent to the browser.");
    Ok(())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LaunchResponse {
    launch_handle: String,
    expires_in: u64,
    client_id: String,
    audience: String,
    scope: Vec<String>,
}

fn child_command(args: &LaunchArgs, base: &str, handle: &str, client: &str) -> Command {
    let mut child = Command::new(&args.executable);
    child.env_clear().args(&args.arguments);
    for name in ["PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "LANG"] {
        if let Some(value) = std::env::var_os(name) {
            child.env(name, value);
        }
    }
    child
        .env("OPENSESAME_AGENT_LAUNCH_HANDLE", handle)
        .env("OPENSESAME_AGENT_CLIENT_ID", client)
        .env("OPENSESAME_AGENT_SOCK", &args.socket)
        .env("OPENSESAME_SERVER", base)
        .env("OPENSESAME_HOST_API", base);
    child
}

async fn launch(
    client: &reqwest::Client,
    base: &str,
    operator: &str,
    args: LaunchArgs,
) -> Result<()> {
    let executable =
        std::fs::canonicalize(&args.executable).context("MCP executable does not exist")?;
    if !executable.is_file() || !args.socket.is_absolute() {
        bail!("explicit executable and absolute socket required");
    }
    let client_id = uuid::Uuid::new_v4().to_string();
    let audience = format!("urn:opensesame:agent:{}", args.audience);
    let body = json!({"principal_id":args.principal_id,"organization_id":args.organization_id,"client_id":client_id,"audience":audience,"capabilities":args.capability});
    confirm(&serde_json::to_string_pretty(&body)?)?;
    let bytes = post(client, base, operator, "/api/v1/agent-launches", body).await?;
    let response: LaunchResponse = serde_json::from_slice(&bytes)
        .map_err(|_| anyhow::anyhow!("invalid agent launch response"))?;
    if response.client_id != client_id
        || response.audience != audience
        || response.scope != args.capability
        || response.expires_in == 0
        || response.expires_in > 300
        || response.launch_handle.len() != 64
        || !response
            .launch_handle
            .bytes()
            .all(|b| b.is_ascii_hexdigit())
    {
        bail!("agent launch binding mismatch");
    }
    let args = LaunchArgs { executable, ..args };
    let status = child_command(&args, base, &response.launch_handle, &client_id)
        .status()
        .map_err(|_| anyhow::anyhow!("MCP child failed to start"))?;
    if !status.success() {
        bail!("MCP child exited unsuccessfully");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn authority_origin_rejects_redirect_and_credential_shapes() {
        for value in [
            "http://attacker.example",
            "https://user:pass@host.example",
            "https://host.example/path",
            "https://host.example?x=1",
            "https://HOST.example",
        ] {
            assert!(safe_base(value).is_err());
        }
        assert!(safe_base("http://127.0.0.1:8787").is_ok());
    }
    #[test]
    fn child_receives_only_one_use_authority() {
        let args = LaunchArgs {
            principal_id: "p".into(),
            organization_id: "o".into(),
            audience: "mcp-host".into(),
            capability: vec!["host.sync.read".into()],
            socket: "/tmp/test.sock".into(),
            executable: "/bin/true".into(),
            arguments: vec![],
        };
        let command = child_command(&args, "http://127.0.0.1:8787", "one-use-fixture", "client");
        let names: Vec<_> = command
            .get_envs()
            .map(|(k, _)| k.to_string_lossy().into_owned())
            .collect();
        assert!(names.contains(&"OPENSESAME_AGENT_LAUNCH_HANDLE".into()));
        for forbidden in [
            "OPENSESAME_OPERATOR_TOKEN",
            "OPENSESAME_ACCESS_TOKEN",
            "OPENSESAME_IDENTITY_TOKEN",
            "OPENAI_API_KEY",
            "HOME",
        ] {
            assert!(!names.iter().any(|name| name == forbidden));
        }
    }
}
