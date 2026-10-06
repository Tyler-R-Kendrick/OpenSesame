//! The production source against a real sealed store: the same
//! `opensesame-sealed-store` calls `opensesame pass` makes, one Argon2 unlock
//! per request, nothing cached.
use super::source::{EntrySource, SealedSource, SourceError};
use super::*;
use opensesame_sealed_store::{init_store, init_store_key, Entry, StoreRoot};

const PASSPHRASE: &str = "fill fixture passphrase";

fn fixture(root: &std::path::Path) {
    init_store(root, &[]).unwrap();
    let key = init_store_key(root, PASSPHRASE.as_bytes()).unwrap();
    let store = StoreRoot::open(root).unwrap();
    store
        .insert(
            "Web/example.com",
            &Entry {
                secret: "sealed-secret".into(),
                trailer: "login: alice\nurl: https://example.com/login\n".into(),
                otp: None,
            },
            &key,
        )
        .unwrap();
    store
        .insert(
            "Web/lookalike",
            &Entry {
                secret: "lookalike-secret".into(),
                trailer: "url: https://example.com.evil.test/\n".into(),
                otp: None,
            },
            &key,
        )
        .unwrap();
}

#[test]
fn the_sealed_store_answers_one_field_for_its_exact_origin() {
    let dir = tempfile::tempdir().unwrap();
    fixture(dir.path());
    let state = FillState::new(
        Box::new(SealedSource::at(dir.path().to_path_buf(), PASSPHRASE)),
        None,
        Arc::new(gate::Fixed(true)),
    );
    let origin = WebOrigin::parse_request("https://example.com").unwrap();
    let (names, truncated) = state.matches(&origin).unwrap();
    assert_eq!(
        (names, truncated),
        (vec!["Web/example.com".to_string()], false)
    );
    let filled = state
        .resolve("Web/example.com", &origin, Field::Password)
        .unwrap();
    assert_eq!(filled.value.as_str(), "sealed-secret");
    assert!(!filled.pepper);
    assert_eq!(
        state
            .resolve("Web/lookalike", &origin, Field::Password)
            .err(),
        Some(SourceError::Missing)
    );
}

#[test]
fn a_keyed_store_without_its_passphrase_is_locked() {
    let dir = tempfile::tempdir().unwrap();
    init_store(dir.path(), &[]).unwrap();
    init_store_key(dir.path(), PASSPHRASE.as_bytes()).unwrap();
    let wrong = SealedSource::at(dir.path().to_path_buf(), "not the passphrase");
    assert_eq!(wrong.open().err(), Some(SourceError::Locked));
}

/// An account the vault wrote: sites and methods in the trailer's JSON, and no
/// password in the file when an algorithm computes it (ADR 0174).
fn account_entry(path: &str, secret: &str, method: &serde_json::Value) -> (String, Entry) {
    let meta = serde_json::json!({
        "kind": "account", "v": 2, "username": "alice",
        "uris": ["https://bank.example"],
        "values": { "methods": [method] },
    });
    (
        path.to_owned(),
        Entry {
            secret: secret.to_owned(),
            trailer: format!("{meta}\n"),
            otp: None,
        },
    )
}

#[test]
fn fill_produces_an_algorithmic_password_the_file_does_not_hold_and_stops_at_a_pepper_slot() {
    let vectors: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../spec/conformance/produce-vectors.json"
    ))
    .unwrap();
    let case = &vectors["derived"][0];
    let expected = case["password"].as_str().unwrap();
    let derived = serde_json::json!({
        "id": "m", "type": "password", "pepper": false, "secret": case["root"],
        "generator": { "id": "derived", "rules": case["rules"], "counter": case["counter"] },
        "changedAt": "2026-01-01T00:00:00.000Z"
    });
    let slotted = serde_json::json!({
        "id": "m", "type": "password", "pepper": true, "pepperAt": "-3", "secret": case["root"],
        "generator": { "id": "derived", "rules": case["rules"], "counter": case["counter"] },
        "changedAt": "2026-01-01T00:00:00.000Z"
    });
    let legacy = serde_json::json!({
        "id": "m", "type": "password", "pepper": true, "secret": "",
        "generator": { "id": "manual" }, "sealed": { "v": 1 }, "changedAt": "x"
    });
    let dir = tempfile::tempdir().unwrap();
    init_store(dir.path(), &[]).unwrap();
    let key = init_store_key(dir.path(), PASSPHRASE.as_bytes()).unwrap();
    let store = StoreRoot::open(dir.path()).unwrap();
    for (path, method) in [
        ("A/derived", &derived),
        ("A/slotted", &slotted),
        ("A/legacy", &legacy),
    ] {
        let (name, entry) = account_entry(path, "", method);
        assert!(
            !entry.trailer.contains(expected),
            "a file holds no generated password"
        );
        store.insert(&name, &entry, &key).unwrap();
    }
    let state = FillState::new(
        Box::new(SealedSource::at(dir.path().to_path_buf(), PASSPHRASE)),
        None,
        Arc::new(gate::Fixed(true)),
    );
    let origin = WebOrigin::parse_request("https://bank.example").unwrap();
    let whole = state
        .resolve("A/derived", &origin, Field::Password)
        .unwrap();
    assert_eq!((whole.value.as_str(), whole.pepper), (expected, false));
    let part = state
        .resolve("A/slotted", &origin, Field::Password)
        .unwrap();
    assert!(part.pepper);
    assert_eq!(part.value.as_str(), &expected[..expected.len() - 3]);
    assert_eq!(
        state.resolve("A/legacy", &origin, Field::Password).err(),
        Some(SourceError::Legacy)
    );
    let user = state
        .resolve("A/derived", &origin, Field::Username)
        .unwrap();
    assert_eq!(user.value.as_str(), "alice");
}
