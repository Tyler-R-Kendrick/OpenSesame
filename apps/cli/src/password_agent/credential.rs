//! Private stdin transport to platform-native protected credential stores.
pub(super) static DESKTOP: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);
use std::{
    io::Write,
    process::{Command, Stdio},
};
const MAC: &str = include_str!("../../../../packages/cli/src/parity-assets/keychain.jxa.js");
const WINDOWS: &str = include_str!("../../../../packages/cli/src/parity-assets/credential.win.ps1");
pub(super) fn operate(action: &str, token: Option<&str>) -> anyhow::Result<String> {
    let mut script = tempfile::Builder::new()
        .suffix(if cfg!(windows) { ".ps1" } else { ".js" })
        .tempfile()?;
    let mut command = if cfg!(target_os = "macos") {
        script.write_all(MAC.as_bytes())?;
        let mut c = super::io::helper("osascript")?;
        c.args(["-l", "JavaScript"]).arg(script.path()).args([
            action,
            "dev.opensesame.password-agent",
            "service-account",
        ]);
        c
    } else if cfg!(windows) {
        script.write_all(WINDOWS.as_bytes())?;
        let mut c = super::io::helper("powershell.exe")?;
        c.args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ])
        .arg(script.path())
        .args([action, "dev.opensesame.password-agent", "service-account"]);
        c
    } else {
        let mut c = super::io::helper("secret-tool")?;
        c.arg(match action {
            "get" | "exists" => "lookup",
            "add" => "store",
            "remove" => "clear",
            _ => anyhow::bail!("Invalid credential operation"),
        });
        if action == "add" {
            c.arg("--label=OpenSesame 1Password service account");
        }
        c.args([
            "application",
            "opensesame",
            "credential",
            "1password-service-account",
        ]);
        c
    };
    command
        .env_remove("OP_SERVICE_ACCOUNT_TOKEN")
        .env_remove("NODE_OPTIONS")
        .env_remove("BUN_OPTIONS")
        .stdin(if token.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = command
        .spawn()
        .map_err(|_| anyhow::anyhow!("OS credential store unavailable"))?;
    if let Some(token) = token {
        if let Some(mut stdin) = child.stdin.take() {
            stdin.write_all(token.as_bytes())?;
        }
    }
    let mut output = super::process_io::capture(child, None)?;
    if action == "exists" && cfg!(target_os = "linux") {
        anyhow::ensure!(
            output.status.success() || output.status.code() == Some(1),
            "OS credential status is unavailable"
        );
        return Ok(if output.status.success() {
            "found"
        } else {
            "missing"
        }
        .into());
    }
    anyhow::ensure!(
        output.status.success(),
        "OS credential operation failed (details suppressed)"
    );
    String::from_utf8(std::mem::take(&mut *output.stdout))
        .map_err(|_| anyhow::anyhow!("Invalid credential store response"))
}
pub(super) fn exists() -> anyhow::Result<bool> {
    match operate("exists", None)?.trim() {
        "found" => Ok(true),
        "missing" => Ok(false),
        _ => anyhow::bail!("Invalid credential status"),
    }
}
pub(super) fn load() -> anyhow::Result<Option<zeroize::Zeroizing<String>>> {
    if !exists()? {
        return Ok(None);
    }
    Ok(Some(zeroize::Zeroizing::new(
        operate("get", None)?
            .trim_end_matches(['\r', '\n'])
            .to_owned(),
    )))
}
pub(super) fn save(token: &str) -> anyhow::Result<()> {
    operate("add", Some(token))?;
    anyhow::ensure!(
        load()?.as_deref().map(String::as_str) == Some(token),
        "Credential read-back failed; do not retry account creation"
    );
    Ok(())
}
pub(super) fn configured() -> bool {
    settings_path().is_ok_and(|p| p.exists())
}
fn settings_path() -> anyhow::Result<std::path::PathBuf> {
    Ok(directories::BaseDirs::new()
        .ok_or_else(|| anyhow::anyhow!("Could not locate service-account settings"))?
        .config_dir()
        .join("opensesame/password-agent.json"))
}
pub(super) fn save_settings(value: &serde_json::Value) -> anyhow::Result<()> {
    let path = settings_path()?;
    let parent = path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("Invalid settings path"))?;
    std::fs::create_dir_all(parent)?;
    let token = load()?
        .ok_or_else(|| anyhow::anyhow!("Saved token unavailable; settings were not saved"))?;
    let key = settings_key(&token)?;
    let envelope =
        opensesame_human_vault::encrypt_item(&key, &serde_json::to_vec(value)?, settings_ad())?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        temporary
            .as_file()
            .set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    temporary.write_all(&serde_json::to_vec(&envelope)?)?;
    temporary.persist(path)?;
    Ok(())
}
pub(super) fn remove_settings() -> anyhow::Result<()> {
    let path = settings_path()?;
    if path.exists() {
        std::fs::remove_file(path)?;
    }
    Ok(())
}
pub(super) fn authenticate(command: &mut Command) -> anyhow::Result<()> {
    if DESKTOP.load(std::sync::atomic::Ordering::Relaxed) {
        command
            .env_remove("OP_SERVICE_ACCOUNT_TOKEN")
            .env_remove("OP_CONNECT_TOKEN")
            .env_remove("OP_CONNECT_HOST");
        return Ok(());
    }
    if let Some(token) = std::env::var_os("OP_SERVICE_ACCOUNT_TOKEN") {
        command
            .env("OP_SERVICE_ACCOUNT_TOKEN", token)
            .env_remove("OP_ACCOUNT")
            .env_remove("OP_CONNECT_TOKEN")
            .env_remove("OP_CONNECT_HOST");
    } else if configured() {
        settings()?;
        let token = load()?.ok_or_else(|| {
            anyhow::anyhow!(
                "Saved service account is unavailable; desktop authentication was not attempted"
            )
        })?;
        command
            .env("OP_SERVICE_ACCOUNT_TOKEN", token.as_str())
            .env_remove("OP_ACCOUNT")
            .env_remove("OP_CONNECT_TOKEN")
            .env_remove("OP_CONNECT_HOST");
    } else if exists()? {
        anyhow::bail!(
            "A saved service token has no valid settings; use service-account recover or --desktop"
        );
    }
    Ok(())
}

