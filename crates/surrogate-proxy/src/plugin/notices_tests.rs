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
    // Noise in one file, evidence in the other; both owner-only.
    let text = std::fs::read_to_string(&path).unwrap();
    let evidence = std::fs::read_to_string(dir.path().join("state").join(TRIPWIRES_FILE)).unwrap();
    assert_eq!(text.lines().count(), 1);
    assert_eq!(evidence.lines().count(), 1);
    assert!(evidence.contains("surrogate.misdirected"));
    assert!(!names_marker(&text) && !names_marker(&evidence));
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

fn lines_of(path: &Path) -> Vec<String> {
    std::fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .map(str::to_owned)
        .collect()
}

#[test]
fn a_flood_of_junk_refusals_cannot_erase_the_exfiltration_notice() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("notices.jsonl");
    let log = NoticeLog::open(&path).unwrap();
    log.refused(&refusal(RefusalCode::Misdirected, Some("evil.test")));
    for n in 0..6000 {
        // Forged surrogates that differ per request: distinct details, so
        // only the rate limit and the key cap stand between them and disk.
        log.refused(&refusal(
            RefusalCode::Unknown,
            Some(&format!("site-{n}.example")),
        ));
    }
    log.flush_and_close();
    let tripwires = lines_of(&dir.path().join(TRIPWIRES_FILE));
    assert_eq!(tripwires.len(), 1, "{tripwires:?}");
    assert!(tripwires[0].contains("surrogate.misdirected"));
    assert!(tripwires[0].contains("evil.test"));
    let noise = lines_of(&path);
    assert!(noise.len() <= 60, "{} noise lines written", noise.len());
    assert!(noise.iter().all(|l| !l.contains("surrogate.misdirected")));
}

#[test]
fn the_same_refusal_is_written_once_per_run() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("notices.jsonl");
    let log = NoticeLog::open(&path).unwrap();
    for _ in 0..500 {
        log.refused(&refusal(RefusalCode::Unknown, None));
        log.refused(&refusal(RefusalCode::Misdirected, Some("evil.test")));
    }
    log.flush_and_close();
    assert_eq!(lines_of(&path).len(), 1);
    assert_eq!(lines_of(&dir.path().join(TRIPWIRES_FILE)).len(), 1);
}

#[test]
fn distinct_forged_surrogates_are_one_key() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("notices.jsonl");
    let log = NoticeLog::open(&path).unwrap();
    for n in 0..200 {
        let forged = format!("osr_{n:032x}");
        log.refused(&refusal(RefusalCode::Misplaced, Some(&forged)));
    }
    log.flush_and_close();
    let all = lines_of(&path).len() + lines_of(&dir.path().join(TRIPWIRES_FILE)).len();
    assert_eq!(all, 1);
}

#[test]
fn evidence_is_capped_by_dropping_the_newest_never_by_rotating_the_first_away() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(TRIPWIRES_FILE);
    let first = "first".repeat(20);
    append_capped(&path, &first, 500).unwrap();
    for n in 0..100 {
        append_capped(&path, &format!("{n:0>99}"), 500).unwrap();
    }
    let text = std::fs::read_to_string(&path).unwrap();
    assert!(text.starts_with(&first));
    assert!(text.len() <= 500, "{}", text.len());
    assert!(!dir.path().join(NOTICES_ROTATED_FILE).exists());
}

#[test]
fn many_distinct_tripwires_are_bounded_in_count_and_in_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("notices.jsonl");
    let log = NoticeLog::open(&path).unwrap();
    for n in 0..5000 {
        log.refused(&refusal(
            RefusalCode::Misdirected,
            Some(&format!("evil-{n}.test")),
        ));
    }
    log.flush_and_close();
    let tripwires = dir.path().join(TRIPWIRES_FILE);
    assert!(lines_of(&tripwires).len() <= 256);
    assert!(std::fs::metadata(&tripwires).unwrap().len() <= MAX_TRIPWIRE_BYTES);
    assert!(lines_of(&tripwires)[0].contains("evil-0.test"));
}
