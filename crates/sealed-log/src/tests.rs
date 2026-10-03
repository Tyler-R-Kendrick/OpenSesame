use std::io::Write;

use tempfile::tempdir;

use super::*;

fn key() -> LogKey {
    LogKey::from_bytes([7; 32])
}

#[test]
fn a_line_round_trips_and_shows_nothing() {
    let sealed = seal_line(&key(), "claim opened for ada@example.com");
    assert!(sealed.starts_with(LINE_PREFIX));
    assert!(!sealed.contains("ada") && !sealed.contains("claim"));
    assert_eq!(
        open_line(&key(), &sealed).as_deref(),
        Some("claim opened for ada@example.com")
    );
}

#[test]
fn two_seals_of_one_line_differ() {
    assert_ne!(seal_line(&key(), "same"), seal_line(&key(), "same"));
}

#[test]
fn a_wrong_key_or_a_torn_or_altered_line_does_not_open() {
    let sealed = seal_line(&key(), "line");
    assert!(open_line(&LogKey::from_bytes([8; 32]), &sealed).is_none());
    assert!(open_line(&key(), &sealed[..sealed.len() - 6]).is_none());
    let mut altered = sealed.clone();
    altered.replace_range(10..11, if &altered[10..11] == "A" { "B" } else { "A" });
    assert!(open_line(&key(), &altered).is_none());
    assert!(open_line(&key(), "plain text").is_none());
    assert!(open_line(&key(), LINE_PREFIX).is_none());
}

#[test]
fn a_key_file_is_created_once_owner_only_and_reloaded() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("nested/log.key");
    let first = LogKey::load_or_create(&path).unwrap();
    let again = LogKey::load_or_create(&path).unwrap();
    let sealed = seal_line(&first, "x");
    assert_eq!(open_line(&again, &sealed).as_deref(), Some("x"));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }
}

#[test]
fn a_key_file_that_holds_no_key_is_never_overwritten() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("log.key");
    std::fs::write(&path, "not a key\n").unwrap();
    assert!(LogKey::load_or_create(&path).is_err());
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "not a key\n");
}

#[test]
fn racing_creators_agree_on_one_key() {
    let dir = tempdir().unwrap();
    let path = std::sync::Arc::new(dir.path().join("log.key"));
    let handles: Vec<_> = (0..8)
        .map(|_| {
            let path = path.clone();
            std::thread::spawn(move || {
                let key = LogKey::load_or_create(&path).unwrap();
                seal_line(&key, "probe")
            })
        })
        .collect();
    let reader = LogKey::load_or_create(&path).unwrap();
    for handle in handles {
        assert_eq!(
            open_line(&reader, &handle.join().unwrap()).as_deref(),
            Some("probe")
        );
    }
}

#[test]
fn the_file_holds_only_sealed_lines_and_reads_back() {
    let dir = tempdir().unwrap();
    let log = dir.path().join("daemon.log");
    let sink = open_sink(&log, None).unwrap();
    {
        let mut writer = sink.writer();
        writer.write_all(b"first line\nsecond ").unwrap();
        writer.write_all(b"line\nthird, unterminated").unwrap();
    }
    let raw = std::fs::read_to_string(&log).unwrap();
    assert!(!raw.contains("first") && !raw.contains("second") && !raw.contains("third"));
    assert!(raw.lines().all(|line| line.starts_with(LINE_PREFIX)));
    let key = LogKey::load_or_create(&key_path_for(&log, None)).unwrap();
    assert_eq!(
        read_tail(&log, &key, 10).unwrap(),
        ["first line", "second line", "third, unterminated"]
    );
    assert_eq!(read_tail(&log, &key, 2).unwrap().len(), 2);
}

#[cfg(unix)]
#[test]
fn a_file_an_older_build_left_wide_open_is_narrowed() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempdir().unwrap();
    let log = dir.path().join("daemon.log");
    std::fs::write(&log, "").unwrap();
    std::fs::set_permissions(&log, std::fs::Permissions::from_mode(0o644)).unwrap();
    let _sink = open_sink(&log, None).unwrap();
    let mode = std::fs::metadata(&log).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o600);
}

