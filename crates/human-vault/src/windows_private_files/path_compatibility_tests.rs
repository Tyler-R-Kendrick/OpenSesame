//! Kernel name compatibility controls under real retained private roots.
use super::*;

#[test]
fn the_os_temp_spelling_and_its_reported_physical_name_select_the_same_private_root() {
    let temp = tempfile::tempdir().unwrap();
    // The native TEMP spelling can contain actual existing 8.3 aliases.
    let root = temp.path().join("private-long-directory-name");
    let held = PrivateDirectory::create_directories(&root).unwrap();
    let physical = handles::final_path(held.root_handle().unwrap()).unwrap();
    let physical = PathBuf::from(physical.strip_prefix(r"\\?\").unwrap());
    let physical_root = PrivateDirectory::open(&physical).unwrap();
    assert_eq!(
        handles::identity(held.root_handle().unwrap(), true).unwrap(),
        handles::identity(physical_root.root_handle().unwrap(), true).unwrap()
    );
    let short =
        handles::short_path(&handles::final_path(held.root_handle().unwrap()).unwrap()).unwrap();
    let short = PathBuf::from(short.strip_prefix(r"\\?\").unwrap_or(&short));
    let short_root = PrivateDirectory::open(&short).unwrap();
    assert_eq!(
        handles::identity(short_root.root_handle().unwrap(), true).unwrap(),
        handles::identity(held.root_handle().unwrap(), true).unwrap()
    );
    // NTFS may have short-name generation disabled; no 8.3 branch coverage is
    // claimed merely because its reported path equals the long spelling.
    write_new(&held, Path::new("positive.bin"), b"controlled positive").unwrap();
    assert_eq!(
        std::fs::read(root.join("positive.bin")).unwrap(),
        b"controlled positive"
    );
}

#[test]
fn ordinary_case_variation_remains_bound_to_the_same_kernel_directory_identity() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("private-mixed-case");
    let held = PrivateDirectory::create_directories(&root).unwrap();
    let variant = root.with_file_name("PRIVATE-MIXED-CASE");
    let reopened = PrivateDirectory::open(&variant).unwrap();
    assert_eq!(
        handles::identity(held.root_handle().unwrap(), true).unwrap(),
        handles::identity(reopened.root_handle().unwrap(), true).unwrap()
    );
    let foreign = temp.path().join("another-private-root");
    let foreign = PrivateDirectory::create_directories(&foreign).unwrap();
    assert_ne!(
        handles::identity(held.root_handle().unwrap(), true).unwrap(),
        handles::identity(foreign.root_handle().unwrap(), true).unwrap()
    );
    assert!(handles::child_relation(
        held.root_handle().unwrap(),
        foreign.root_handle().unwrap(),
        "PRIVATE-MIXED-CASE"
    )
    .is_err());
}
