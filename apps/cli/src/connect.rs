//! Vercel-shaped connector DX (`opensesame connect …`).
//!
//! Create, attach, list, and remove Host connections by `service/name`. Runtime
//! output is a `ConnectionRef` — never a provider token (ADR 0005).

use anyhow::{anyhow, bail, Context};
use clap::{Parser, Subcommand};
use serde_json::{json, Value};
use std::{
    env, fs,
    io::{self, IsTerminal, Read, Write},
    process::Command,
    time::{Duration, Instant},
};

const POLL_INTERVAL: Duration = Duration::from_millis(1_500);
const CONSENT_TIMEOUT: Duration = Duration::from_secs(5 * 60);

#[derive(Parser, Debug)]
pub struct ConnectArgs {
    /// `json` for machine output. Default is a human table or a raw `ConnectionRef`.
    #[arg(long = "format", short = 'F', global = true)]
    pub format: Option<String>,
    #[command(subcommand)]
    pub cmd: ConnectCmd,
}

#[derive(Subcommand, Debug)]
pub enum ConnectCmd {
    /// Create a connector for a catalog service.
    #[command(disable_help_flag = true)]
    Create {
        /// Provider id (`github`, `openai`) or a setup URL.
        service: Option<String>,
        /// Instance name. Becomes the UID `service/name`.
        #[arg(short = 'n', long)]
        name: Option<String>,
        /// Repeatable setup value (`region=us-east-1`).
        #[arg(long = "param")]
        params: Vec<String>,
        /// Credentials JSON, `@path`, or `@-` for stdin. Never pass secrets inline.
        #[arg(long)]
        data: Option<String>,
        /// Provider scopes (repeatable or comma-separated).
        #[arg(long)]
        scopes: Vec<String>,
        #[arg(long)]
        project: Option<String>,
        #[arg(long)]
        shareability: Option<String>,
        /// Skip confirmations. Fail instead of prompting.
        #[arg(short = 'y', long)]
        yes: bool,
        /// Do not open a browser for OAuth.
        #[arg(long)]
        no_browser: bool,
        /// Describe how to connect this service, then exit.
        #[arg(short = 'h', long = "help")]
        help: bool,
    },
    /// List connectors. Alias: `ls`.
    #[command(visible_alias = "ls")]
    List {
        #[arg(long)]
        service: Option<String>,
        #[arg(long)]
        search: Option<String>,
        /// Include revoked connectors.
        #[arg(long)]
        all: bool,
    },
    /// Print the `ConnectionRef` for `service/name`. Suitable for `REF=$(opensesame connect token …)`.
    Token {
        connector: String,
        /// Accepted for Vercel-shaped scripts. `OpenSesame` does not mint provider tokens.
        #[arg(long)]
        scopes: Option<String>,
        #[arg(long)]
        subject: Option<String>,
    },
    /// Bind a project, agent, identity, group, device, or organization.
    Attach {
        connector: String,
        #[arg(short = 'p', long)]
        project: Option<String>,
        #[arg(long)]
        agent: Option<String>,
        #[arg(long)]
        identity: Option<String>,
        #[arg(long)]
        group: Option<String>,
        #[arg(long)]
        device: Option<String>,
        #[arg(long)]
        organization: Option<String>,
        #[arg(long)]
        label: Option<String>,
        #[arg(short = 'y', long)]
        yes: bool,
    },
    /// Remove a binding.
    Detach {
        connector: String,
        #[arg(short = 'p', long)]
        project: Option<String>,
        #[arg(long)]
        agent: Option<String>,
        #[arg(long)]
        identity: Option<String>,
        #[arg(long)]
        group: Option<String>,
        #[arg(long)]
        device: Option<String>,
        #[arg(long)]
        organization: Option<String>,
        #[arg(short = 'y', long)]
        yes: bool,
    },
    /// Update delegation or invoke ceiling.
    Update {
        connector: String,
        #[arg(long)]
        shareability: Option<String>,
        #[arg(long = "max-invoke-level")]
        max_invoke_level: Option<u8>,
    },
    /// Request connection credential rotation (never reveals secrets).
    Rotate {
        connector: String,
        /// Schedule interval (`24h`, `3600`). Optional.
        #[arg(long)]
        interval: Option<String>,
        #[arg(long)]
        project: Option<String>,
        /// Attempt refresh immediately after enqueue.
        #[arg(long)]
        execute_now: bool,
    },
    /// Revoke a connector. Alias: `rm`.
    #[command(visible_alias = "rm")]
    Remove {
        connector: String,
        #[arg(short = 'y', long)]
        yes: bool,
    },
    /// Open the connector settings page.
    Open { connector: String },
    /// Show Host status for a service. Vault items live in the PWA, not here.
    Inspect { service: String },
    /// Import Host-detected connectors that need no extra credentials.
    Discover,
}

