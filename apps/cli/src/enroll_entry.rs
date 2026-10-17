//! OS secure prompt for root-trust enrollment (D7-2 U4, revised).
//!
//! Headless hosts without a platform secure prompt refuse enrollment outright.
//! There is no `/dev/tty` or `--allow-tty-enroll` path — a pty is still a tty.

use std::process::{Command, Stdio};

use opensesame_trusted_exec::{command_in, pass_in, Lookup, Pass};

/// What a graphical prompt is handed besides `PATH` (the trusted entries) and
/// the common set: the desktop session it draws on. Nothing else this process
/// holds goes with it.
#[cfg(any(target_os = "linux", all(test, unix)))]
const DESKTOP: [Pass; 5] = [
    Pass::Name("DISPLAY"),
    Pass::Name("WAYLAND_DISPLAY"),
    Pass::Name("XAUTHORITY"),
    Pass::Name("XDG_RUNTIME_DIR"),
    Pass::Name("DBUS_SESSION_BUS_ADDRESS"),
];

/// What `PowerShell` needs on Windows beyond the common set: the profile folders.
#[cfg(target_os = "windows")]
const WINDOWS_PROFILE: [Pass; 2] = [Pass::Name("APPDATA"), Pass::Name("LOCALAPPDATA")];

/// The prompt `program` on a trusted `PATH` entry, handed `extra`; `None` when
/// there is none, which refuses enrollment like a missing prompt always has.
fn prompt_in(program: &str, extra: &[Pass], lookup: &Lookup) -> Option<Command> {
    let mut command = command_in(program, None, lookup).ok()?;
    pass_in(&mut command, extra, lookup);
    Some(command)
}

#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
fn prompt(program: &str, extra: &[Pass]) -> Option<Command> {
    prompt_in(program, extra, &Lookup::capture())
}

/// Recorded on the daemon after a successful finish.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EnrollEntryMethod {
    SecurePrompt,
}

impl EnrollEntryMethod {
    #[must_use]
    pub fn header_value(self) -> &'static str {
        match self {
            Self::SecurePrompt => "secure-prompt",
        }
    }
}

/// Ask the operator to approve enrolling the daemon root trust key on this machine.
///
/// # Errors
///
/// Refuses when no OS secure prompt is available (headless / unsupported host).
pub fn confirm_enrollment() -> anyhow::Result<EnrollEntryMethod> {
    if try_secure_prompt() {
        return Ok(EnrollEntryMethod::SecurePrompt);
    }
    anyhow::bail!(
        "no OS secure prompt is available on this host; enroll from a machine with a desktop secure prompt, or join as a remote CLI endorsed from such a machine"
    );
}

fn try_secure_prompt() -> bool {
    if cfg!(target_os = "macos") {
        return macos_secure_prompt();
    }
    if cfg!(target_os = "linux") {
        return linux_secure_prompt();
    }
    if cfg!(target_os = "windows") {
        return windows_secure_prompt();
    }
    false
}

#[cfg(target_os = "macos")]
fn macos_secure_prompt() -> bool {
    let script = r#"display dialog "Enroll the OpenSesame daemon CLI root trust key on this Mac?" buttons {"Cancel", "Enroll"} default button "Enroll" with title "OpenSesame" with icon caution"#;
    let Some(mut osascript) = prompt("osascript", &[]) else {
        return false;
    };
    let output = osascript
        .args(["-e", script])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output();
    matches!(
        output,
        Ok(out) if out.status.success()
    )
}

#[cfg(not(target_os = "macos"))]
fn macos_secure_prompt() -> bool {
    false
}

#[cfg(target_os = "linux")]
fn linux_secure_prompt() -> bool {
    if systemd_ask_password() {
        return true;
    }
    if zenity_question() {
        return true;
    }
    false
}

#[cfg(not(target_os = "linux"))]
fn linux_secure_prompt() -> bool {
    false
}

#[cfg(target_os = "linux")]
fn systemd_ask_password() -> bool {
    let Some(mut ask) = prompt("systemd-ask-password", &[]) else {
        return false;
    };
    let output = ask
        .args([
            "--icon=dialog-password",
            "OpenSesame: enroll CLI root trust on this host? (press Enter to continue, Ctrl+C to cancel)",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .status();
    matches!(
        output,
        Ok(status) if status.success()
    )
}

#[cfg(target_os = "linux")]
fn zenity_question() -> bool {
    if std::env::var_os("DISPLAY").is_none() && std::env::var_os("WAYLAND_DISPLAY").is_none() {
        return false;
    }
    let Some(mut zenity) = prompt("zenity", &DESKTOP) else {
        return false;
    };
    let output = zenity
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
    matches!(
        output,
        Ok(status) if status.success()
    )
}

#[cfg(target_os = "windows")]
fn windows_secure_prompt() -> bool {
    let script = r"
Add-Type -AssemblyName System.Windows.Forms
$result = [System.Windows.Forms.MessageBox]::Show(
  'Enroll the OpenSesame daemon CLI root trust key on this machine?',
  'OpenSesame',
  [System.Windows.Forms.MessageBoxButtons]::OKCancel,
  [System.Windows.Forms.MessageBoxIcon]::Warning
)
if ($result -eq [System.Windows.Forms.DialogResult]::OK) { exit 0 } else { exit 1 }
";
    let Some(mut powershell) = prompt("powershell.exe", &WINDOWS_PROFILE) else {
        return false;
    };
    let output = powershell
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    matches!(
        output,
        Ok(status) if status.success()
    )
}

#[cfg(not(target_os = "windows"))]
fn windows_secure_prompt() -> bool {
    false
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use opensesame_trusted_exec::testkit::Fixture;

    #[test]
    fn a_prompt_is_the_trusted_one_and_is_handed_the_desktop_only() {
        for program in ["zenity", "systemd-ask-password"] {
            let fixture = Fixture::new(program);
            let lookup = fixture.lookup(&[("DISPLAY", ":0"), ("GITHUB_TOKEN", "dummy-gh")]);
            let mut prompt = prompt_in(program, &DESKTOP, &lookup).expect("trusted prompt");
            assert!(prompt.arg("--question").status().unwrap().success());
            let env = fixture.assert_clean();
            assert_eq!(env["DISPLAY"], ":0", "{program}");
            assert!(!env.contains_key("GITHUB_TOKEN"), "{program}");
        }
    }

    #[test]
    fn with_no_trusted_prompt_there_is_no_prompt() {
        let fixture = Fixture::new("zenity");
        std::fs::remove_file(fixture.trusted.join("zenity")).unwrap();
        assert!(prompt_in("zenity", &DESKTOP, &fixture.lookup(&[])).is_none());
        assert!(!fixture.planted_ran());
    }
}
