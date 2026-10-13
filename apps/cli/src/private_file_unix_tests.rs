use super::*;
use std::fs;
use std::io::Read;
use std::os::unix::fs::{symlink, PermissionsExt};

fn fixture() -> (tempfile::TempDir, std::path::PathBuf) {
    let temporary = tempfile::tempdir().unwrap();
    let physical = fs::canonicalize(temporary.path()).unwrap();
    fs::set_permissions(&physical, fs::Permissions::from_mode(0o700)).unwrap();
    (temporary, physical)
}

fn leaves(root: &Path) -> Vec<std::ffi::OsString> {
    fs::read_dir(root)
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect()
}

#[test]
fn broad_destination_is_replaced_without_exposing_new_bytes_to_its_old_handle() {
    let (_temporary, root) = fixture();
    let path = root.join("session.json");
    fs::write(&path, b"old public bytes").unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
    let mut old_reader = File::open(&path).unwrap();
    let old_inode = old_reader.metadata().unwrap().ino();
    write_private(&path, b"new private bytes").unwrap();
    let mut old_bytes = Vec::new();
    old_reader.read_to_end(&mut old_bytes).unwrap();
    assert_eq!(old_bytes, b"old public bytes");
    let new_metadata = fs::metadata(&path).unwrap();
    assert_ne!(old_inode, new_metadata.ino());
    assert_eq!(new_metadata.mode() & 0o777, 0o600);
    assert_eq!(new_metadata.nlink(), 1);
    assert_eq!(fs::read(&path).unwrap(), b"new private bytes");
    assert_eq!(leaves(&root), [std::ffi::OsString::from("session.json")]);
}

#[test]
fn final_symlink_and_hardlink_are_refused_without_writing_their_targets() {
    let (_temporary, root) = fixture();
    let target = root.join("target");
    fs::write(&target, b"preserved").unwrap();
    let link = root.join("symbolic");
    symlink(&target, &link).unwrap();
    assert!(write_private(&link, b"secret").is_err());
    assert!(write_private_new(&link, b"secret").is_err());
    let hard = root.join("hard");
    fs::hard_link(&target, &hard).unwrap();
    assert!(write_private(&hard, b"secret").is_err());
    assert_eq!(fs::read(&target).unwrap(), b"preserved");
    assert_eq!(fs::read(&hard).unwrap(), b"preserved");
    assert!(fs::symlink_metadata(&link)
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(leaves(&root).len(), 3);
}

#[test]
fn private_creation_and_exclusive_conflict_keep_the_original_file() {
    let (_temporary, root) = fixture();
    let path = root.join("token");
    write_private_new(&path, b"initial").unwrap();
    let original_inode = fs::metadata(&path).unwrap().ino();
    assert_eq!(fs::metadata(&path).unwrap().mode() & 0o777, 0o600);
    assert!(write_private_new(&path, b"replacement").is_err());
    assert_eq!(fs::metadata(&path).unwrap().ino(), original_inode);
    assert_eq!(fs::read(&path).unwrap(), b"initial");
    assert_eq!(leaves(&root).len(), 1);
}

#[test]
fn actual_fill_failure_cleans_its_pending_file_and_preserves_old_destination() {
    let (_temporary, root) = fixture();
    let path = root.join("token");
    fs::write(&path, b"old").unwrap();
    let original_inode = fs::metadata(&path).unwrap().ino();
    let result = publish(&path, false, |file| {
        let metadata = file.metadata()?;
        assert_eq!(metadata.mode() & 0o777, 0o600);
        assert_eq!(metadata.nlink(), 1);
        file.write_all(b"partial secret")?;
        Err(io::Error::other("cancelled"))
    });
    assert!(result.is_err());
    assert_eq!(fs::metadata(&path).unwrap().ino(), original_inode);
    assert_eq!(fs::read(&path).unwrap(), b"old");
    assert_eq!(leaves(&root).len(), 1);
}

#[test]
fn root_substitution_during_fill_refuses_publication_to_either_root() {
    let (_temporary, parent) = fixture();
    let root = parent.join("root");
    fs::create_dir(&root).unwrap();
    let moved = parent.join("moved");
    let path = root.join("token");
    fs::write(&path, b"old").unwrap();
    let result = publish(&path, false, |file| {
        file.write_all(b"private new")?;
        fs::rename(&root, &moved)?;
        fs::create_dir(&root)?;
        fs::write(root.join("token"), b"replacement root")?;
        Ok(())
    });
    assert!(result.is_err());
    assert_eq!(fs::read(moved.join("token")).unwrap(), b"old");
    assert_eq!(fs::read(&path).unwrap(), b"replacement root");
    assert_eq!(leaves(&moved).len(), 1);
}

#[test]
fn ancestor_symlink_and_writable_final_directory_are_refused_without_repair() {
    let (_temporary, parent) = fixture();
    let root = parent.join("root");
    fs::create_dir(&root).unwrap();
    let alias = parent.join("alias");
    symlink(&root, &alias).unwrap();
    assert!(write_private(&alias.join("token"), b"secret").is_err());
    fs::set_permissions(&root, fs::Permissions::from_mode(0o777)).unwrap();
    assert!(write_private(&root.join("token"), b"secret").is_err());
    assert_eq!(fs::metadata(&root).unwrap().mode() & 0o777, 0o777);
    assert!(leaves(&root).is_empty());
}

#[test]
fn changing_private_file_mode_during_fill_refuses_publication() {
    let (_temporary, root) = fixture();
    let path = root.join("token");
    let result = publish(&path, false, |file| {
        file.set_permissions(fs::Permissions::from_mode(0o644))?;
        Ok(())
    });
    assert!(result.is_err());
    assert!(leaves(&root).is_empty());
}

#[cfg(target_os = "macos")]
#[test]
fn genuine_macos_tmp_alias_can_publish_and_reopen_the_same_private_inode() {
    let temporary = tempfile::tempdir_in("/tmp").unwrap();
    let path = temporary.path().join("token");
    write_private(&path, b"private OS alias output").unwrap();
    let physical = fs::canonicalize(&path).unwrap();
    assert_eq!(
        fs::metadata(&path).unwrap().ino(),
        fs::metadata(&physical).unwrap().ino()
    );
    assert_eq!(fs::metadata(&physical).unwrap().mode() & 0o777, 0o600);
    assert_eq!(fs::read(&physical).unwrap(), b"private OS alias output");
}

#[test]
fn pending_entry_substitution_is_refused_without_deleting_the_substitute() {
    let (_temporary, root) = fixture();
    let destination = root.join("token");
    let moved = root.join("moved-private-pending");
    let mut substitute = None;
    let result = publish(&destination, false, |file| {
        file.write_all(b"held private bytes")?;
        let entry = fs::read_dir(&root)?.next().unwrap()?.path();
        fs::rename(&entry, &moved)?;
        fs::write(&entry, b"substituted entry")?;
        substitute = Some(entry);
        Ok(())
    });
    assert!(result.is_err());
    assert!(!destination.exists());
    assert_eq!(fs::read(substitute.unwrap()).unwrap(), b"substituted entry");
    assert_eq!(fs::read(&moved).unwrap(), b"held private bytes");
    assert_eq!(fs::metadata(&moved).unwrap().mode() & 0o777, 0o600);
}