#[expect(
    clippy::too_many_lines,
    reason = "the match is the flat dispatch catalog for the connect subcommands"
)]
pub async fn run(server: &str, args: ConnectArgs) -> anyhow::Result<()> {
    let json = matches!(args.format.as_deref(), Some("json"));
    match args.cmd {
        ConnectCmd::Create {
            service,
            name,
            params,
            data,
            scopes,
            project,
            shareability,
            yes,
            no_browser,
            help,
        } => {
            create(
                server,
                json,
                service.as_deref(),
                name.as_deref(),
                &params,
                data.as_deref(),
                &scopes,
                project.as_deref(),
                shareability.as_deref(),
                yes,
                no_browser,
                help,
            )
            .await
        }
        ConnectCmd::List {
            service,
            search,
            all,
        } => list(server, json, service.as_deref(), search.as_deref(), all).await,
        ConnectCmd::Token {
            connector,
            scopes,
            subject,
        } => {
            token(
                server,
                json,
                &connector,
                scopes.as_deref(),
                subject.as_deref(),
            )
            .await
        }
        ConnectCmd::Attach {
            connector,
            project,
            agent,
            identity,
            group,
            device,
            organization,
            label,
            yes,
        } => {
            attach(
                server,
                json,
                &connector,
                TargetSpec {
                    project,
                    agent,
                    identity,
                    group,
                    device,
                    organization,
                },
                label.as_deref(),
                yes,
            )
            .await
        }
        ConnectCmd::Detach {
            connector,
            project,
            agent,
            identity,
            group,
            device,
            organization,
            yes,
        } => {
            detach(
                server,
                json,
                &connector,
                TargetSpec {
                    project,
                    agent,
                    identity,
                    group,
                    device,
                    organization,
                },
                yes,
            )
            .await
        }
        ConnectCmd::Update {
            connector,
            shareability,
            max_invoke_level,
        } => {
            update(
                server,
                json,
                &connector,
                shareability.as_deref(),
                max_invoke_level,
            )
            .await
        }
        ConnectCmd::Rotate {
            connector,
            interval,
            project,
            execute_now,
        } => rotate_connection(server, json, &connector, interval, project, execute_now).await,
        ConnectCmd::Remove { connector, yes } => remove(server, json, &connector, yes).await,
        ConnectCmd::Open { connector } => open(server, json, &connector).await,
        ConnectCmd::Inspect { service } => inspect(server, json, &service).await,
        ConnectCmd::Discover => discover(server, json).await,
    }
}

struct TargetSpec {
    project: Option<String>,
    agent: Option<String>,
    identity: Option<String>,
    group: Option<String>,
    device: Option<String>,
    organization: Option<String>,
}

