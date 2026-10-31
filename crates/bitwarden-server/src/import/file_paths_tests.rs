use super::*;
use crate::import::FileSource;

#[test]
fn file_ids_are_plain_segments_in_paths_and_urls() {
    for valid in ["abc123", "2c510b84-f635-4dd8-a688-99ab", "file_id-123"] {
        assert!(safe_component(valid), "{valid}");
    }
    for invalid in [
        "",
        ".",
        "..",
        "../outside",
        "a/b",
        "a\\b",
        "/outside",
        "\\outside",
        "C:\\outside",
        "C:outside",
        "%2e%2e",
        "a%2fb",
        "a%5cb",
        "a?b",
        "a#b",
        "a\0b",
        "é",
    ] {
        assert!(!safe_component(invalid), "{invalid:?}");
    }
    assert!(!safe_component(&"a".repeat(256)));
}

#[test]
fn file_intake_checks_metadata_and_bounds_the_actual_read() {
    let mut file = tempfile::tempfile().unwrap();
    std::io::Write::write_all(&mut file, b"data").unwrap();
    assert!(read_file(file.try_clone().unwrap(), 3).is_none());
    std::io::Seek::rewind(&mut file).unwrap();
    assert_eq!(read_file(file, 4).unwrap(), b"data");
    // This streaming bound also covers a file growing after the metadata check.
    assert!(read_bounded(std::io::Cursor::new(b"data"), 3).is_none());
    assert_eq!(
        read_bounded(std::io::Cursor::new(b"data"), 4).unwrap(),
        b"data"
    );
}

#[cfg(not(unix))]
#[test]
fn archive_file_intake_refuses_unsupported_no_follow_readers() {
    let directory = tempfile::tempfile().unwrap();
    assert!(read_confined(&directory, &["file".into()]).is_none());
}

#[cfg(unix)]
#[test]
fn confined_reads_hold_the_original_root_and_refuse_links() {
    use std::os::unix::fs::symlink;

    let scratch = tempfile::tempdir().unwrap();
    let root = scratch.path().join("archive");
    let nested = root.join("attachments").join("cipher");
    std::fs::create_dir_all(&nested).unwrap();
    std::fs::write(nested.join("file"), b"ciphertext").unwrap();
    let directory = FileSource::confined_root(&root).unwrap();
    let source = FileSource::confined(&directory, &["attachments", "cipher", "file"]).unwrap();
    let FileSource::Confined {
        directory,
        components,
    } = source
    else {
        unreachable!();
    };
    assert_eq!(
        read_confined(&directory, &components).unwrap(),
        b"ciphertext"
    );

    // Replacing the archive's pathname cannot redirect the retained root FD.
    let original = scratch.path().join("original");
    std::fs::rename(&root, &original).unwrap();
    symlink(scratch.path(), &root).unwrap();
    assert_eq!(
        read_confined(&directory, &components).unwrap(),
        b"ciphertext"
    );

    let nested = original.join("attachments").join("cipher");
    let outside = scratch.path().join("outside");
    std::fs::write(&outside, b"private local data").unwrap();
    std::fs::remove_file(nested.join("file")).unwrap();
    symlink(&outside, nested.join("file")).unwrap();
    assert!(read_confined(&directory, &components).is_none());
    std::fs::remove_file(nested.join("file")).unwrap();
    std::fs::hard_link(&outside, nested.join("file")).unwrap();
    assert!(read_confined(&directory, &components).is_none());

    // Parent components must also be opened no-follow, not only the leaf.
    std::fs::remove_dir_all(&nested).unwrap();
    symlink(scratch.path(), &nested).unwrap();
    assert!(read_confined(&directory, &components).is_none());
    assert!(read_confined(&directory, &["..".into(), "outside".into()]).is_none());
}

#[cfg(unix)]
#[test]
fn confined_reads_refuse_nonregular_nodes_without_blocking() {
    use std::os::unix::net::UnixListener;

    let root = tempfile::tempdir().unwrap();
    let _socket = UnixListener::bind(root.path().join("socket")).unwrap();
    let directory = File::open(root.path()).unwrap();
    assert!(read_confined(&directory, &["socket".into()]).is_none());
    assert!(read_confined(&directory, &[]).is_none());
    let directory = FileSource::confined_root(root.path()).unwrap();
    assert!(FileSource::confined(&directory, &["../outside"]).is_none());
}
