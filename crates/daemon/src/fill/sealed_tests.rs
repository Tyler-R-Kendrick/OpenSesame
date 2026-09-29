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
    let value = state
        .resolve("Web/example.com", &origin, Field::Password)
        .unwrap();
    assert_eq!(value.as_str(), "sealed-secret");
    assert_eq!(
        state
            .resolve("Web/lookalike", &origin, Field::Password)
            .unwrap_err(),
        SourceError::Missing
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
