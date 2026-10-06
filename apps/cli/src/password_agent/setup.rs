use clap::Args;
use opensesame_connector_host::password_agent::{reference, service as policy, writes};
use serde_json::{json, Value};
use std::process::Stdio;
#[derive(Args, Debug)]
pub(crate) struct Options {
    #[arg(long, default_value = "OpenSesame Automation")]
    name: String,
    #[arg(long)]
    vault: String,
    #[arg(long)]
    save_vault: String,
    #[arg(long)]
    account: Option<String>,
    #[arg(long)]
    create_vault: bool,
    #[arg(long)]
    write: bool,
    #[arg(long)]
    expires_in: Option<String>,
}
pub(super) fn storage() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos-keychain"
    } else if cfg!(windows) {
        "windows-dpapi"
    } else {
        "secret-service"
    }
}
fn desktop(args: &[String], account: Option<&str>, input: Option<&[u8]>) -> anyhow::Result<Value> {
    serde_json::from_slice(&desktop_raw(args, account, input)?)
        .map_err(|_| anyhow::anyhow!("Invalid administrator metadata (details suppressed)"))
}
fn desktop_raw(
    args: &[String],
    account: Option<&str>,
    input: Option<&[u8]>,
) -> anyhow::Result<Vec<u8>> {
    use std::io::Write;
    let mut command = super::io::helper("op")?;
    command
        .args(args)
        .env_remove("OP_SERVICE_ACCOUNT_TOKEN")
        .env_remove("OP_CONNECT_TOKEN")
        .env_remove("OP_CONNECT_HOST")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        });
    if let Some(account) = account {
        command.args(["--account", account]);
    }
    let mut child = command.spawn()?;
    if let Some(input) = input {
        if let Some(mut stdin) = child.stdin.take() {
            stdin.write_all(input)?;
        }
    }
    let output = child.wait_with_output()?;
    anyhow::ensure!(
        output.status.success(),
        "Administrator operation failed; inspect before retrying (details suppressed)"
    );
    Ok(output.stdout)
}
pub(super) fn visible(token: &str) -> anyhow::Result<Vec<Value>> {
    let output = super::io::helper("op")?
        .args(["vault", "list", "--format", "json"])
        .env("OP_SERVICE_ACCOUNT_TOKEN", token)
        .env_remove("OP_ACCOUNT")
        .env_remove("OP_CONNECT_HOST")
        .env_remove("OP_CONNECT_TOKEN")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()?;
    anyhow::ensure!(
        output.status.success(),
        "Could not verify saved service account; desktop authentication was not attempted"
    );
    let values: Value = serde_json::from_slice(&output.stdout)
        .map_err(|_| anyhow::anyhow!("Invalid vault metadata"))?;
    let values = values
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("Invalid vault metadata"))?;
    anyhow::ensure!(
        values
            .iter()
            .all(|v| v["id"].is_string() && v["name"].is_string()),
        "Invalid vault metadata"
    );
    Ok(values
        .iter()
        .map(|v| json!({"id":v["id"],"name":v["name"]}))
        .collect())
}
pub(super) fn run(options: Options) -> anyhow::Result<()> {
    let name = options.name.trim();
    let vault_name = options.vault.trim();
    let backup_name = options.save_vault.trim();
    let account = options.account.as_deref();
    policy::validate_setup(name, vault_name, backup_name, options.expires_in.as_deref())?;
    super::credential::require_empty()?;
    let vaults = desktop(
        &[
            "vault".into(),
            "list".into(),
            "--format".into(),
            "json".into(),
        ],
        account,
        None,
    )?;
    let vaults = vaults
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("Invalid vault metadata"))?;
    let backup = policy::select(vaults, backup_name)?
        .ok_or_else(|| anyhow::anyhow!("Backup vault must identify an existing vault"))?;
    let backup_id = backup["id"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Invalid backup vault"))?;
    let title = format!("1Password {name} Service Account Token");
    let listed = desktop(
        &[
            "item".into(),
            "list".into(),
            "--vault".into(),
            backup_id.into(),
            "--format".into(),
            "json".into(),
        ],
        account,
        None,
    )?;
    let listed = listed
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("Invalid backup list"))?;
    writes::create_template(listed, &title, "preflight", None, None)?;
    let selected = policy::select(vaults, vault_name)?;
    let vault = if let Some(vault) = selected.as_ref() {
        vault.clone()
    } else {
        anyhow::ensure!(
            options.create_vault,
            "Automation vault is absent; use --create-vault"
        );
        let vault = desktop(
            &[
                "vault".into(),
                "create".into(),
                vault_name.into(),
                "--format".into(),
                "json".into(),
            ],
            account,
            None,
        )?;
        anyhow::ensure!(
            vault["name"] == vault_name,
            "Vault creation is unverified; inspect before retrying"
        );
        vault
    };
    let vault_id = vault["id"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Invalid automation vault"))?;
    policy::validate_destination(&vault, backup_id)?;
    let grant = policy::grant(vault_id, options.write)?;
    let mut args = vec![
        "service-account".into(),
        "create".into(),
        name.into(),
        "--vault".into(),
        grant,
        "--raw".into(),
    ];
    if let Some(duration) = options.expires_in {
        args.extend(["--expires-in".into(), duration]);
    }
    let raw = zeroize::Zeroizing::new(
        String::from_utf8(desktop_raw(&args, account, None)?)
            .map_err(|_| anyhow::anyhow!("Service account creation is unverified; do not retry"))?,
    );
    let token = policy::token(&raw)
        .map_err(|_| anyhow::anyhow!("Service account creation is unverified; do not retry"))?;
    super::credential::save(token)?;
    super::credential::save_settings(&json!({"name":name,"vaults":[vault.clone()]}))?;
    let visible = visible(token)?;
    policy::verify_visible(&visible, vault_id)?;
    let saved = store_backup(listed, &title, token, backup_id, account)?;
    super::credential::save_settings(
        &json!({"name":name,"vaults":visible,"tokenRef":saved["ref"]}),
    )?;
    super::print(
        &json!({"configured":true,"name":name,"vaults":visible,"write":options.write,"tokenRef":saved["ref"],"storage":storage(),"verified":true}),
    )
}

fn store_backup(
    listed: &[Value],
    title: &str,
    token: &str,
    backup_id: &str,
    account: Option<&str>,
) -> anyhow::Result<Value> {
    let template = writes::create_template(listed, title, token, None, None)?;
    let receipt = desktop(
        &[
            "item".into(),
            "create".into(),
            "-".into(),
            "--vault".into(),
            backup_id.into(),
            "--format".into(),
            "json".into(),
        ],
        account,
        Some(&serde_json::to_vec(&template)?),
    )?;
    reference(&receipt, "credential")?;
    let stored = desktop(
        &[
            "item".into(),
            "get".into(),
            receipt["id"].as_str().unwrap_or_default().into(),
            "--vault".into(),
            backup_id.into(),
            "--format".into(),
            "json".into(),
            "--reveal".into(),
        ],
        account,
        None,
    )
    .map_err(|_| {
        anyhow::anyhow!(
            "The account is saved locally, but its token backup is unverified; do not repeat setup"
        )
    })?;
    writes::verify_create(&receipt, &stored, &template, backup_id)
}
