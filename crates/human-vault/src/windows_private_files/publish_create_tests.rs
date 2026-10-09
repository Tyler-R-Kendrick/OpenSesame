//! Actual handle publication controls; authored, not executed in this Linux workspace.
use super::*;
use std::{fs, path::PathBuf};

fn root() -> (tempfile::TempDir, PathBuf, PrivateDirectory) {
    let temp = tempfile::tempdir().unwrap();
    let original = handles::directory(temp.path()).unwrap();
    let final_path = handles::final_path(&original).unwrap();
    let path = PathBuf::from(final_path.strip_prefix(r"\\?\").unwrap()).join("private");
    let directory = PrivateDirectory::create_new(&path).unwrap();
    (temp, path, directory)
}

#[test]
fn flushed_create_only_publication_preserves_a_raced_destination() {
    let (_temp, path, directory) = root();
    let result = atomic_create_with(&directory, Path::new("entry.bin"), |file| {
        file.write_all(b"prepared ciphertext")?;
        write_new(&directory, Path::new("entry.bin"), b"raced ciphertext")
    });
    assert!(result.is_err());
    assert_eq!(
        fs::read(path.join("entry.bin")).unwrap(),
        b"raced ciphertext"
    );
    assert_eq!(fs::read_dir(&path).unwrap().count(), 1);
    directory.validate_original().unwrap();
}

#[test]
fn create_only_publishes_complete_private_bytes_and_refuses_existing_destinations() {
    let (_temp, path, directory) = root();
    atomic_create_with(&directory, Path::new("entry.bin"), |file| {
        file.write_all(b"complete private ciphertext")
    })
    .unwrap();
    assert_eq!(
        fs::read(path.join("entry.bin")).unwrap(),
        b"complete private ciphertext"
    );
    assert!(
        atomic_create_with(&directory, Path::new("entry.bin"), |file| {
            file.write_all(b"must not replace")
        })
        .is_err()
    );
    assert_eq!(
        fs::read(path.join("entry.bin")).unwrap(),
        b"complete private ciphertext"
    );
    assert_eq!(fs::read_dir(&path).unwrap().count(), 1);
}

#[test]
fn failed_producer_removes_only_its_exact_private_stage() {
    let (_temp, path, directory) = root();
    write_new(&directory, Path::new("retained.bin"), b"retained").unwrap();
    assert!(
        atomic_create_with(&directory, Path::new("new.bin"), |file| {
            file.write_all(b"unfinished")?;
            Err(io::Error::other("original producer cancelled"))
        })
        .is_err()
    );
    assert!(!path.join("new.bin").exists());
    assert_eq!(fs::read(path.join("retained.bin")).unwrap(), b"retained");
    assert_eq!(fs::read_dir(&path).unwrap().count(), 1);
}
