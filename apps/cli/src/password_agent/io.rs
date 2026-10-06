use super::Source;
use serde_json::{json, Value};
use std::{
    io::{Read, Write},
    process::{Command, Stdio},
};
pub(super) fn helper(name: &str) -> anyhow::Result<Command> {
    let mut command = Command::new(program(name)?);
    scrub_startup(&mut command);
    Ok(command)
}
fn scrub_startup(command: &mut Command) {
    command.env_remove("OP_SERVICE_ACCOUNT_TOKEN");
    for key in
        &opensesame_connector_host::password_agent::policy::policy().credential_startup_env_keys
    {
        command.env_remove(key);
    }
    for (key, _) in std::env::vars_os() {
        if key
            .to_str()
            .is_some_and(opensesame_connector_host::password_agent::env::credential_startup_key)
        {
            command.env_remove(key);
        }
    }
}
/// One invocation, no retry, no provider stderr in errors.
pub(super) fn op(
    args: &[String],
    account: Option<&str>,
    input: Option<&[u8]>,
) -> anyhow::Result<Vec<u8>> {
    let mut command = helper("op")?;
    super::credential::authenticate(&mut command)?;
    command
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if let Some(account) = account {
        anyhow::ensure!(
            super::credential::DESKTOP.load(std::sync::atomic::Ordering::Relaxed)
                || (std::env::var_os("OP_SERVICE_ACCOUNT_TOKEN").is_none()
                    && !super::credential::configured()),
            "Account selection is unavailable with service-account authentication"
        );
        command.args(["--account", account]);
    }
    command.stdin(if input.is_some() {
        Stdio::piped()
    } else {
        Stdio::null()
    });
    let mut child = command
        .spawn()
        .map_err(|_| anyhow::anyhow!("1Password CLI could not be started"))?;
    if let Some(input) = input {
        if let Some(mut stdin) = child.stdin.take() {
            stdin.write_all(input)?;
        }
    }
    let output = child.wait_with_output()?;
    anyhow::ensure!(
        output.status.success(),
        "1Password command failed (provider details suppressed)"
    );
    Ok(output.stdout)
}
pub(super) fn json(
    args: &[String],
    account: Option<&str>,
    input: Option<&[u8]>,
) -> anyhow::Result<Value> {
    serde_json::from_slice(&op(args, account, input)?)
        .map_err(|_| anyhow::anyhow!("1Password returned invalid JSON"))
}
pub(super) fn private_input(source: &Source) -> anyhow::Result<zeroize::Zeroizing<String>> {
    let mut input = String::new();
    if source.stdin {
        use std::io::IsTerminal;
        anyhow::ensure!(
            !std::io::stdin().is_terminal(),
            "Pipe private input through stdin"
        );
        std::io::stdin().read_to_string(&mut input)?;
    } else {
        let output = if cfg!(target_os = "macos") {
            helper("pbpaste")?.output()
        } else if cfg!(windows) {
            windows_clipboard_command(helper("powershell.exe")?).output()
        } else {
            helper("wl-paste")?
                .arg("--no-newline")
                .output()
                .or_else(|_| {
                    helper("xclip")
                        .map_err(std::io::Error::other)?
                        .args(["-selection", "clipboard", "-o"])
                        .output()
                })
        }
        .map_err(|_| anyhow::anyhow!("Clipboard unavailable"))?;
        anyhow::ensure!(output.status.success(), "Clipboard unavailable");
        input = String::from_utf8(output.stdout)
            .map_err(|_| anyhow::anyhow!("Private input must be UTF-8"))?;
    }
    anyhow::ensure!(!input.is_empty(), "Private input is empty");
    Ok(zeroize::Zeroizing::new(input))
}
fn windows_clipboard_command(mut command: Command) -> Command {
    command.args(["-NoProfile", "-NonInteractive", "-Command", "[Console]::OutputEncoding = [Text.Encoding]::UTF8; $v = Get-Clipboard -Raw; if ($null -ne $v) { [Console]::Out.Write($v) }"]);
    command
}
fn local(args: &[&str]) -> Option<Vec<u8>> {
    let mut child = helper("op")
        .ok()?
        .env_remove("OP_SERVICE_ACCOUNT_TOKEN")
        .env_remove("NODE_OPTIONS")
        .env_remove("BUN_OPTIONS")
        .env_remove("LD_PRELOAD")
        .env_remove("DYLD_INSERT_LIBRARIES")
        .args(args)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .stdout(Stdio::piped())
        .spawn()
        .ok()?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        if let Some(status) = child.try_wait().ok()? {
            return status
                .success()
                .then(|| child.wait_with_output().ok().map(|o| o.stdout))
                .flatten();
        }
        if std::time::Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
}
pub(super) fn doctor() -> Value {
    let version = local(&["--version"])
        .and_then(|v| String::from_utf8(v).ok())
        .map(|s| s.trim().to_owned())
        .filter(|s| {
            s.len() < 80
                && s.chars()
                    .all(|c| c.is_ascii_digit() || ['.', '-'].contains(&c))
        });
    let accounts = version
        .as_ref()
        .and_then(|_| local(&["account", "list", "--format", "json"]))
        .and_then(|v| serde_json::from_slice::<Value>(&v).ok())
        .and_then(|v| v.as_array().map(Vec::len));
    let auth = if std::env::var_os("OP_SERVICE_ACCOUNT_TOKEN").is_some() {
        "environment service account"
    } else if super::credential::configured() {
        "saved service account"
    } else {
        "desktop app"
    };
    let mut notes = Vec::new();
    if version.is_none() {
        notes.push(
            "Install the 1Password CLI: https://developer.1password.com/docs/cli/get-started/",
        );
    }
    if auth == "desktop app" && accounts == Some(0) {
        notes.push("Enable Integrate with 1Password CLI in the desktop app's Developer settings.");
    }
    if auth == "desktop app" && version.is_some() {
        notes.push("Desktop approvals last per terminal session; batch lookups or set up a service account for unattended access.");
    }
    json!({"opensesame":env!("CARGO_PKG_VERSION"),"opInstalled":version.is_some(),"opVersion":version,"accounts":accounts,"auth":auth,"serviceAccountTokenPresent":std::env::var_os("OP_SERVICE_ACCOUNT_TOKEN").is_some(),"platform":std::env::consts::OS,"notes":notes})
}
/// Credential helpers are resolved only through absolute PATH directories.
pub(super) fn program(name: &str) -> anyhow::Result<std::path::PathBuf> {
    anyhow::ensure!(
        [
            "op",
            "powershell.exe",
            "pbpaste",
            "wl-paste",
            "xclip",
            "osascript",
            "secret-tool"
        ]
        .contains(&name),
        "Unsupported credential helper"
    );
    let executable = if cfg!(windows)
        && std::path::Path::new(name).extension() != Some(std::ffi::OsStr::new("exe"))
    {
        format!("{name}.exe")
    } else {
        name.to_owned()
    };
    let cwd = std::env::current_dir()
        .ok()
        .and_then(|p| p.canonicalize().ok());
    for directory in std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()) {
        if !directory.is_absolute() || directory.canonicalize().ok() == cwd {
            continue;
        }
        let candidate = directory.join(&executable);
        if !candidate.is_file() {
            continue;
        }
        #[cfg(unix)]
        if !executable_file(&candidate)? {
            continue;
        }
        return Ok(candidate);
    }
    anyhow::bail!("Required credential helper was not found in absolute PATH directories")
}