pub(super) fn settings() -> anyhow::Result<serde_json::Value> {
    let token = load()?
        .ok_or_else(|| anyhow::anyhow!("Saved token unavailable; use recover or --desktop"))?;
    let envelope: opensesame_human_vault::EncryptedEnvelope =
        serde_json::from_slice(&std::fs::read(settings_path()?)?).map_err(|_| {
            anyhow::anyhow!("Invalid saved service-account envelope; use recover or --desktop")
        })?;
    let clear = zeroize::Zeroizing::new(
        opensesame_human_vault::decrypt_item_with_ad(
            &settings_key(&token)?,
            &envelope,
            &settings_ad(),
        )
        .map_err(|_| {
            anyhow::anyhow!(
                "Saved service-account settings could not be decrypted; use recover or --desktop"
            )
        })?,
    );
    let value: serde_json::Value = serde_json::from_slice(&clear)
        .map_err(|_| anyhow::anyhow!("Invalid saved service-account metadata"))?;
    anyhow::ensure!(
        value["name"].is_string(),
        "Invalid saved service-account name"
    );
    if let Some(vaults) = value.get("vaults") {
        anyhow::ensure!(
            vaults.as_array().is_some_and(|vaults| vaults
                .iter()
                .all(|v| v["id"].is_string() && v["name"].is_string())),
            "Invalid saved vault metadata"
        );
    }
    anyhow::ensure!(
        value
            .get("tokenRef")
            .is_none_or(serde_json::Value::is_string),
        "Invalid saved token reference"
    );
    if let Some(reference) = value["tokenRef"].as_str() {
        anyhow::ensure!(
            regex::Regex::new(r"^op://[a-z0-9]{26}/[a-z0-9]{26}/credential$")?.is_match(reference),
            "Invalid saved token reference"
        );
    }
    Ok(value)
}
fn settings_key(token: &str) -> anyhow::Result<opensesame_human_vault::ItemDataKey> {
    Ok(opensesame_human_vault::ItemDataKey(
        opensesame_human_vault::kek_from_webauthn_prf(
            token.as_bytes(),
            b"opensesame/password-agent/settings/v1",
        )?,
    ))
}
fn settings_ad() -> opensesame_human_vault::AssociatedData {
    opensesame_human_vault::AssociatedData {
        envelope_version: 1,
        item_id: "password-agent-settings".into(),
        organization_id: "device".into(),
        project_id: "password-agent".into(),
        collection_id: "service-account".into(),
        key_id: "os-credential-store".into(),
        revision: 1,
    }
}

pub(super) fn require_empty() -> anyhow::Result<()> {
    anyhow::ensure!(
        !configured() && !exists()?,
        "A local service account exists; inspect status or recover before setup"
    );
    Ok(())
}
