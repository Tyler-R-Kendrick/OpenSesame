//! Native human-operated 1Password workflows; provider values never enter receipts.
mod consume;
mod credential;
mod io;
mod lease_store;
mod process_io;
mod request;
mod service;
mod setup;
use clap::{Args, Subcommand};
use opensesame_connector_host::password_agent::{self as core, discover, writes};
use serde_json::{json, Value};
#[derive(Args, Debug)]
pub(crate) struct Options {
    #[arg(long, global = true)]
    pub(super) desktop: bool,
    #[arg(long, global = true)]
    pub(super) reveal: bool,
    #[command(subcommand)]
    pub(super) cmd: Command,
}
#[derive(Args, Debug, Default)]
pub(crate) struct Scope {
    #[arg(long)]
    account: Option<String>,
    #[arg(long)]
    vault: Option<String>,
}
#[derive(Args, Debug)]
pub(crate) struct Source {
    #[arg(long, conflicts_with = "stdin", required_unless_present = "stdin")]
    clipboard: bool,
    #[arg(
        long,
        conflicts_with = "clipboard",
        required_unless_present = "clipboard"
    )]
    stdin: bool,
}
#[derive(Subcommand, Debug)]
pub(crate) enum Command {
    Find {
        #[arg(required = true)]
        queries: Vec<String>,
        #[command(flatten)]
        scope: Scope,
    },
    Inventory {
        #[command(flatten)]
        scope: Scope,
    },
    Audit {
        #[command(flatten)]
        scope: Scope,
    },
    Create {
        #[command(subcommand)]
        cmd: Create,
    },
    Password {
        item: String,
        #[arg(long)]
        vault: String,
        #[arg(long)]
        account: Option<String>,
        #[command(flatten)]
        source: Source,
        #[arg(long)]
        apply: bool,
        #[arg(long, requires = "apply")]
        repair_imported_fields: bool,
    },
    Read {
        reference: String,
    },
    Run {
        #[arg(long = "env", required = true)]
        env: Vec<String>,
        #[arg(last = true, required = true)]
        command: Vec<String>,
    },
    Env {
        #[command(subcommand)]
        cmd: consume::Env,
    },
    Doctor,
    Request(request::Request),
    Lease {
        #[command(subcommand)]
        cmd: request::LeaseCommand,
    },
    #[command(hide = true)]
    InternalExec {
        #[arg(last = true, required = true)]
        command: Vec<String>,
    },
    #[command(hide = true)]
    InternalBatch {
        count: usize,
    },
    ServiceAccount {
        #[command(subcommand)]
        cmd: service::Service,
    },
}
#[derive(Subcommand, Debug)]
pub(crate) enum Create {
    ApiCredential {
        #[arg(long)]
        title: String,
        #[arg(long)]
        vault: String,
        #[arg(long)]
        account: Option<String>,
        #[arg(long)]
        url: Option<String>,
        #[arg(long)]
        notes: Option<String>,
        #[command(flatten)]
        source: Source,
    },
}
fn print(value: &Value) -> anyhow::Result<()> {
    use std::io::Write;
    writeln!(
        std::io::stdout(),
        "{}",
        serde_json::to_string_pretty(value)?
    )?;
    Ok(())
}
fn list(scope: &Scope) -> anyhow::Result<Vec<Value>> {
    let mut args = vec![
        "item".into(),
        "list".into(),
        "--format".into(),
        "json".into(),
    ];
    if let Some(vault) = &scope.vault {
        args.extend(["--vault".into(), vault.clone()]);
    }
    let value = io::json(&args, scope.account.as_deref(), None)?;
    for item in value.as_array().into_iter().flatten() {
        core::validate_summary(item)?;
    }
    Ok(value
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("Invalid item list"))?
        .clone())
}
fn details(items: &[Value], scope: &Scope) -> anyhow::Result<Vec<Value>> {
    if items.is_empty() {
        return Ok(Vec::new());
    }
    let items = core::documents(&io::op(
        &[
            "item".into(),
            "get".into(),
            "-".into(),
            "--format".into(),
            "json".into(),
        ],
        scope.account.as_deref(),
        Some(&serde_json::to_vec(items)?),
    )?)?;
    for item in &items {
        core::validate_item(item)?;
    }
    Ok(items)
}
fn get(item: &str, vault: &str, account: Option<&str>) -> anyhow::Result<Value> {
    io::json(
        &[
            "item".into(),
            "get".into(),
            item.into(),
            "--vault".into(),
            vault.into(),
            "--format".into(),
            "json".into(),
            "--reveal".into(),
        ],
        account,
        None,
    )
}
pub(crate) async fn execute(options: Options) -> anyhow::Result<()> {
    run(options.cmd, options.desktop, options.reveal).await
}
pub(crate) async fn run(cmd: Command, desktop: bool, reveal: bool) -> anyhow::Result<()> {
    credential::DESKTOP.store(desktop, std::sync::atomic::Ordering::Relaxed);
    match cmd {
        Command::Find { queries, scope } => {
            let listed = list(&scope)?;
            let selections = discover::selection(&listed, &queries);
            let wanted: Vec<_> = listed
                .iter()
                .enumerate()
                .filter(|(i, _)| {
                    selections
                        .iter()
                        .any(|(_, a, b)| a.contains(i) || b.contains(i))
                })
                .map(|(_, v)| v.clone())
                .collect();
            print(&discover::find(
                &listed,
                &details(&wanted, &scope)?,
                &queries,
            ))?;
        }
        Command::Inventory { scope } => {
            print(&json!({"items":discover::inventory(&details(&list(&scope)?,&scope)?)}))?;
        }
        Command::Audit { scope } => {
            let now = chrono::Utc::now();
            let cutoff = now
                .checked_sub_months(chrono::Months::new(
                    u32::try_from(
                        core::policy::policy()
                            .old_login_years
                            .checked_mul(12)
                            .ok_or_else(|| anyhow::anyhow!("Invalid audit policy"))?,
                    )
                    .map_err(|_| anyhow::anyhow!("Invalid audit policy"))?,
                ))
                .ok_or_else(|| anyhow::anyhow!("Invalid audit date"))?
                .to_rfc3339();
            print(&discover::audit(&details(&list(&scope)?, &scope)?, &cutoff))?;
        }
        Command::Create { cmd } => create(cmd)?,
        Command::Password {
            item,
            vault,
            account,
            source,
            apply,
            repair_imported_fields,
        } => password(
            &item,
            &vault,
            account.as_deref(),
            &source,
            apply,
            repair_imported_fields,
        )?,
        Command::Read { reference } => consume::read(&reference, desktop, reveal)?,
        Command::Run { env, command } => consume::run_assignments(&env, &command, desktop)?,
        Command::Env { cmd } => consume::env(cmd, desktop, reveal)?,
        Command::InternalExec { command } => consume::internal_exec(&command)?,
        Command::InternalBatch { count } => consume::internal_batch(count)?,
        Command::Request(options) => request::execute(options).await?,
        Command::Lease { cmd } => request::lease(cmd).await?,
        Command::Doctor => print(&io::doctor())?,
        Command::ServiceAccount { cmd } => service::run(cmd)?,
    }
    Ok(())
}

