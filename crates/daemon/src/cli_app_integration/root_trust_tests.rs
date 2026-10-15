use std::path::{Path, PathBuf};

use opensesame_cli_app_integration::{fingerprint_of_spki, RootTrustRecord};
use opensesame_sealed_store::OSSEAL_MAGIC;
use tower::ServiceExt;

use super::{apply_at_startup, load, resolve_state_dir, save, LoadOutcome, StateLocation};

fn record(byte: u8, epoch: u64) -> RootTrustRecord {
    RootTrustRecord::new(fingerprint_of_spki(&[byte; 8]), epoch).expect("record")
}

fn seal_file(state_dir: &Path) -> PathBuf {
    state_dir
        .join("cli-app-integration")
        .join("root-trust.osseal")
}

fn key_file(state_dir: &Path) -> PathBuf {
    state_dir.join("cli-app-integration").join("root-trust.key")
}

#[test]
fn state_dir_prefers_explicit_then_xdg_then_local_then_home() {
    let explicit = Path::new("/explicit");
    let xdg = Path::new("/xdg");
    let local = Path::new("/local");
    let home = Path::new("/home/person");
    let all = StateLocation {
        explicit: Some(explicit),
        xdg_state_home: Some(xdg),
        local_app_data: Some(local),
        home: Some(home),
    };
    assert_eq!(resolve_state_dir(&all).unwrap(), explicit);
    assert_eq!(
        resolve_state_dir(&StateLocation {
            explicit: None,
            ..all
        })
        .unwrap(),
        xdg.join("opensesame")
    );
    assert_eq!(
        resolve_state_dir(&StateLocation {
            explicit: None,
            xdg_state_home: None,
            ..all
        })
        .unwrap(),
        local.join("OpenSesame")
    );
    assert_eq!(
        resolve_state_dir(&StateLocation {
            explicit: None,
            xdg_state_home: None,
            local_app_data: None,
            home: Some(home),
        })
        .unwrap(),
        home.join(".local/state/opensesame")
    );
    assert!(resolve_state_dir(&StateLocation {
        explicit: None,
        xdg_state_home: None,
        local_app_data: None,
        home: None,
    })
    .is_none());
}

#[test]
fn missing_store_is_absent_and_does_not_create_the_directory() {
    let dir = tempfile::tempdir().unwrap();
    let missing = dir.path().join("no-such");
    assert!(matches!(load(&missing).unwrap(), LoadOutcome::Absent));
    assert!(!missing.exists());
}

#[test]
fn save_and_load_round_trip_fingerprint_and_epoch() {
    let dir = tempfile::tempdir().unwrap();
    let stored = record(1, 4);
    save(dir.path(), &stored).unwrap();
    match load(dir.path()).unwrap() {
        LoadOutcome::Enrolled(loaded) => assert_eq!(loaded, stored),
        LoadOutcome::Absent => panic!("saved record missing"),
    }
}

#[test]
fn seal_hides_the_fingerprint_and_files_are_owner_only() {
    let dir = tempfile::tempdir().unwrap();
    let stored = record(9, 2);
    save(dir.path(), &stored).unwrap();
    let bytes = std::fs::read(seal_file(dir.path())).unwrap();
    assert!(bytes.starts_with(OSSEAL_MAGIC));
    let fingerprint = stored.spki_fingerprint().as_bytes();
    assert!(!bytes
        .windows(fingerprint.len())
        .any(|window| window == fingerprint));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = |path: &Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&seal_file(dir.path())), 0o600);
        assert_eq!(mode(&key_file(dir.path())), 0o600);
        assert_eq!(mode(&dir.path().join("cli-app-integration")), 0o700);
    }
}

#[test]
fn resave_replaces_the_record_and_keeps_the_sealing_key() {
    let dir = tempfile::tempdir().unwrap();
    save(dir.path(), &record(1, 1)).unwrap();
    let key = std::fs::read(key_file(dir.path())).unwrap();
    let next = record(2, 5);
    save(dir.path(), &next).unwrap();
    assert_eq!(std::fs::read(key_file(dir.path())).unwrap(), key);
    match load(dir.path()).unwrap() {
        LoadOutcome::Enrolled(loaded) => assert_eq!(loaded, next),
        LoadOutcome::Absent => panic!("replaced record missing"),
    }
}

#[test]
fn corrupt_seal_or_missing_key_does_not_enroll() {
    let dir = tempfile::tempdir().unwrap();
    save(dir.path(), &record(3, 1)).unwrap();
    std::fs::write(seal_file(dir.path()), b"OSSEAL1\nnot-a-record").unwrap();
    assert!(load(dir.path()).is_err());

    let again = tempfile::tempdir().unwrap();
    save(again.path(), &record(3, 1)).unwrap();
    std::fs::remove_file(key_file(again.path())).unwrap();
    assert!(load(again.path()).is_err());
}

#[test]
fn startup_marks_root_key_enrolled_from_the_store() {
    let dir = tempfile::tempdir().unwrap();
    let stored = record(6, 7);
    save(dir.path(), &stored).unwrap();
    let host = super::super::open_store(Some(dir.path()));
    let host = host.lock().unwrap();
    assert!(host.pairings.is_root_key_enrolled());
    assert_eq!(host.pairings.root_trust(), Some(&stored));
}

#[test]
fn startup_leaves_the_key_unenrolled_when_the_store_is_missing_or_unreadable() {
    let empty = tempfile::tempdir().unwrap();
    let missing = super::super::open_store(Some(empty.path()));
    assert!(!missing.lock().unwrap().pairings.is_root_key_enrolled());

    let none = super::super::open_store(None);
    assert!(!none.lock().unwrap().pairings.is_root_key_enrolled());

    let bad = tempfile::tempdir().unwrap();
    save(bad.path(), &record(4, 1)).unwrap();
    std::fs::write(seal_file(bad.path()), b"garbage").unwrap();
    let mut host = opensesame_cli_app_integration::CliAppIntegrationHost::new();
    apply_at_startup(&mut host, bad.path());
    assert!(!host.pairings.is_root_key_enrolled());
    assert!(host.pairings.root_trust().is_none());
}

#[tokio::test]
async fn enrolled_store_lets_confirm_past_the_root_key_gate() {
    let dir = tempfile::tempdir().unwrap();
    save(dir.path(), &record(8, 1)).unwrap();
    let mut state = crate::test_fixtures::test_state("http://127.0.0.1:8787");
    state.cli_app_integration = super::super::open_store(Some(dir.path()));
    let app = crate::router(state);
    let response = app
        .oneshot(confirm_request())
        .await
        .expect("confirm response");
    assert_eq!(response.status(), axum::http::StatusCode::FORBIDDEN);
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let parsed: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(parsed["error"], "pairing_refused");
}

fn confirm_request() -> axum::http::Request<axum::body::Body> {
    use axum::body::Body;
    use axum::http::{header, Request};
    Request::builder()
        .method("POST")
        .uri("/v1/cli/app-integration/pairing/confirm")
        .header("content-type", "application/json")
        .header(header::ORIGIN, "http://localhost:5180")
        .body(Body::from(
            serde_json::json!({
                "code": "unused",
                "devicePublicKeySpkiB64": "unused",
                "pairingSignatureB64": "unused",
                "vaultSessionRootDigest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            })
            .to_string(),
        ))
        .unwrap()
}
