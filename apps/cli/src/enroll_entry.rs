//! OS secure prompt for root-trust enrollment (D7-2 U4, revised).
//!
//! Headless hosts without a platform secure prompt refuse enrollment outright.
//! There is no `/dev/tty` or `--allow-tty-enroll` path — a pty is still a tty.

use std::process::{Command, Stdio};

/// Recorded on the daemon after a successful finish.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EnrollEntryMethod {
    SecurePrompt,
}

impl EnrollEntryMethod {
    #[must_use]
    pub fn header_value(self) -> &'static str {
        "secure-prompt"
    }
}

/// Ask the operator to approve enrolling the daemon root trust key on this machine.
///
/// # Errors
///
/// Refuses when no OS secure prompt is available (headless / unsupported host).
pub fn confirm_enrollment() -> anyhow::Result<EnrollEntryMethod> {
    if try_secure_prompt()? {
        return Ok(EnrollEntryMethod::SecurePrompt);
    }
    anyhow::bail!(
        "no OS secure prompt is available on this host; enroll from a machine with a desktop secure prompt, or join as a remote CLI endorsed from such a machine"
    );
}

fn try_secure_prompt() -> anyhow::Result<bool> {
    if cfg!(target_os = "macos") {
        return macos_secure_prompt();
    }
    if cfg!(target_os = "linux") {
        return linux_secure_prompt();
    }
    if cfg!(target_os = "windows") {
        return windows_secure_prompt();
    }
    Ok(false)
}

#[cfg(target_os = "macos")]
fn macos_secure_prompt() -> anyhow::Result<bool> {
    let script = r#"display dialog "Enroll the OpenSesame daemon CLI root trust key on this Mac?" buttons {"Cancel", "Enroll"} default button "Enroll" with title "OpenSesame" with icon caution"#;
    let output = Command::new("osascript")
        .args(["-e", script])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output();
    match output {
        Ok(out) if out.status.success() => Ok(true),
        Ok(_) => Ok(false),
        Err(_) => Ok(false),
    }
}

#[cfg(not(target_os = "macos"))]
fn macos_secure_prompt() -> anyhow::Result<bool> {
    Ok(false)
}

#[cfg(target_os = "linux")]
fn linux_secure_prompt() -> anyhow::Result<bool> {
    if systemd_ask_password()? {
        return Ok(true);
    }
    if zenity_question()? {
        return Ok(true);
    }
    Ok(false)
}

#[cfg(not(target_os = "linux"))]
fn linux_secure_prompt() -> anyhow::Result<bool> {
    Ok(false)
}

#[cfg(target_os = "linux")]
fn systemd_ask_password() -> anyhow::Result<bool> {
    let output = Command::new("systemd-ask-password")
        .args([
            "--icon=dialog-password",
            "OpenSesame: enroll CLI root trust on this host? (press Enter to continue, Ctrl+C to cancel)",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .status();
    match output {
        Ok(status) if status.success() => Ok(true),
        _ => Ok(false),
    }
}

#[cfg(not(target_os = "linux"))]
fn systemd_ask_password() -> anyhow::Result<bool> {
    Ok(false)
}

#[cfg(target_os = "linux")]
fn zenity_question() -> anyhow::Result<bool> {
    if std::env::var_os("DISPLAY").is_none() && std::env::var_os("WAYLAND_DISPLAY").is_none() {
        return Ok(false);
    }
    let output = Command::new("zenity")
        .args([
            "--question",
            "--title=OpenSesame",
            "--text=Enroll the daemon CLI root trust key on this machine?",
            "--ok-label=Enroll",
            "--cancel-label=Cancel",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    match output {
        Ok(status) if status.success() => Ok(true),
        _ => Ok(false),
    }
}

#[cfg(not(target_os = "linux"))]
fn zenity_question() -> anyhow::Result<bool> {
    Ok(false)
}

#[cfg(target_os = "windows")]
fn windows_secure_prompt() -> anyhow::Result<bool> {
    let script = r#"
Add-Type -AssemblyName System.Windows.Forms
$result = [System.Windows.Forms.MessageBox]::Show(
  'Enroll the OpenSesame daemon CLI root trust key on this machine?',
  'OpenSesame',
  [System.Windows.Forms.MessageBoxButtons]::OKCancel,
  [System.Windows.Forms.MessageBoxIcon]::Warning
)
if ($result -eq [System.Windows.Forms.DialogResult]::OK) { exit 0 } else { exit 1 }
"#;
    let output = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    match output {
        Ok(status) if status.success() => Ok(true),
        _ => Ok(false),
    }
}

#[cfg(not(target_os = "windows"))]
fn windows_secure_prompt() -> anyhow::Result<bool> {
    Ok(false)
}