#[test]
fn rotation_keeps_whole_files_and_a_bounded_number() {
    let dir = tempdir().unwrap();
    let log = dir.path().join("rot.log");
    let mut file = SealedLogFile::open_with(&log, key(), 400, 2).unwrap();
    for n in 0..40 {
        file.append(&format!("event number {n} with some padding text"))
            .unwrap();
    }
    assert!(rotated_path(&log, 1).exists() && rotated_path(&log, 2).exists());
    assert!(!rotated_path(&log, 3).exists());
    for path in [log.clone(), rotated_path(&log, 1), rotated_path(&log, 2)] {
        for line in std::fs::read_to_string(&path).unwrap().lines() {
            assert!(open_line(&key(), line).is_some(), "{path:?}");
        }
    }
    let tail = read_tail(&log, &key(), 3).unwrap();
    assert_eq!(
        tail.last().map(String::as_str),
        Some("event number 39 with some padding text")
    );
}

#[test]
fn a_plaintext_log_is_sealed_in_place_and_scrubbed_on_the_way() {
    let dir = tempdir().unwrap();
    let log = dir.path().join("daemon.log");
    std::fs::write(
        &log,
        "started ok\nrequest failed: https://h.example/x#token=abc123\n",
    )
    .unwrap();
    let key = key();
    assert_eq!(seal_existing(&log, &key).unwrap(), 2);
    let raw = std::fs::read_to_string(&log).unwrap();
    assert!(!raw.contains("started") && !raw.contains("abc123"));
    let lines = read_tail(&log, &key, 10).unwrap();
    assert_eq!(lines[0], "started ok");
    assert!(!lines[1].contains("abc123") && lines[1].contains("request failed"));
    assert_eq!(
        seal_existing(&log, &key).unwrap(),
        0,
        "a second pass finds nothing"
    );
}

#[test]
fn a_plaintext_line_is_scrubbed_when_read_and_a_wrong_key_is_named() {
    let dir = tempdir().unwrap();
    let log = dir.path().join("daemon.log");
    std::fs::write(&log, "password=hunter2 in the old log\n").unwrap();
    let plain = read_tail(&log, &key(), 5).unwrap();
    assert!(!plain[0].contains("hunter2"));

    let sink = open_sink(&log, None).unwrap();
    sink.writer().write_all(b"sealed now\n").unwrap();
    let wrong = read_tail(&log, &LogKey::from_bytes([9; 32]), 5).unwrap();
    assert!(wrong.iter().all(|line| line == UNREADABLE));
}

#[test]
fn concurrent_writers_interleave_whole_lines() {
    let dir = tempdir().unwrap();
    let log = dir.path().join("many.log");
    let sink = open_sink(&log, None).unwrap();
    let handles: Vec<_> = (0..6)
        .map(|t| {
            let sink = sink.clone();
            std::thread::spawn(move || {
                for n in 0..50 {
                    sink.writer()
                        .write_all(format!("thread {t} line {n}\n").as_bytes())
                        .unwrap();
                }
            })
        })
        .collect();
    for handle in handles {
        handle.join().unwrap();
    }
    let key = LogKey::load_or_create(&key_path_for(&log, None)).unwrap();
    let lines = read_tail(&log, &key, 1000).unwrap();
    assert_eq!(lines.len(), 300);
    assert!(lines.iter().all(|line| line.starts_with("thread ")));
}

#[test]
fn the_key_path_defaults_beside_the_log_and_can_be_pointed_elsewhere() {
    let log = std::path::Path::new("/var/log/opensesame/host.log");
    assert_eq!(
        key_path_for(log, None),
        std::path::PathBuf::from("/var/log/opensesame/host.log.key")
    );
    assert_eq!(
        key_path_for(log, Some("/run/secrets/log-key")),
        std::path::PathBuf::from("/run/secrets/log-key")
    );
    assert_eq!(
        key_path_for(log, Some("")),
        std::path::PathBuf::from("/var/log/opensesame/host.log.key")
    );
}

#[test]
fn a_key_never_prints() {
    assert_eq!(format!("{:?}", key()), "LogKey([REDACTED])");
}

#[test]
fn loading_a_key_never_creates_one() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("absent.key");
    assert_eq!(
        LogKey::load(&path).unwrap_err().kind(),
        std::io::ErrorKind::NotFound
    );
    assert!(!path.exists());
}