impl TargetSpec {
    fn bindings(&self) -> anyhow::Result<Vec<(&'static str, &str)>> {
        let pairs = [
            ("project", self.project.as_deref()),
            ("agent", self.agent.as_deref()),
            ("identity", self.identity.as_deref()),
            ("group", self.group.as_deref()),
            ("device", self.device.as_deref()),
            ("organization", self.organization.as_deref()),
        ];
        let selected: Vec<_> = pairs
            .into_iter()
            .filter_map(|(kind, id)| id.map(|id| (kind, id)))
            .collect();
        if selected.is_empty() {
            bail!("pass --project, --agent, --identity, --group, --device, or --organization");
        }
        Ok(selected)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ConnectorUid {
    Logical(String),
    Id(String),
    Ref(String),
}

pub(crate) fn parse_uid(raw: &str) -> ConnectorUid {
    let raw = raw.trim();
    if raw.starts_with("conn://") {
        ConnectorUid::Ref(raw.to_string())
    } else if raw.starts_with("connection:") {
        ConnectorUid::Id(raw.to_string())
    } else {
        ConnectorUid::Logical(raw.to_string())
    }
}

pub(crate) fn logical_name_for(service: &str, name: Option<&str>) -> Option<String> {
    let name = name?.trim();
    if name.is_empty() {
        return None;
    }
    if name.contains('/') {
        Some(name.to_string())
    } else {
        Some(format!("{service}/{name}"))
    }
}

pub(crate) fn parse_params(params: &[String]) -> anyhow::Result<serde_json::Map<String, Value>> {
    let mut out = serde_json::Map::new();
    for raw in params {
        let (key, value) = raw
            .split_once('=')
            .ok_or_else(|| anyhow!("--param must be KEY=VALUE, got {raw}"))?;
        let key = key.trim();
        if key.is_empty() {
            bail!("--param key is empty");
        }
        out.insert(key.to_string(), Value::String(value.to_string()));
    }
    Ok(out)
}

pub(crate) fn parse_data_json(raw: &str) -> anyhow::Result<Value> {
    if raw == "@-" {
        let mut buf = String::new();
        io::stdin()
            .read_to_string(&mut buf)
            .context("reading credentials from stdin")?;
        return parse_data_json(&buf);
    }
    if let Some(path) = raw.strip_prefix('@') {
        let bytes = fs::read(path).with_context(|| format!("reading {path}"))?;
        return serde_json::from_slice(&bytes).with_context(|| format!("parsing {path}"));
    }
    let trimmed = raw.trim();
    if trimmed.starts_with('{') {
        serde_json::from_str(trimmed).context("parsing --data JSON")
    } else {
        Ok(json!({ "api_key": trimmed }))
    }
}

fn object_strings(value: &Value) -> anyhow::Result<Vec<(String, String)>> {
    let obj = value
        .as_object()
        .ok_or_else(|| anyhow!("--data must be a JSON object"))?;
    let mut out = Vec::new();
    for (key, value) in obj {
        let text = match value {
            Value::String(text) => text.clone(),
            Value::Number(n) => n.to_string(),
            Value::Bool(b) => b.to_string(),
            Value::Null => continue,
            _ => bail!("--data field `{key}` must be a string"),
        };
        if !text.is_empty() {
            out.push((key.clone(), text));
        }
    }
    Ok(out)
}

fn flatten_scopes(scopes: &[String]) -> Vec<String> {
    scopes
        .iter()
        .flat_map(|scope| scope.split([',', ' ']))
        .map(str::trim)
        .filter(|scope| !scope.is_empty())
        .map(str::to_string)
        .collect()
}

#[expect(
    clippy::too_many_arguments,
    clippy::fn_params_excessive_bools,
    reason = "the parameters directly project the independent create subcommand flags"
)]
async fn create(
    server: &str,
    json_out: bool,
    service: Option<&str>,
    name: Option<&str>,
    params: &[String],
    data: Option<&str>,
    scopes: &[String],
    project: Option<&str>,
    shareability: Option<&str>,
    yes: bool,
    no_browser: bool,
    help: bool,
) -> anyhow::Result<()> {
    if help && service.is_none() {
        print_create_help();
        return Ok(());
    }
    let service = service.ok_or_else(|| anyhow!("pass a service, for example `github`"))?;
    let providers = list_providers(server).await?;
    let provider = find_provider(&providers, service)?;
    if help {
        print_service_help(provider);
        return Ok(());
    }

    if !provider_flag(provider, "configured") && !provider_flag(provider, "auto_configurable") {
        let missing = string_list(&provider["missing_config"]);
        if !missing.is_empty() {
            eprintln!(
                "{} is not sealed on this Host yet. Set:\n  {}",
                provider["display_name"].as_str().unwrap_or(service),
                missing.join("\n  ")
            );
        }
        if let Some(callback) = provider["callback_url"].as_str() {
            eprintln!("OAuth callback URL:\n  {callback}");
        }
        if !yes && io::stderr().is_terminal() {
            eprintln!("Creating a pending connector anyway. Finish setup, then re-run authorize from settings.");
        }
    }

    let mut configuration = parse_params(params)?;
    if let Some(raw) = data {
        for (key, value) in object_strings(&parse_data_json(raw)?)? {
            configuration.insert(key, Value::String(value));
        }
    }

    if !provider_flag(provider, "auto_configurable") {
        let fields = provider
            .get("connection_configuration_fields")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        fill_missing_fields(&fields, &mut configuration, yes)?;
    }

    let logical_name = logical_name_for(service, name);
    let mut body = json!({
        "provider_id": provider["id"],
        "display_name": name
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| provider["display_name"].as_str().unwrap_or(service)),
    });
    if let Some(logical_name) = &logical_name {
        body["logical_name"] = json!(logical_name);
    }
    if let Some(project) = project {
        body["project_id"] = json!(project);
    }
    let scopes = flatten_scopes(scopes);
    if !scopes.is_empty() {
        body["scopes"] = json!(scopes);
    }
    if let Some(shareability) = shareability {
        body["shareability"] = json!(shareability);
    }

    let created = api(
        server,
        reqwest::Method::POST,
        "/api/v1/connections",
        Some(&body),
    )
    .await?;
    let id = created["connection_id"]
        .as_str()
        .ok_or_else(|| anyhow!("create response missing connection_id"))?
        .to_string();

    let auth_kind = provider["auth_kind"].as_str().unwrap_or("");
    let mut view = created;
    if !configuration.is_empty() {
        let configuration_set: serde_json::Map<String, Value> = configuration.into_iter().collect();
        let mut cred = json!({ "configuration_set": configuration_set });
        if auth_kind == "api_key" {
            if let Some(key) = configuration_set.get("api_key").and_then(Value::as_str) {
                cred = json!({ "value": key });
            }
        }
        view = api(
            server,
            reqwest::Method::POST,
            &format!("/api/v1/connections/{id}/credential"),
            Some(&cred),
        )
        .await?;
    } else if auth_kind == "oauth2_authorization_code"
        && provider_flag(provider, "configured")
        && view["status"].as_str() != Some("active")
    {
        view = authorize_oauth(server, &id, no_browser, yes).await?;
    }

    emit_connection(json_out, &view, "Created")
}

fn fill_missing_fields(
    fields: &[Value],
    configuration: &mut serde_json::Map<String, Value>,
    yes: bool,
) -> anyhow::Result<()> {
    let mut missing = Vec::new();
    for field in fields {
        let name = field["name"].as_str().unwrap_or_default();
        if name.is_empty() {
            continue;
        }
        if configuration.contains_key(name) {
            continue;
        }
        if !field["required"].as_bool().unwrap_or(false) {
            continue;
        }
        if yes || !io::stdin().is_terminal() {
            missing.push(name.to_string());
            continue;
        }
        let secret = field["secret"].as_bool().unwrap_or(false);
        let label = if secret {
            format!("{name} (secret, input is visible)")
        } else {
            name.to_string()
        };
        let value = prompt_line(&label)?;
        if value.is_empty() {
            missing.push(name.to_string());
        } else {
            configuration.insert(name.to_string(), Value::String(value));
        }
    }
    if !missing.is_empty() {
        bail!(
            "missing required fields: {}. Pass --param KEY=VALUE or --data @credentials.json",
            missing.join(", ")
        );
    }
    Ok(())
}

fn prompt_line(label: &str) -> anyhow::Result<String> {
    eprint!("{label}: ");
    io::stderr().flush()?;
    let mut line = String::new();
    io::stdin().read_line(&mut line)?;
    Ok(line.trim().to_string())
}

