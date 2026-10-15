//! How the operator confirms root-trust enrollment on this host (D7-2 U4).
//!
//! Prefer an OS-provided secure prompt. Headless hosts without one refuse unless
//! `--allow-tty-enroll` is set, which reads confirmation from `/dev/tty` after a
//! printed risk notice.

use std::io::{BufRead, Write};
use std::process::{Command, Stdio};

/// Recorded on the daemon after a successful finish.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EnrollEntryMethod {
    SecurePrompt,
    TtyOptIn,
}

impl EnrollEntryMethod {
    #[must_use]
    pub fn header_value(self) -> &'static str {
        match self {
            Self::SecurePrompt => "secure-prompt",
            Self::TtyOptIn => "tty-opt-in",
        }
    }
}

const TTY_PHRASE: &str = "ENROLL";

/// Ask the operator to approve enrolling the daemon root trust key on this machine.
///
/// # Errors
///
/// Refuses when no secure prompt exists and `allow_tty_enroll` is false.
pub fn confirm_enrollment(allow_tty_enroll: bool) -> anyhow::Result<EnrollEntryMethod> {
    if try_secure_prompt()? {
        return Ok(EnrollEntryMethod::SecurePrompt);
    }
    if allow_tty_enroll {
        confirm_on_tty()?;
        return Ok(EnrollEntryMethod::TtyOptIn);
    }
    anyhow::bail!(
        "no OS secure prompt is available on this host; pass --allow-tty-enroll to confirm on /dev/tty (weaker: another session on this machine could observe input)"
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

fn confirm_on_tty() -> anyhow::Result<()> {
    eprintln!(
        "Warning: /dev/tty enrollment is weaker than an OS secure prompt — another session on this host may observe what you type."
    );
    let mut tty = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open("/dev/tty")
        .map_err(|_| anyhow::anyhow!("/dev/tty is not available"))?;
    let prompt = format!("Type {TTY_PHRASE} to enroll the daemon CLI root trust key: ");
    tty.write_all(prompt.as_bytes())?;
    tty.flush()?;
    let mut line = String::new();
    let mut reader = std::io::BufReader::new(&mut tty);
    reader.read_line(&mut line)?;
    let trimmed = line.trim();
    if trimmed != TTY_PHRASE {
        anyhow::bail!("enrollment cancelled");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn header_values_are_stable() {
        assert_eq!(
            EnrollEntryMethod::SecurePrompt.header_value(),
            "secure-prompt"
        );
        assert_eq!(EnrollEntryMethod::TtyOptIn.header_value(), "tty-opt-in");
    }
}
