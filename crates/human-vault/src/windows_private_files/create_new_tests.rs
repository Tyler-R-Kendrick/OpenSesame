//! Genuine Windows create-new controls; source authored, not executed here.
use super::*;
use std::fs;

fn parent_path(path: &Path) -> PathBuf {
    let file = handles::directory(path).unwrap();
    let physical = handles::final_path(&file).unwrap();
    PathBuf::from(physical.strip_prefix(r"\\?\").unwrap())
}

#[test]
fn create_new_sets_private_acl_and_retains_the_actual_root() {
    let temp = tempfile::tempdir().unwrap();
    let root = parent_path(temp.path()).join("fresh-private");
    let held = PrivateDirectory::create_new(&root).unwrap();
    held.validate().unwrap();
    security::verify(
        held.root_handle().unwrap(),
        &security::owner_sid().unwrap(),
        true,
    )
    .unwrap();
    write_new(&held, Path::new("only.bin"), b"private bytes").unwrap();
    assert!(fs::rename(&root, root.with_file_name("moved")).is_err());
    assert_eq!(fs::read(root.join("only.bin")).unwrap(), b"private bytes");
    drop(held);
    PrivateDirectory::open(&root).unwrap();
}

#[test]
fn create_new_refuses_both_private_and_inherited_existing_destinations() {
    let temp = tempfile::tempdir().unwrap();
    let parent = parent_path(temp.path());
    let private = parent.join("existing-private");
    let held = PrivateDirectory::create_new(&private).unwrap();
    write_new(&held, Path::new("unchanged.bin"), b"existing private").unwrap();
    let before = handles::identity(held.root_handle().unwrap(), true).unwrap();
    assert_eq!(
        PrivateDirectory::create_new(&private).err().unwrap().kind(),
        io::ErrorKind::AlreadyExists
    );
    assert_eq!(
        handles::identity(held.root_handle().unwrap(), true).unwrap(),
        before
    );
    assert_eq!(
        fs::read(private.join("unchanged.bin")).unwrap(),
        b"existing private"
    );
    let inherited = parent.join("inherited");
    fs::create_dir(&inherited).unwrap();
    fs::write(inherited.join("unchanged.bin"), b"existing inherited").unwrap();
    assert_eq!(
        PrivateDirectory::create_new(&inherited)
            .err()
            .unwrap()
            .kind(),
        io::ErrorKind::AlreadyExists
    );
    assert_eq!(
        fs::read(inherited.join("unchanged.bin")).unwrap(),
        b"existing inherited"
    );
}

#[test]
fn create_new_never_creates_missing_ancestors_or_accepts_path_aliases() {
    let temp = tempfile::tempdir().unwrap();
    let parent = parent_path(temp.path());
    let missing = parent.join("missing").join("child");
    assert!(PrivateDirectory::create_new(&missing).is_err());
    assert!(!parent.join("missing").exists());
    for root in [
        parent.join("NUL"),
        parent.join("bad."),
        parent.join(".."),
        parent.join("stream:ads"),
    ] {
        assert!(PrivateDirectory::create_new(&root).is_err());
    }
    assert_eq!(fs::read_dir(parent).unwrap().count(), 0);
}
