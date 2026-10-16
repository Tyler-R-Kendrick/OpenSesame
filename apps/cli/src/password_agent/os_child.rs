//! Direct child execution for the local `run` lane: owner-only mount
//! files for one child lifetime, and a spawned child whose output is
//! piped through the secret masker instead of inherited.

use opensesame_connector_host::password_agent::env as core;
use std::{
    io::{Read, Write},
    path::PathBuf,
    process::{Command, ExitStatus, Stdio},
};

/// Mount files for one run: an owner-only directory of owner-only files,
/// removed when this value drops (child exit, error, or panic alike).
/// This is a temp-file mount, not a filesystem mount: the path is real
/// while the child runs and gone afterwards.
pub(super) struct Mounts {
    _directory: Option<tempfile::TempDir>,
    pub(super) paths: Vec<(String, PathBuf)>,
}

pub(super) fn materialize_mounts(mounts: &[(String, String)]) -> anyhow::Result<Mounts> {
    if mounts.is_empty() {
        return Ok(Mounts {
            _directory: None,
            paths: Vec::new(),
        });
    }
    let directory = tempfile::Builder::new()
        .prefix("opensesame-run-mount-")
        .tempdir()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(directory.path(), std::fs::Permissions::from_mode(0o700))?;
    }
    let mut paths = Vec::new();
    for (name, value) in mounts {
        let file = directory.path().join(name);
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut handle = options.open(&file)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            handle.set_permissions(std::fs::Permissions::from_mode(0o600))?;
        }
        handle.write_all(value.as_bytes())?;
        paths.push((name.clone(), file));
    }
    Ok(Mounts {
        _directory: Some(directory),
        paths,
    })
}

pub(super) fn pump_masked<R: Read, W: Write + ?Sized>(
    mut reader: R,
    writer: &mut W,
    masker: &mut core::SecretMasker,
) -> std::io::Result<()> {
    let mut chunk = [0u8; 8192];
    loop {
        let read = reader.read(&mut chunk)?;
        if read == 0 {
            break;
        }
        writer.write_all(&masker.push(&chunk[..read]))?;
        writer.flush()?;
    }
    writer.write_all(&masker.flush())?;
    writer.flush()
}

/// Spawn the child with already-resolved values. Output is piped through
/// the masker instead of inherited, so a value the child prints never
/// reaches the terminal or a log in the clear. The provider token and
/// interpreter startup hooks never enter the child either.
pub(super) fn spawn_masked(
    command: &[String],
    values: &[(String, String)],
    secrets: &[String],
    stdout: &mut (dyn Write + Send),
    stderr: &mut (dyn Write + Send),
) -> anyhow::Result<ExitStatus> {
    let (program, args) = command
        .split_first()
        .ok_or_else(|| anyhow::anyhow!("A child command is required"))?;
    let mut child = Command::new(program);
    child
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    child.env_remove("OP_SERVICE_ACCOUNT_TOKEN");
    for key in
        &opensesame_connector_host::password_agent::policy::policy().credential_startup_env_keys
    {
        child.env_remove(key);
    }
    for (key, _) in std::env::vars_os() {
        if key.to_str().is_some_and(core::credential_startup_key) {
            child.env_remove(key);
        }
    }
    for (name, value) in values {
        child.env(name, value);
    }
    let mut child = child
        .spawn()
        .map_err(|_| anyhow::anyhow!("The child command could not be started"))?;
    let mut out_pipe = child.stdout.take();
    let mut err_pipe = child.stderr.take();
    let mut out_mask = core::SecretMasker::new(secrets);
    let mut err_mask = core::SecretMasker::new(secrets);
    let status = std::thread::scope(|scope| {
        let out_thread = scope.spawn(|| match (&mut out_pipe, &mut *stdout) {
            (Some(pipe), writer) => pump_masked(pipe, writer, &mut out_mask),
            (None, _) => Ok(()),
        });
        let err_result = match (&mut err_pipe, &mut *stderr) {
            (Some(pipe), writer) => pump_masked(pipe, writer, &mut err_mask),
            (None, _) => Ok(()),
        };
        let _ = out_thread.join();
        let _ = err_result;
        child.wait()
    })
    .map_err(|_| anyhow::anyhow!("The child command could not be started"))?;
    Ok(status)
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    #[test]
    fn mounts_are_owner_only_files_removed_with_their_directory() {
        use std::os::unix::fs::PermissionsExt;
        let mounts =
            super::materialize_mounts(&[("CERT_FILE".into(), "pem-bytes".into())]).expect("mount");
        let (name, path) = &mounts.paths[0];
        assert_eq!(name, "CERT_FILE");
        assert_eq!(std::fs::read_to_string(path).unwrap(), "pem-bytes");
        let mode = std::fs::metadata(path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
        let gone = path.clone();
        drop(mounts);
        assert!(!gone.exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_child_sees_values_but_its_output_is_masked() {
        let mut out: Vec<u8> = Vec::new();
        let mut err: Vec<u8> = Vec::new();
        let status = super::spawn_masked(
            &[
                "/bin/sh".into(),
                "-c".into(),
                "printf 'env=%s\\n' \"$API\"; printf 'err=%s\\n' \"$API\" >&2; exit 7".into(),
            ],
            &[("API".into(), "private-canary".into())],
            &["private-canary".into()],
            &mut out,
            &mut err,
        )
        .expect("spawn");
        assert_eq!(status.code(), Some(7));
        assert_eq!(String::from_utf8(out).unwrap(), "env=[REDACTED]\n");
        assert_eq!(String::from_utf8(err).unwrap(), "err=[REDACTED]\n");
    }
}