async fn authorize_oauth(
    server: &str,
    id: &str,
    no_browser: bool,
    yes: bool,
) -> anyhow::Result<Value> {
    let start = api(
        server,
        reqwest::Method::POST,
        &format!("/api/v1/connections/{id}/authorize"),
        Some(&json!({})),
    )
    .await?;
    let url = start["authorization_url"]
        .as_str()
        .ok_or_else(|| anyhow!("authorize response missing authorization_url"))?;
    eprintln!("Open this URL to finish sign-in:\n  {url}");
    warn_passkey_fallback();
    if !no_browser {
        open_url(url);
    }
    if yes && !io::stdin().is_terminal() {
        return get_connection(server, id).await;
    }
    eprintln!("Waiting for the provider to return control to the Host…");
    let deadline = Instant::now() + CONSENT_TIMEOUT;
    while Instant::now() < deadline {
        tokio::time::sleep(POLL_INTERVAL).await;
        let view = get_connection(server, id).await?;
        match view["status"].as_str() {
            Some("active") => return Ok(view),
            Some("error" | "revoked") => {
                let detail = view["status_detail"]
                    .as_str()
                    .unwrap_or("authorization failed");
                bail!("{detail}");
            }
            _ => {}
        }
    }
    bail!("authorization timed out; run `opensesame connect token` after you finish in the browser")
}

async fn list(
    server: &str,
    json_out: bool,
    service: Option<&str>,
    search: Option<&str>,
    all: bool,
) -> anyhow::Result<()> {
    let mut connections = list_connections(server).await?;
    if !all {
        connections.retain(|item| item["status"].as_str() != Some("revoked"));
    }
    if let Some(service) = service {
        connections.retain(|item| item["provider_id"].as_str() == Some(service));
    }
    if let Some(search) = search {
        let needle = search.to_ascii_lowercase();
        connections.retain(|item| {
            [
                item["logical_name"].as_str(),
                item["display_name"].as_str(),
                item["provider_id"].as_str(),
                item["connection_id"].as_str(),
            ]
            .into_iter()
            .flatten()
            .any(|value| value.to_ascii_lowercase().contains(&needle))
        });
    }
    if json_out {
        println!(
            "{}",
            serde_json::to_string_pretty(&json!({ "connections": connections }))?
        );
        return Ok(());
    }
    if connections.is_empty() {
        println!("No connectors. Create one with `opensesame connect create <service>`.");
        return Ok(());
    }
    println!("{:<28} {:<18} {:<12} REF", "UID", "PROVIDER", "STATUS");
    for item in connections {
        println!(
            "{:<28} {:<18} {:<12} {}",
            item["logical_name"].as_str().unwrap_or("-"),
            item["provider_id"].as_str().unwrap_or("-"),
            item["status"].as_str().unwrap_or("-"),
            item["connection_ref"].as_str().unwrap_or("-"),
        );
    }
    Ok(())
}

async fn token(
    server: &str,
    json_out: bool,
    connector: &str,
    scopes: Option<&str>,
    subject: Option<&str>,
) -> anyhow::Result<()> {
    let view = resolve_connection(server, connector).await?;
    if let Some(subject) = subject {
        eprintln!(
            "note: --subject {subject} is ignored; invoke through the Host with the ConnectionRef"
        );
    }
    if let Some(scopes) = scopes {
        eprintln!("note: --scopes {scopes} is ignored; set scopes at create/authorize time");
    }
    if view["status"].as_str() != Some("active") {
        eprintln!(
            "warning: connector status is {}",
            view["status"].as_str().unwrap_or("unknown")
        );
    }
    let connection_ref = view["connection_ref"]
        .as_str()
        .ok_or_else(|| anyhow!("connection is missing connection_ref"))?;
    if json_out {
        println!(
            "{}",
            serde_json::to_string_pretty(&json!({
                "uid": view["logical_name"],
                "connection_id": view["connection_id"],
                "connection_ref": connection_ref,
                "status": view["status"],
                "provider_id": view["provider_id"],
                "scopes": view["granted_scopes"],
                "expires_at": view["expires_at"],
            }))?
        );
    } else {
        println!("{connection_ref}");
    }
    Ok(())
}

async fn attach(
    server: &str,
    json_out: bool,
    connector: &str,
    targets: TargetSpec,
    label: Option<&str>,
    yes: bool,
) -> anyhow::Result<()> {
    let view = resolve_connection(server, connector).await?;
    let id = view["connection_id"]
        .as_str()
        .ok_or_else(|| anyhow!("connection is missing connection_id"))?
        .to_string();
    let mut last = view;
    for (kind, target) in targets.bindings()? {
        if !yes && io::stdin().is_terminal() {
            eprintln!("Attach {kind} `{target}` to {}?", last["logical_name"]);
        }
        last = api(
            server,
            reqwest::Method::POST,
            &format!("/api/v1/connections/{id}/bindings"),
            Some(&json!({
                "target_kind": kind,
                "target_id": target,
                "target_label": label.unwrap_or(target),
            })),
        )
        .await?;
    }
    emit_connection(json_out, &last, "Attached")
}

