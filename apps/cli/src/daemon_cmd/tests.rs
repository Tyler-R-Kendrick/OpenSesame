use super::{daemon_program, read_log, LogRead};
use std::path::{Path, PathBuf};

#[test]
fn the_daemon_starts_from_this_binary_or_not_at_all() {
    let here = PathBuf::from("/opt/opensesame/bin/opensesame");
    assert_eq!(daemon_program(Ok(here.clone())), Ok(here));
    let lost = std::io::Error::other("no /proc");
    let error = daemon_program(Err(lost)).expect_err("no guessing at a PATH search");
    assert!(
        error.contains("cannot tell where this opensesame is"),
        "{error}"
    );
}

fn dir() -> tempfile::TempDir {
    tempfile::tempdir().expect("tempdir")
}

#[test]
fn no_logfile_falls_through_to_the_health_probe() {
    let d = dir();
    let log = d.path().join("daemon.log");
    assert!(matches!(read_log(&log, None), LogRead::Missing));
}

#[test]
fn plaintext_log_with_no_key_is_read_scrubbed() {
    let d = dir();
    let log = d.path().join("daemon.log");
    std::fs::write(&log, "started ok\nlogin password=hunter2value\n").unwrap();
    assert!(!d.path().join("daemon.log.key").exists());
    match read_log(&log, None) {
        LogRead::Lines(lines) => {
            assert_eq!(lines.len(), 2);
            assert_eq!(lines[0], "started ok");
            assert!(!lines.join("\n").contains("hunter2value"), "{lines:?}");
        }
        other => panic!("expected lines, got {other:?}"),
    }
    assert!(
        !d.path().join("daemon.log.key").exists(),
        "never creates a key"
    );
}

#[test]
fn sealed_log_with_no_key_is_unreadable() {
    let d = dir();
    let log = d.path().join("daemon.log");
    let key = opensesame_sealed_log::LogKey::generate();
    let sealed = opensesame_sealed_log::seal_line(&key, "secret line");
    std::fs::write(&log, format!("{sealed}\n")).unwrap();
    assert!(matches!(read_log(&log, None), LogRead::Unreadable(_)));
}

#[test]
fn sealed_log_with_its_key_is_opened() {
    let d = dir();
    let log: &Path = &d.path().join("daemon.log");
    let key_path = d.path().join("daemon.log.key");
    let key = opensesame_sealed_log::LogKey::load_or_create(&key_path).unwrap();
    let sealed = opensesame_sealed_log::seal_line(&key, "hello");
    std::fs::write(log, format!("{sealed}\n")).unwrap();
    match read_log(log, None) {
        LogRead::Lines(lines) => assert_eq!(lines, vec!["hello".to_owned()]),
        other => panic!("expected lines, got {other:?}"),
    }
}

#[test]
fn daemon_args_print_no_operator_token() {
    let args = super::DaemonArgs {
        url: "http://127.0.0.1:18790".into(),
        operator_token: Some("operator-12345".into()),
        cmd: super::DaemonCmd::Status,
    };
    let shown = format!("{args:?}");
    assert!(
        shown.contains("[REDACTED]") && shown.contains("18790"),
        "{shown}"
    );
    assert!(!shown.contains("operator-12345"), "{shown}");
}
