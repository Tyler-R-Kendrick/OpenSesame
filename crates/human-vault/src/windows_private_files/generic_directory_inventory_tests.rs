//! Genuine Windows original-handle bounded census controls, authored unexecuted.
use super::*;
use crate::root_protection::windows_private_files::write_new;
use std::path::Path;
#[test]
fn generic_transport_budget_does_not_weaken_native_generation_budget() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("original-private");
    let directory = PrivateDirectory::create_new(&root).unwrap();
    for n in 0..129 {
        write_new(
            &directory,
            Path::new(&format!("record-{n:03}.json")),
            b"opaque physical data",
        )
        .unwrap();
    }
    assert!(directory.original_directory_entries().is_err());
    for _ in 0..2 {
        let actual = directory.original_bounded_directory_entries(129).unwrap();
        assert_eq!(actual.len(), 129);
        assert_eq!(actual.first().unwrap(), &("record-000.json".into(), false));
        assert_eq!(actual.last().unwrap(), &("record-128.json".into(), false));
    }
    assert!(directory.original_bounded_directory_entries(128).is_err());
    assert!(directory.original_bounded_directory_entries(0).is_err());
    assert!(directory.original_bounded_directory_entries(4097).is_err());
}