async fn detach(
    server: &str,
    json_out: bool,
    connector: &str,
    targets: TargetSpec,
    yes: bool,
) -> anyhow::Result<()> {
    let view = resolve_connection(server, connector).await?;
    let id = view["connection_id"].as_str().unwrap().to_string();
    let bindings = view["bindings"].as_array().cloned().unwrap_or_default();
    let wanted = targets.bindings()?;
    let mut last = view;
    for (kind, target) in wanted {
        let binding = bindings.iter().find(|binding| {
            binding["target_kind"].as_str() == Some(kind)
                && (binding["target_id"].as_str() == Some(target)
                    || binding["target_label"].as_str() == Some(target))
        });
        let Some(binding) = binding else {
            bail!("no {kind} binding for `{target}`");
        };
        if !yes && io::stdin().is_terminal() {
            eprintln!("Detach {kind} `{target}` from connector?");
        }
        last = api(
            server,
            reqwest::Method::DELETE,
            &format!(
                "/api/v1/connections/{id}/bindings/{}",
                binding["id"].as_str().unwrap_or_default()
            ),
            None,
        )
        .await?;
    }
    emit_connection(json_out, &last, "Detached")
}

async fn update(
    server: &str,
    json_out: bool,
    connector: &str,
    shareability: Option<&str>,
    max_invoke_level: Option<u8>,
) -> anyhow::Result<()> {
    let view = resolve_connection(server, connector).await?;
    let id = view["connection_id"].as_str().unwrap();
    let shareability = shareability
        .map(str::to_string)
        .or_else(|| view["shareability"].as_str().map(str::to_string))
        .unwrap_or_else(|| "private".into());
    let max_invoke_level = max_invoke_level
        .unwrap_or_else(|| view["max_invoke_level"].as_u64().unwrap_or(2).clamp(1, 2) as u8);
    let updated = api(
        server,
        reqwest::Method::PATCH,
        &format!("/api/v1/connections/{id}"),
        Some(&json!({
            "shareability": shareability,
            "max_invoke_level": max_invoke_level,
        })),
    )
    .await?;
    emit_connection(json_out, &updated, "Updated")
}

/// Human-only connection credential rotation. Response never includes secrets.
async fn rotate_connection(
    server: &str,
    json_out: bool,
    connector: &str,
    interval: Option<String>,
    project: Option<String>,
    execute_now: bool,
) -> anyhow::Result<()> {
    let view = resolve_connection(server, connector).await?;
    let id = view["connection_id"]
        .as_str()
        .ok_or_else(|| anyhow!("connection is missing connection_id"))?;
    let mut body = json!({
        "connection_id": id,
        "execute_now": execute_now,
    });
    if let Some(interval) = interval {
        body["interval"] = json!(interval);
    }
    if let Some(project) = project {
        body["project_id"] = json!(project);
    }
    let result = api(
        server,
        reqwest::Method::POST,
        "/api/v1/rotations",
        Some(&body),
    )
    .await?;
    for forbidden in [
        "secret",
        "password",
        "token",
        "access_token",
        "refresh_token",
        "api_key",
        "value",
    ] {
        if result.get(forbidden).is_some() {
            bail!("Host rotation response unexpectedly included `{forbidden}`");
        }
    }
    if json_out {
        println!("{}", serde_json::to_string_pretty(&result)?);
    } else {
        println!(
            "Rotation {}  [{}]\n  secrets_returned  {}",
            result["id"].as_str().unwrap_or("-"),
            result["status"].as_str().unwrap_or("-"),
            result["secrets_returned"].as_bool().unwrap_or(false),
        );
    }
    Ok(())
}

async fn remove(server: &str, json_out: bool, connector: &str, yes: bool) -> anyhow::Result<()> {
    let view = resolve_connection(server, connector).await?;
    let id = view["connection_id"].as_str().unwrap();
    if !yes && io::stdin().is_terminal() {
        eprint!(
            "Remove {}? [y/N] ",
            view["logical_name"].as_str().unwrap_or(id)
        );
        io::stderr().flush()?;
        let mut answer = String::new();
        io::stdin().read_line(&mut answer)?;
        if !matches!(answer.trim(), "y" | "Y" | "yes") {
            bail!("aborted");
        }
    }
    let outcome = api(
        server,
        reqwest::Method::DELETE,
        &format!("/api/v1/connections/{id}"),
        None,
    )
    .await?;
    if json_out {
        println!("{}", serde_json::to_string_pretty(&outcome)?);
    } else {
        println!(
            "Removed {}",
            view["logical_name"].as_str().unwrap_or(connector)
        );
    }
    Ok(())
}

async fn open(server: &str, json_out: bool, connector: &str) -> anyhow::Result<()> {
    let view = resolve_connection(server, connector).await?;
    let pages = env::var("OPENSESAME_PAGES_URL")
        .unwrap_or_else(|_| "http://127.0.0.1:5180/OpenSesame".into())
        .trim_end_matches('/')
        .to_string();
    let provider = view["provider_id"].as_str().unwrap_or_default();
    let id = view["connection_id"].as_str().unwrap_or_default();
    let url = format!("{pages}/connections/{provider}/{id}");
    if json_out {
        println!("{}", serde_json::to_string_pretty(&json!({ "url": url }))?);
    } else {
        println!("{url}");
        open_url(&url);
    }
    Ok(())
}

