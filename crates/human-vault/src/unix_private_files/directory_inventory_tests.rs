//! Genuine original directory/inventory controls, source authored and unexecuted.
use super::*;
use crate::root_protection::unix_private_files::{
    write_new, HeldPrivateRead, HeldPrivateWriterLease,
};
use std::{fs, os::unix::fs::PermissionsExt, path::Path, sync::Arc};
#[test]
fn actual_retained_private_children_census_and_leases_survive_parent_object_drop() {
    let temp = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(temp.path()).unwrap().join("state");
    let parent = PrivateDirectory::create_new(&root).unwrap();
    let locks = Arc::new(
        parent
            .create_child(Path::new("vault-locks-native-v1"))
            .unwrap(),
    );
    let records = Arc::new(parent.create_child(Path::new("origin-files")).unwrap());
    assert_eq!(
        parent.original_bounded_directory_entries(2).unwrap(),
        vec![
            ("origin-files".into(), true),
            ("vault-locks-native-v1".into(), true)
        ]
    );
    assert!(parent.original_bounded_directory_entries(1).is_err());
    let identity = records.original_resource_identity().unwrap();
    assert_eq!(records.original_resource_identity().unwrap(), identity);
    fs::set_permissions(&root, fs::Permissions::from_mode(0o777)).unwrap();
    assert!(records.validate_original().is_err());
    assert!(locks.validate_original().is_err());
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
    records.validate_original().unwrap();
    drop(parent);
    write_new(&records, Path::new("first.json"), b"opaque physical bytes").unwrap();
    HeldPrivateRead::open(Arc::clone(&records), Path::new("first.json"), 64)
        .unwrap()
        .validate()
        .unwrap();
    let held =
        HeldPrivateWriterLease::exclusive(Arc::clone(&locks), "opensesame.retired-credentials")
            .unwrap();
    held.validate().unwrap();
    for _ in 0..2 {
        assert_eq!(
            records.original_bounded_directory_entries(1).unwrap(),
            vec![("first.json".into(), false)]
        );
    }
    assert!(records.original_bounded_directory_entries(0).is_err());
    assert!(records.original_bounded_directory_entries(4097).is_err());
    assert_eq!(
        records
            .original_bounded_directory_entries(128)
            .unwrap()
            .len(),
        1
    );
}
#[test]
fn actual_unknown_hidden_nodes_and_substituted_or_broad_children_refuse_without_repair() {
    let temp = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(temp.path()).unwrap().join("state");
    let parent = PrivateDirectory::create_new(&root).unwrap();
    let child = parent.create_child(Path::new("child")).unwrap();
    fs::create_dir(root.join("broad")).unwrap();
    fs::set_permissions(root.join("broad"), fs::Permissions::from_mode(0o777)).unwrap();
    assert!(parent.create_child(Path::new("broad")).is_err());
    assert_eq!(
        fs::metadata(root.join("broad"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o777
    );
    for name in ["../child", "child/", "/child", ""] {
        assert!(parent.open_child(Path::new(name)).is_err());
    }
    std::os::unix::fs::symlink("child", root.join(".hidden-alias")).unwrap();
    assert!(parent.original_bounded_directory_entries(128).is_err());
    fs::remove_file(root.join(".hidden-alias")).unwrap();
    fs::rename(root.join("child"), root.join("old-child")).unwrap();
    fs::create_dir(root.join("child")).unwrap();
    fs::set_permissions(root.join("child"), fs::Permissions::from_mode(0o700)).unwrap();
    assert!(child.validate_original().is_err());
    assert!(child.original_bounded_directory_entries(128).is_err());
}
