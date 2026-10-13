//! Actual bounded journal-sized handle controls; authored, not executed here.
use super::*;
use crate::root_protection::windows_private_files::write_new;
use std::path::PathBuf;

fn root() -> (tempfile::TempDir, Arc<PrivateDirectory>) {
    let temp = tempfile::tempdir().unwrap();
    let original = handles::directory(temp.path()).unwrap();
    let final_path = handles::final_path(&original).unwrap();
    let path = PathBuf::from(final_path.strip_prefix(r"\\?\").unwrap()).join("private");
    let directory = Arc::new(PrivateDirectory::create_new(&path).unwrap());
    (temp, directory)
}

#[test]
fn exact_sixteen_mib_private_journal_is_bounded_and_revalidated() {
    let (_temp, directory) = root();
    let bytes = vec![0x5a; 16 * 1024 * 1024];
    write_new(&directory, Path::new("journal.bin"), &bytes).unwrap();
    let mut read = HeldPrivateRead::open(
        Arc::clone(&directory),
        Path::new("journal.bin"),
        bytes.len(),
    )
    .unwrap();
    assert_eq!(read.bytes(), bytes);
    read.validate().unwrap();
    assert!(HeldPrivateRead::open(
        Arc::clone(&directory),
        Path::new("journal.bin"),
        4 * 1024 * 1024
    )
    .is_err());
}

#[test]
fn larger_records_and_unbounded_requests_are_refused() {
    let (_temp, directory) = root();
    let bytes = vec![0x6b; 16 * 1024 * 1024 + 1];
    write_new(&directory, Path::new("oversize.bin"), &bytes).unwrap();
    assert!(HeldPrivateRead::open(
        Arc::clone(&directory),
        Path::new("oversize.bin"),
        16 * 1024 * 1024
    )
    .is_err());
    assert!(HeldPrivateRead::open(
        Arc::clone(&directory),
        Path::new("oversize.bin"),
        16 * 1024 * 1024 + 1
    )
    .is_err());
    assert!(HeldPrivateRead::open(
        Arc::clone(&directory),
        Path::new("oversize.bin"),
        usize::MAX
    )
    .is_err());
    assert!(HeldPrivateRead::open(directory, Path::new("oversize.bin"), 0).is_err());
}