async fn inspect(server: &str, json_out: bool, service: &str) -> anyhow::Result<()> {
    let providers = list_providers(server).await?;
    let provider = find_provider(&providers, service)?.clone();
    let connections = list_connections(server)
        .await?
        .into_iter()
        .filter(|item| {
            item["provider_id"].as_str() == provider["id"].as_str()
                && item["status"].as_str() != Some("revoked")
        })
        .collect::<Vec<_>>();
    let cli = local_cli_status(provider["id"].as_str().unwrap_or(service));
    if json_out {
        println!(
            "{}",
            serde_json::to_string_pretty(&json!({
                "provider": {
                    "id": provider["id"],
                    "display_name": provider["display_name"],
                    "auth_kind": provider["auth_kind"],
                    "configured": provider["configured"],
                    "missing_config": provider["missing_config"],
                },
                "doors": {
                    "host": connections,
                    "login": "PWA vault — unlock OpenSesame and open this provider home",
                    "passkey": "PWA vault — private key stays on the authenticator",
                    "reminder": "PWA vault — ConnectionRef only, never the Host token",
                    "cli": cli,
                },
                "connections": connections,
                "vault": "PWA only — unlock OpenSesame and open this provider home",
            }))?
        );
        return Ok(());
    }
    let configured = provider["configured"].as_bool().unwrap_or(false);
    println!(
        "{}\n  auth         {}\n  host client  {}\n  connections  {}",
        provider["display_name"].as_str().unwrap_or(service),
        provider["auth_kind"].as_str().unwrap_or("-"),
        if configured {
            "sealed"
        } else {
            "needs install"
        },
        connections.len()
    );
    if connections.is_empty() {
        println!("  none on this Host. Create with `opensesame connect create {service}`.");
    } else {
        for item in &connections {
            println!(
                "  {}  {}  {}",
                item["logical_name"].as_str().unwrap_or("-"),
                item["status"].as_str().unwrap_or("-"),
                item["connection_ref"].as_str().unwrap_or("-"),
            );
        }
        if let Some(id) = connections[0]["connection_id"].as_str() {
            print_recent_events(server, id).await;
        }
    }
    println!("  login        inspect in the PWA provider home");
    println!("  passkey      inspect in the PWA provider home");
    println!("  reminder     inspect in the PWA provider home (ConnectionRef only)");
    match cli {
        Some(status) => println!("  cli          {status}"),
        None => println!("  cli          no local probe for this service (vault + Host only)"),
    }
    Ok(())
}

async fn print_recent_events(server: &str, connection_id: &str) {
    let Ok(events) = api(
        server,
        reqwest::Method::GET,
        &format!("/api/v1/connections/{connection_id}/events"),
        None,
    )
    .await
    else {
        return;
    };
    let rows = events
        .get("events")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for event in rows.iter().take(5) {
        println!(
            "  event        {}  {}",
            event["kind"].as_str().unwrap_or("-"),
            event["at"].as_str().unwrap_or("-"),
        );
    }
}

async fn discover(server: &str, json_out: bool) -> anyhow::Result<()> {
    let body = api(
        server,
        reqwest::Method::POST,
        "/api/v1/connections/discover",
        Some(&json!({})),
    )
    .await?;
    if json_out {
        println!("{}", serde_json::to_string_pretty(&body)?);
    } else {
        let n = body["configured"].as_u64().unwrap_or(0);
        println!(
            "Imported {n} Host-detected connector{}",
            if n == 1 { "" } else { "s" }
        );
    }
    Ok(())
}

fn emit_connection(json_out: bool, view: &Value, verb: &str) -> anyhow::Result<()> {
    if json_out {
        println!("{}", serde_json::to_string_pretty(view)?);
    } else {
        println!(
            "{verb} {}  [{}]\n  ref  {}",
            view["logical_name"].as_str().unwrap_or("-"),
            view["status"].as_str().unwrap_or("-"),
            view["connection_ref"].as_str().unwrap_or("-"),
        );
    }
    Ok(())
}

async fn list_providers(server: &str) -> anyhow::Result<Vec<Value>> {
    let body = api(server, reqwest::Method::GET, "/api/v1/providers", None).await?;
    Ok(body
        .get("providers")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default())
}

async fn list_connections(server: &str) -> anyhow::Result<Vec<Value>> {
    let body = api(server, reqwest::Method::GET, "/api/v1/connections", None).await?;
    Ok(body
        .get("connections")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default())
}

async fn get_connection(server: &str, id: &str) -> anyhow::Result<Value> {
    api(
        server,
        reqwest::Method::GET,
        &format!("/api/v1/connections/{id}"),
        None,
    )
    .await
}

async fn resolve_connection(server: &str, raw: &str) -> anyhow::Result<Value> {
    let uid = parse_uid(raw);
    if let ConnectorUid::Id(id) = &uid {
        return get_connection(server, id).await;
    }
    let connections = list_connections(server).await?;
    let found = connections.into_iter().find(|item| match &uid {
        ConnectorUid::Ref(reference) => item["connection_ref"].as_str() == Some(reference),
        ConnectorUid::Logical(name) => {
            item["logical_name"].as_str() == Some(name)
                || item["connection_id"].as_str() == Some(name)
                || item["display_name"].as_str() == Some(name)
        }
        ConnectorUid::Id(_) => false,
    });
    found.ok_or_else(|| anyhow!("connector `{raw}` not found"))
}

