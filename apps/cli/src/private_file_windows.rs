//! Private CLI outputs compose the existing pinned Windows publication primitives.
use anyhow::{Context, Result};
use opensesame_human_vault::windows_publish;
use std::{fs::File, io, path::Path};

fn destination(path: &Path) -> Result<(std::path::PathBuf, std::path::PathBuf)> {
    // absolute does not resolve symlinks: the primitive must inspect every ancestor.
    let absolute = std::path::absolute(path)?;
    let parent = absolute
        .parent()
        .context("private output requires a parent")?;
    let name = absolute
        .file_name()
        .context("private output requires a filename")?;
    Ok((parent.to_path_buf(), Path::new(name).to_path_buf()))
}

pub(super) fn write_private(path: &Path, bytes: &[u8], exclusive: bool) -> Result<()> {
    let (root, relative) = destination(path)?;
    if exclusive {
        windows_publish::write_new(&root, &relative, bytes)?;
    } else {
        windows_publish::atomic_write(&root, &relative, bytes)?;
    }
    Ok(())
}

pub(super) fn write_owner_only(
    path: &Path,
    fill: impl FnOnce(&mut File) -> Result<()>,
) -> Result<()> {
    let (root, relative) = destination(path)?;
    windows_publish::atomic_write_with(&root, &relative, |file| {
        fill(file).map_err(io::Error::other)
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use opensesame_human_vault::{windows_io, windows_publish};
    use std::{io::Write, path::Path, process::Command};

    fn grant(path: &Path, permission: &str) {
        let output = Command::new("icacls.exe")
            .arg(path)
            .arg("/grant")
            .arg(permission)
            .output()
            .unwrap();
        assert!(output.status.success(), "private fixture ACL setup failed");
    }

    #[test]
    fn cli_private_outputs_use_confined_publication_and_exclusive_creation() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.json");
        crate::private_file::write_private_new(&path, b"first").unwrap();
        assert!(crate::private_file::write_private_new(&path, b"overwrite").is_err());
        assert_eq!(
            windows_io::read_bounded(dir.path(), Path::new("session.json"), 64).unwrap(),
            b"first"
        );
        crate::private_file::write_private(&path, b"current").unwrap();
        assert_eq!(
            windows_io::read_bounded(dir.path(), Path::new("session.json"), 64).unwrap(),
            b"current"
        );
        crate::attach::write_owner_only(&path, |file| {
            file.write_all(b"streamed")?;
            file.flush()?;
            let pending = std::fs::read_dir(dir.path())
                .unwrap()
                .map(|entry| entry.unwrap().file_name())
                .find(|name| name.to_string_lossy().starts_with(".windows-pending-"))
                .expect("exact pending file must exist before publication");
            assert!(dir.path().join(pending).is_file());
            // Pending retains DELETE access without DELETE sharing; another
            // path-based read cannot acquire a handle while publication is live.
            assert!(std::fs::rename(dir.path(), dir.path().with_extension("moved")).is_err());
            Ok(())
        })
        .unwrap();
        assert_eq!(
            windows_io::read_bounded(dir.path(), Path::new("session.json"), 64).unwrap(),
            b"streamed"
        );
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn cli_private_outputs_refuse_broad_file_permissions_and_hardlinks() {
        let dir = tempfile::tempdir().unwrap();
        let original = dir.path().join("original");
        crate::private_file::write_private_new(&original, b"untouched").unwrap();
        let linked = dir.path().join("linked");
        std::fs::hard_link(&original, &linked).unwrap();
        assert!(crate::private_file::write_private(&linked, b"replacement").is_err());
        assert!(crate::private_file::write_private_new(&linked, b"replacement").is_err());
        assert!(crate::attach::write_owner_only(&linked, |file| Ok(
            file.write_all(b"replacement")?
        ))
        .is_err());
        assert_eq!(std::fs::read(&original).unwrap(), b"untouched");
        std::fs::remove_file(&linked).unwrap();
        grant(&original, "*S-1-1-0:R");
        assert!(crate::private_file::write_private(&original, b"replacement").is_err());
        assert!(crate::private_file::write_private_new(&original, b"replacement").is_err());
        assert!(crate::attach::write_owner_only(&original, |file| Ok(
            file.write_all(b"replacement")?
        ))
        .is_err());
        assert_eq!(std::fs::read(&original).unwrap(), b"untouched");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn cli_private_outputs_refuse_public_and_junction_parents_before_fill() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let alias = dir.path().join("junction");
        let output = Command::new("cmd.exe")
            .args(["/c", "mklink", "/J"])
            .arg(&alias)
            .arg(outside.path())
            .output()
            .unwrap();
        assert!(output.status.success(), "junction fixture setup failed");
        let path = alias.join("secret");
        assert!(crate::private_file::write_private(&path, b"unexpected").is_err());
        assert!(crate::private_file::write_private_new(&path, b"unexpected").is_err());
        let mut called = false;
        assert!(crate::attach::write_owner_only(&path, |_| {
            called = true;
            Ok(())
        })
        .is_err());
        assert!(!called);
        assert_eq!(std::fs::read_dir(outside.path()).unwrap().count(), 0);
        grant(outside.path(), "*S-1-1-0:(OI)(CI)M");
        let path = outside.path().join("secret");
        assert!(crate::private_file::write_private(&path, b"unexpected").is_err());
        assert!(crate::private_file::write_private_new(&path, b"unexpected").is_err());
        assert!(crate::attach::write_owner_only(&path, |_| {
            called = true;
            Ok(())
        })
        .is_err());
        assert!(!called);
        assert!(!path.exists());
    }

    #[test]
    fn cli_stream_failure_preserves_committed_bytes_and_removes_pending_plaintext() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("key.pem");
        windows_publish::atomic_write(dir.path(), Path::new("key.pem"), b"committed").unwrap();
        let error = crate::attach::write_owner_only(&path, |file| {
            file.write_all(b"incomplete")?;
            anyhow::bail!("genuine fill failure")
        })
        .unwrap_err();
        assert!(error.to_string().contains("genuine fill failure"));
        assert_eq!(
            windows_io::read_bounded(dir.path(), Path::new("key.pem"), 64).unwrap(),
            b"committed"
        );
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }
}