fn create(cmd: Create) -> anyhow::Result<()> {
    let Create::ApiCredential {
        title,
        vault,
        account,
        url,
        notes,
        source,
    } = cmd;

    anyhow::ensure!(!vault.trim().is_empty(), "Explicit vault required");
    let input = io::private_input(&source)?;
    let credential = input
        .strip_suffix("\r\n")
        .or_else(|| input.strip_suffix('\n'))
        .unwrap_or(&input);
    let scope = Scope {
        account: account.clone(),
        vault: Some(vault.trim().into()),
    };
    let template = writes::create_template(
        &list(&scope)?,
        &title,
        credential,
        url.as_deref(),
        notes.as_deref(),
    )?;
    let receipt = io::json(
        &[
            "item".into(),
            "create".into(),
            "-".into(),
            "--vault".into(),
            vault.trim().into(),
            "--format".into(),
            "json".into(),
        ],
        account.as_deref(),
        Some(&serde_json::to_vec(&template)?),
    )
    .map_err(|_| anyhow::anyhow!("Creation may have succeeded; inspect before retrying"))?;
    core::reference(&receipt, "credential")?;
    let stored = get(
        receipt["id"].as_str().unwrap_or_default(),
        receipt["vault"]["id"].as_str().unwrap_or_default(),
        account.as_deref(),
    )
    .map_err(|_| anyhow::anyhow!("Creation is unverified; inspect before retrying"))?;
    print(&writes::verify_create(
        &receipt,
        &stored,
        &template,
        vault.trim(),
    )?)?;
    Ok(())
}

fn password(
    item: &str,
    vault: &str,
    account: Option<&str>,
    source: &Source,
    apply: bool,
    repair_imported_fields: bool,
) -> anyhow::Result<()> {
    let input = io::private_input(source)?;
    let before = get(item, vault, account)?;
    let mut receipt = writes::password_receipt(&before, &input)?;
    if !apply {
        print(&receipt)?;
    } else if receipt["matches"] == true {
        if let Some(o) = receipt.as_object_mut() {
            o.remove("matches");
        }
        receipt["changed"] = json!(false);
        receipt["verified"] = json!(true);
        print(&receipt)?;
    } else {
        let template = writes::password_template(&before, &input, repair_imported_fields)?;
        let id = before["id"].as_str().unwrap_or_default();
        let vault = before["vault"]["id"].as_str().unwrap_or_default();
        io::op(
            &[
                "item".into(),
                "edit".into(),
                id.into(),
                "--vault".into(),
                vault.into(),
                "--format".into(),
                "json".into(),
            ],
            account,
            Some(&serde_json::to_vec(&template)?),
        )
        .map_err(|_| anyhow::anyhow!("Password update is unverified; inspect before retrying"))?;
        print(&writes::verify_password(
            &before,
            &get(id, vault, account).map_err(|_| {
                anyhow::anyhow!("Password update is unverified; inspect before retrying")
            })?,
            &input,
        )?)?;
    }
    Ok(())
}