#[cfg(unix)]
fn executable_file(path: &std::path::Path) -> anyhow::Result<bool> {
    use std::os::unix::fs::PermissionsExt;
    Ok(path.metadata()?.permissions().mode() & 0o111 != 0)
}

/// Private bounded read: kill the helper at the deadline, suppress all diagnostics.
pub(super) fn op_timeout(args: &[String], timeout: std::time::Duration) -> anyhow::Result<Vec<u8>> {
    let mut command = helper("op")?;
    super::credential::authenticate(&mut command)?;
    let child = command
        .args(args)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .stdout(Stdio::piped())
        .spawn()
        .map_err(|_| anyhow::anyhow!("Credential helper could not be started"))?;
    let output = super::process_io::capture(child, Some(std::time::Instant::now() + timeout))?;
    anyhow::ensure!(
        output.status.success(),
        "Credential read failed; lease use consumed"
    );
    let mut bytes = output.stdout;
    Ok(std::mem::take(&mut *bytes))
}

#[cfg(test)]
mod tests {
    #[test]
    fn shared_startup_assignments_and_templates_are_rejected_before_credentials() {
        use opensesame_connector_host::password_agent::{env, policy};
        for key in &policy::policy().credential_startup_env_keys {
            assert!(
                env::validate_run_assignments(&[format!("{key}=op://Vault/Item/secret")]).is_err()
            );
            assert!(env::validate_run_template(&format!("export {key}=hook")).is_err());
        }
        assert!(env::validate_run_template("API=op://Vault/Item/secret").is_ok());
        assert!(env::validate_run_template("API=ordinary\rNODE_OPTIONS=hook").is_err());
        assert!(env::validate_run_assignments(&["API=op://Vault/Item/secret".into()]).is_ok());
    }

    #[test]
    fn every_reserved_startup_key_is_removed_before_helper_authentication() {
        let mut command = std::process::Command::new("trusted-helper");
        command.env("ORDINARY_SETTING", "retained");
        super::scrub_startup(&mut command);
        let environment: std::collections::BTreeMap<_, _> = command.get_envs().collect();
        for key in
            &opensesame_connector_host::password_agent::policy::policy().credential_startup_env_keys
        {
            assert_eq!(environment.get(std::ffi::OsStr::new(key)), Some(&None));
        }
        assert_eq!(
            environment.get(std::ffi::OsStr::new("OP_SERVICE_ACCOUNT_TOKEN")),
            Some(&None)
        );
        assert_eq!(
            environment.get(std::ffi::OsStr::new("ORDINARY_SETTING")),
            Some(&Some(std::ffi::OsStr::new("retained")))
        );
    }

    #[test]
    fn windows_clipboard_command_uses_utf8_exact_output_without_profiles() {
        let command =
            super::windows_clipboard_command(std::process::Command::new("trusted-powershell.exe"));
        let args: Vec<_> = command.get_args().map(|s| s.to_str().unwrap()).collect();
        assert_eq!(&args[..3], &["-NoProfile", "-NonInteractive", "-Command"]);
        assert!(args[3].contains("OutputEncoding = [Text.Encoding]::UTF8"));
        assert!(args[3].contains("[Console]::Out.Write($v)"));
        assert!(!args[3].contains("Write-Output"));
        assert!(!args[3].contains("WriteLine"));
    }
}