fn find_provider<'a>(providers: &'a [Value], service: &str) -> anyhow::Result<&'a Value> {
    let needle = service.trim();
    let lowered = needle.to_ascii_lowercase();
    providers
        .iter()
        .find(|provider| provider["id"].as_str() == Some(needle))
        .or_else(|| {
            providers.iter().find(|provider| {
                provider["id"].as_str() == Some(lowered.as_str())
                    || provider["display_name"]
                        .as_str()
                        .is_some_and(|name| name.eq_ignore_ascii_case(needle))
            })
        })
        .ok_or_else(|| {
            anyhow!("unknown service `{service}`. Run `opensesame connect create --help`")
        })
}

fn provider_flag(provider: &Value, name: &str) -> bool {
    provider.get(name).and_then(Value::as_bool).unwrap_or(false)
}

fn string_list(value: &Value) -> Vec<String> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect()
}

fn print_create_help() {
    println!(
        "\
Create a connector for a Host catalog service.

USAGE:
    opensesame connect create <service> [options]

ARGS:
    <service>    Catalog id (`github`, `openai`, `sealed-local`) or display name

OPTIONS:
    -n, --name <NAME>         Instance name; UID becomes service/name
        --param <KEY=VALUE>   Setup value (repeatable)
        --data <JSON|@FILE>   Credentials object, @path, or @-
        --scopes <SCOPES>     Provider scopes
        --project <ID>        Scope the ConnectionRef to a project
        --shareability <VAL>  private | delegable | organization_wide
    -y, --yes                 Do not prompt; fail if a required field is missing
        --no-browser          Print the OAuth URL instead of opening it
    -h, --help                Service setup when a service is passed

EXAMPLES:
    opensesame connect create github --name acme-gh
    opensesame connect create openai --name prod --data @key.json
    opensesame connect create sealed-local --yes
    opensesame connect attach github/acme-gh --project prj_01J…
    REF=$(opensesame connect token github/acme-gh)

`connect token` prints a ConnectionRef. Agents invoke through the Host;
they never receive the provider credential."
    );
}

fn print_service_help(provider: &Value) {
    let id = provider["id"].as_str().unwrap_or("-");
    let name = provider["display_name"].as_str().unwrap_or(id);
    let auth = provider["auth_kind"].as_str().unwrap_or("-");
    println!("{name}");
    println!("  id           {id}");
    println!("  auth         {auth}");
    println!("  configured   {}", provider_flag(provider, "configured"));
    println!(
        "  auto         {}",
        provider_flag(provider, "auto_configurable")
    );
    if let Some(callback) = provider["callback_url"].as_str() {
        println!("  callback     {callback}");
    }
    let missing = string_list(&provider["missing_config"]);
    if !missing.is_empty() {
        println!("  missing      {}", missing.join(", "));
    }
    let fields = provider
        .get("connection_configuration_fields")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if !fields.is_empty() {
        println!("  fields");
        for field in &fields {
            let fname = field["name"].as_str().unwrap_or("-");
            let req = if field["required"].as_bool().unwrap_or(false) {
                "required"
            } else {
                "optional"
            };
            let secret = if field["secret"].as_bool().unwrap_or(false) {
                ", secret"
            } else {
                ""
            };
            println!("    {fname}  ({req}{secret})");
        }
    }
    let scopes = provider
        .get("scopes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if !scopes.is_empty() {
        println!("  scopes");
        for scope in scopes {
            println!(
                "    {}  {}",
                scope["name"].as_str().unwrap_or("-"),
                scope["description"].as_str().unwrap_or("")
            );
        }
    }
    if let Some(docs) = provider["docs_url"].as_str() {
        println!("  docs         {docs}");
    }
    println!();
    println!("EXAMPLES:");
    println!("    opensesame connect create {id} --name acme");
    match auth {
        "api_key" => {
            println!("    opensesame connect create {id} --name acme --data @key.json");
            println!("    # key.json → {{\"api_key\":\"…\"}}");
        }
        "configuration" => {
            println!("    opensesame connect create {id} --name acme --param region=us-east-1 --data @creds.json");
        }
        _ => {
            println!("    opensesame connect create {id} --name acme");
            println!(
                "    # opens the provider sign-in URL when the Host has a client registration"
            );
        }
    }
    println!("    opensesame connect attach {id}/acme --project prj_01J…");
    println!("    REF=$(opensesame connect token {id}/acme)");
}

fn operator_header() -> String {
    let op =
        env::var("OPENSESAME_OPERATOR_TOKEN").unwrap_or_else(|_| "opensesame-dev-operator".into());
    format!("Bearer operator:{op}")
}

fn authorization_headers() -> Vec<String> {
    let mut headers = Vec::new();
    if let Ok(token) = crate::load_access_token() {
        if token.starts_with("operator:") || token.starts_with("opaque-session:") {
            headers.push(format!("Bearer {token}"));
        }
    }
    let operator = operator_header();
    if !headers.iter().any(|header| header == &operator) {
        headers.push(operator);
    }
    headers
}

