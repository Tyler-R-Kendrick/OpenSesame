//! Several writers on one path, and rotated generations an older build left.

use tempfile::tempdir;

use super::*;

fn key() -> LogKey {
    LogKey::from_bytes([7; 32])
}

/// A sealed `x`-line is 86 bytes with its newline; two fit under 200.
const LINE: &str = "xxxxxxxxxxxxxxxxxxxx";
const MAX: u64 = 200;

fn opened(path: &std::path::Path) -> Vec<String> {
    std::fs::read_to_string(path)
        .unwrap()
        .lines()
        .map(|line| open_line(&key(), line).expect("sealed line"))
        .collect()
}

#[test]
fn a_writer_never_appends_to_a_generation_another_process_rotated() {
    let dir = tempdir().unwrap();
    let log = dir.path().join("shared.log");
    let mut a = SealedLogFile::open_with(&log, key(), MAX, 3).unwrap();
    let mut b = SealedLogFile::open_with(&log, key(), MAX, 3).unwrap();
    a.append(&format!("{LINE}1")).unwrap();
    a.append(&format!("{LINE}2")).unwrap();
    a.append(&format!("{LINE}3")).unwrap(); // rotates: b's descriptor is now `.1`
    b.append("from b").unwrap();
    assert_eq!(opened(&log), [format!("{LINE}3"), "from b".to_owned()]);
    assert_eq!(
        opened(&rotated_path(&log, 1)),
        [format!("{LINE}1"), format!("{LINE}2")]
    );
}

#[test]
fn a_writer_does_not_rotate_the_fresh_file_another_process_started() {
    let dir = tempdir().unwrap();
    let log = dir.path().join("shared.log");
    let mut a = SealedLogFile::open_with(&log, key(), MAX, 3).unwrap();
    let mut b = SealedLogFile::open_with(&log, key(), MAX, 3).unwrap();
    b.append(&format!("{LINE}1")).unwrap();
    b.append(&format!("{LINE}2")).unwrap(); // b now believes the file is full
    a.append(&format!("{LINE}3")).unwrap(); // a sees the real size and rotates
    b.append(&format!("{LINE}4")).unwrap();
    assert_eq!(opened(&log), [format!("{LINE}3"), format!("{LINE}4")]);
    assert!(!rotated_path(&log, 2).exists(), "no second rotation");
}

#[test]
fn a_writer_recreates_a_log_removed_from_under_it() {
    let dir = tempdir().unwrap();
    let log = dir.path().join("shared.log");
    let mut a = SealedLogFile::open_with(&log, key(), MAX, 3).unwrap();
    a.append("before").unwrap();
    std::fs::remove_file(&log).unwrap();
    a.append("after").unwrap();
    assert_eq!(opened(&log), ["after"]);
}

#[test]
fn rotated_generations_an_older_build_left_in_the_clear_are_sealed_too() {
    let dir = tempdir().unwrap();
    let log = dir.path().join("daemon.log");
    std::fs::write(&log, "live line\n").unwrap();
    std::fs::write(rotated_path(&log, 1), "older\ntoken=abc123def\n").unwrap();
    std::fs::write(rotated_path(&log, 2), "oldest\n").unwrap();
    let key = key();
    assert_eq!(seal_existing(&log, &key).unwrap(), 4);
    for path in [log.clone(), rotated_path(&log, 1), rotated_path(&log, 2)] {
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(!raw.contains("line") && !raw.contains("older") && !raw.contains("abc123"));
        assert!(raw.lines().all(|line| line.starts_with(LINE_PREFIX)));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
    }
    assert!(!opened(&rotated_path(&log, 1))[1].contains("abc123"));
    assert_eq!(seal_existing(&log, &key).unwrap(), 0, "idempotent");
}
