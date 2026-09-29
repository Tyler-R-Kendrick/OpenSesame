use super::*;
use opensesame_invoke_through::RefusalCode;

const SURROGATE: &str = "osr_0123456789abcdef0123456789abcdef";

fn refusal(code: RefusalCode, detail: Option<&str>) -> Refusal {
    Refusal {
        code,
        run_id: Some("dev-7f3a-1".into()),
        provider_id: Some("github".into()),
        detail: detail.map(str::to_owned),
    }
}

#[test]
fn a_misdirected_refusal_becomes_a_vetted_notice_line() {
    let line = notice_line(&refusal(RefusalCode::Misdirected, Some("evil.test"))).unwrap();
    let value: serde_json::Value = serde_json::from_str(&line).unwrap();
    assert_eq!(value["event_type"], "surrogate.misdirected");
    assert_eq!(value["severity"], "error");
    assert_eq!(value["subject_id"], "dev-7f3a-1");
    assert!(value["summary"].as_str().unwrap().contains("evil.test"));
}

#[test]
fn a_surrogate_planted_in_a_detail_never_reaches_the_file() {
    for detail in [
        SURROGATE,
        "OSR_0123456789ABCDEF0123456789ABCDEF",
        "0123456789abcdef0123456789abcdef",
    ] {
        let line = notice_line(&refusal(RefusalCode::Misplaced, Some(detail))).unwrap();
        assert!(!names_marker(&line), "{line}");
        assert!(!line.contains("0123456789abcdef0123456789abcdef"), "{line}");
    }
}

#[test]
fn a_surrogate_planted_in_a_run_id_is_withheld() {
    let mut planted = refusal(RefusalCode::Revoked, None);
    planted.run_id = Some(SURROGATE.into());
    let line = notice_line(&planted).unwrap();
    assert!(!names_marker(&line), "{line}");
}

#[test]
fn the_log_writes_owner_only_lines_and_flushes_on_close() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state").join("notices.jsonl");
    let log = NoticeLog::open(&path).unwrap();
    log.refused(&refusal(RefusalCode::Misdirected, Some("evil.test")));
    log.refused(&refusal(RefusalCode::Unknown, None));
    log.flush_and_close();
    let text = std::fs::read_to_string(&path).unwrap();
    assert_eq!(text.lines().count(), 2);
    assert!(!names_marker(&text));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        let dir_mode = std::fs::metadata(path.parent().unwrap())
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(dir_mode, 0o700);
    }
    // Closed: a late refusal is dropped, never a panic.
    log.refused(&refusal(RefusalCode::Unknown, None));
}

#[test]
fn a_flood_of_refusals_is_capped_by_rotation() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("notices.jsonl");
    let line = "x".repeat(99);
    for _ in 0..50 {
        append(&path, &line, 1000).unwrap();
    }
    let current = std::fs::metadata(&path).unwrap().len();
    let rotated = std::fs::metadata(dir.path().join(NOTICES_ROTATED_FILE))
        .unwrap()
        .len();
    assert!(current <= 1000, "{current}");
    assert!(rotated <= 1000, "{rotated}");
}