pub(crate) async fn api(
    server: &str,
    method: reqwest::Method,
    path: &str,
    body: Option<&Value>,
) -> anyhow::Result<Value> {
    let url = format!("{}{path}", server.trim_end_matches('/'));
    let client = reqwest::Client::new();
    let mut last = json!({"error": "unauthorized"});
    let mut last_status = reqwest::StatusCode::UNAUTHORIZED;
    for auth in authorization_headers() {
        let mut req = client
            .request(method.clone(), &url)
            .header("authorization", &auth);
        if let Some(body) = body {
            req = req.json(body);
        }
        let response = req.send().await.context("calling Host API")?;
        last_status = response.status();
        let text = response.text().await.unwrap_or_default();
        last = if text.trim().is_empty() {
            json!({})
        } else {
            serde_json::from_str(&text).unwrap_or_else(|_| json!({ "raw": text }))
        };
        if last_status.is_success() {
            return Ok(last);
        }
        if last_status != reqwest::StatusCode::UNAUTHORIZED
            && last_status != reqwest::StatusCode::FORBIDDEN
        {
            break;
        }
    }
    let hint = last
        .get("hint")
        .or_else(|| last.get("error"))
        .and_then(Value::as_str)
        .unwrap_or(last_status.as_str());
    bail!("Host API {last_status}: {hint}");
}

fn warn_passkey_fallback() {
    eprintln!(
        "If the browser asks for a passkey, this CLI is not your phone or YubiKey. Use TOTP, email, or approve on your phone, then return here."
    );
}

/// Opt-in local doctor for CLIs we can probe without reading the user's disk.
fn local_cli_status(service: &str) -> Option<String> {
    let (bin, args): (&str, &[&str]) = match service {
        "github" => ("gh", &["auth", "status"]),
        "vercel" => ("vercel", &["whoami"]),
        _ => return None,
    };
    let output = Command::new(bin).args(args).output().ok()?;
    Some(summarize_cli_probe(
        bin,
        output.status.success(),
        &String::from_utf8_lossy(&output.stdout),
        &String::from_utf8_lossy(&output.stderr),
    ))
}

fn summarize_cli_probe(bin: &str, ok: bool, stdout: &str, stderr: &str) -> String {
    let combined = format!("{stdout}\n{stderr}");
    let line = combined
        .lines()
        .map(str::trim)
        .find(|row| !row.is_empty())
        .unwrap_or(if ok { "signed in" } else { "not signed in" });
    format!("{bin}: {line}")
}

fn open_url(url: &str) {
    let commands = if cfg!(target_os = "macos") {
        vec!["open"]
    } else if cfg!(target_os = "windows") {
        vec!["cmd", "/C", "start"]
    } else {
        vec!["xdg-open"]
    };
    let mut iter = commands.into_iter();
    let Some(program) = iter.next() else {
        return;
    };
    let mut cmd = Command::new(program);
    for arg in iter {
        cmd.arg(arg);
    }
    let _ = cmd.arg(url).spawn();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uid_parses_logical_id_and_ref() {
        assert_eq!(
            parse_uid("github/acme"),
            ConnectorUid::Logical("github/acme".into())
        );
        assert_eq!(
            parse_uid("connection:01JABC"),
            ConnectorUid::Id("connection:01JABC".into())
        );
        assert_eq!(
            parse_uid("conn://org/github/main"),
            ConnectorUid::Ref("conn://org/github/main".into())
        );
    }

    #[test]
    fn instance_name_becomes_service_slash_name() {
        assert_eq!(
            logical_name_for("shopify", Some("acme-shop")).as_deref(),
            Some("shopify/acme-shop")
        );
        assert_eq!(
            logical_name_for("shopify", Some("shopify/acme-shop")).as_deref(),
            Some("shopify/acme-shop")
        );
        assert_eq!(logical_name_for("shopify", None), None);
    }

    #[test]
    fn params_require_equals() {
        let parsed = parse_params(&["region=us-east-1".into(), "vault=prod".into()]).unwrap();
        assert_eq!(parsed["region"], "us-east-1");
        assert_eq!(parsed["vault"], "prod");
        assert!(parse_params(&["nope".into()]).is_err());
    }

    #[test]
    fn data_accepts_object_or_bare_key() {
        let object = parse_data_json(r#"{"api_key":"sk-test"}"#).unwrap();
        assert_eq!(object["api_key"], "sk-test");
        let bare = parse_data_json("sk-inline").unwrap();
        assert_eq!(bare["api_key"], "sk-inline");
    }

    #[test]
    fn data_reads_from_file() {
        let path = std::env::temp_dir().join(format!(
            "opensesame-connect-data-{}.json",
            std::process::id()
        ));
        fs::write(&path, r#"{"region":"eu-west-1"}"#).unwrap();
        let parsed = parse_data_json(&format!("@{}", path.display())).unwrap();
        assert_eq!(parsed["region"], "eu-west-1");
        let _ = fs::remove_file(path);
    }

    #[test]
    fn cli_probe_summarizes_first_line_without_secrets() {
        assert_eq!(
            summarize_cli_probe(
                "gh",
                true,
                "Logged in to github.com as tyler\n  ✓ Token: gho_secret\n",
                ""
            ),
            "gh: Logged in to github.com as tyler"
        );
        assert_eq!(
            summarize_cli_probe("vercel", false, "", "Error: Not logged in."),
            "vercel: Error: Not logged in."
        );
    }

    #[test]
    fn service_help_mentions_token_is_a_connection_ref() {
        let provider = json!({
            "id": "github",
            "display_name": "GitHub",
            "auth_kind": "oauth2_authorization_code",
            "configured": true,
            "auto_configurable": false,
            "callback_url": "http://127.0.0.1:8787/api/v1/oauth/callback/github",
            "missing_config": [],
            "docs_url": "https://docs.github.com",
            "connection_configuration_fields": [],
            "scopes": [{"name":"read:user","description":"Read profile","sensitive":false,"default":true}]
        });
        print_service_help(&provider);
    }
}
