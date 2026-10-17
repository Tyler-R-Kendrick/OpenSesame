use std::fs;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

use opensesame_trusted_exec::{command_in, pass_in, Lookup, Pass};

use crate::StoreError;

const GPG_ID: &str = ".gpg-id";

/// The variable that names the exact `gpg` to run.
const GPG_OVERRIDE: &str = "OPENSESAME_GPG";

/// What `gpg` is given of the parent's environment besides `PATH` (the
/// trusted entries) and the common set, each for one reason. Everything else,
/// the Host's keys and every provider token among it, stays behind.
const GPG_ENV: [Pass; 9] = [
    // The keyring, when it is not `~/.gnupg`.
    Pass::Name("GNUPGHOME"),
    // An agent a gpg 1.x setup started on its own socket.
    Pass::Name("GPG_AGENT_INFO"),
    // gpg hands these to gpg-agent for pinentry: the terminal it asks on...
    Pass::Name("GPG_TTY"),
    Pass::Name("TERM"),
    // ...or the display, session and bus of a graphical pinentry.
    Pass::Name("DISPLAY"),
    Pass::Name("XAUTHORITY"),
    Pass::Name("WAYLAND_DISPLAY"),
    Pass::Name("XDG_RUNTIME_DIR"),
    Pass::Name("DBUS_SESSION_BUS_ADDRESS"),
];

/// `gpg` for this process: found by the trusted rule or `OPENSESAME_GPG`,
/// handed [`GPG_ENV`].
fn gpg() -> Result<Command, StoreError> {
    gpg_in(&Lookup::capture())
}

fn gpg_in(lookup: &Lookup) -> Result<Command, StoreError> {
    let mut command = command_in("gpg", Some(GPG_OVERRIDE), lookup)
        .map_err(|e| StoreError::Gpg(e.to_string()))?;
    pass_in(&mut command, &GPG_ENV, lookup);
    Ok(command)
}

///
/// # Errors
///
/// Returns an error when validation or the underlying operation fails.
pub fn read_gpg_id(root: &Path) -> Result<Vec<String>, StoreError> {
    let path = root.join(GPG_ID);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let text = fs::read_to_string(path)?;
    Ok(text
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .map(str::to_string)
        .collect())
}

///
/// # Errors
///
/// Returns an error when validation or the underlying operation fails.
pub fn decrypt_gpg_file(path: &Path) -> Result<Vec<u8>, StoreError> {
    decrypt_gpg(&fs::read(path)?)
}

pub(crate) fn decrypt_gpg(ciphertext: &[u8]) -> Result<Vec<u8>, StoreError> {
    let mut child = gpg()?
        .args(["--quiet", "--batch", "--decrypt"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| StoreError::Gpg(e.to_string()))?;
    child
        .stdin
        .take()
        .ok_or_else(|| StoreError::Gpg("gpg stdin".into()))?
        .write_all(ciphertext)
        .map_err(|e| StoreError::Gpg(e.to_string()))?;
    let output = child
        .wait_with_output()
        .map_err(|e| StoreError::Gpg(e.to_string()))?;
    if !output.status.success() {
        return Err(StoreError::Gpg(
            String::from_utf8_lossy(&output.stderr).into(),
        ));
    }
    Ok(output.stdout)
}

///
/// # Errors
///
/// Returns an error when validation or the underlying operation fails.
pub fn encrypt_gpg_file(
    path: &Path,
    plaintext: &[u8],
    recipients: &[String],
) -> Result<(), StoreError> {
    let ciphertext = encrypt_gpg(plaintext, recipients)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, ciphertext)?;
    Ok(())
}

pub(crate) fn encrypt_gpg(plaintext: &[u8], recipients: &[String]) -> Result<Vec<u8>, StoreError> {
    if recipients.is_empty() {
        return Err(StoreError::Gpg("no .gpg-id recipients".into()));
    }
    let mut args = vec![
        "--quiet".into(),
        "--batch".into(),
        "--yes".into(),
        "--encrypt".into(),
    ];
    for r in recipients {
        args.push("--recipient".into());
        args.push(r.clone());
    }
    let mut child = gpg()?
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| StoreError::Gpg(e.to_string()))?;
    {
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| StoreError::Gpg("gpg stdin".into()))?;
        stdin
            .write_all(plaintext)
            .map_err(|e| StoreError::Gpg(e.to_string()))?;
    }
    let output = child
        .wait_with_output()
        .map_err(|e| StoreError::Gpg(e.to_string()))?;
    if !output.status.success() {
        return Err(StoreError::Gpg(
            String::from_utf8_lossy(&output.stderr).into(),
        ));
    }
    Ok(output.stdout)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use opensesame_trusted_exec::testkit::Fixture;

    #[test]
    fn gpg_is_the_trusted_one_and_is_handed_its_keyring_and_pinentry_only() {
        let fixture = Fixture::new("gpg");
        let pinentry = [
            ("GNUPGHOME", "/home/dummy/.gnupg-store"),
            ("GPG_TTY", "/dev/pts/9"),
            ("DISPLAY", ":0"),
        ];
        let lookup = fixture.lookup(&pinentry);
        assert!(gpg_in(&lookup).unwrap().status().unwrap().success());
        let env = fixture.assert_clean();
        for (name, value) in pinentry {
            assert_eq!(env.get(name).map(String::as_str), Some(value), "{name}");
        }
    }

    #[test]
    fn opensesame_gpg_names_the_exact_file_or_is_refused_by_name() {
        let fixture = Fixture::new("gpg");
        let chosen = fixture.scratch("chosen").join("gpg2");
        fixture.stub_recorder(&chosen);
        let value = chosen.display().to_string();
        let command = gpg_in(&fixture.lookup(&[(GPG_OVERRIDE, &value)])).unwrap();
        assert_eq!(command.get_program(), chosen.as_os_str());
        let err = gpg_in(&fixture.lookup(&[(GPG_OVERRIDE, "")]))
            .unwrap_err()
            .to_string();
        assert!(err.contains("OPENSESAME_GPG is set but empty"), "{err}");
    }
}
