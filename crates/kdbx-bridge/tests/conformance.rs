//! The cross-implementation conformance guard.
//!
//! `fixtures/kdbx/roundtrip.kdbx` and `roundtrip.expected.json` are committed
//! artifacts. This crate produces them (`cargo test -p opensesame-kdbx-bridge
//! --test conformance -- --ignored regenerate_fixture`) and asserts on every
//! run that the committed pair still agree. The pages `kdbxweb` adapter reads
//! the same two files, which is what makes them a guard on the `keepass`
//! crate's experimental KDBX4 writer rather than a self-fulfilling round-trip.

mod common;

use keepass::config::{
    CompressionConfig, DatabaseVersion, InnerCipherConfig, KdfConfig, OuterCipherConfig,
};
use keepass::db::Database;
use keepass::DatabaseKey;
use opensesame_kdbx_bridge::{map, map_kdbx, KdbxError};

use common::{
    build_conformance_bytes, fixture_bytes, fixture_dir, fixture_expected, FIXTURE_PASSWORD,
};

fn expected_json() -> String {
    let (items, _) = map_kdbx(&fixture_bytes(), Some(FIXTURE_PASSWORD), None, None).expect("map");
    let mut json = serde_json::to_string_pretty(&map::conformance_doc(&items)).expect("json");
    json.push('\n');
    json
}

#[test]
fn committed_fixture_maps_to_committed_expectation() {
    assert_eq!(
        expected_json(),
        fixture_expected(),
        "fixtures/kdbx/roundtrip.expected.json is stale — regenerate it with \
         `cargo +1.88.0 test -p opensesame-kdbx-bridge --test conformance -- \
         --ignored regenerate_fixture`"
    );
}

#[test]
fn committed_fixture_is_the_constrained_writer_profile() {
    let db = Database::parse(
        &fixture_bytes(),
        DatabaseKey::new().with_password(FIXTURE_PASSWORD),
    )
    .expect("open fixture");
    assert_eq!(db.config.version, DatabaseVersion::KDB4(1));
    assert_eq!(db.config.outer_cipher_config, OuterCipherConfig::AES256);
    assert_eq!(db.config.compression_config, CompressionConfig::GZip);
    assert_eq!(db.config.inner_cipher_config, InnerCipherConfig::ChaCha20);
    assert!(
        matches!(db.config.kdf_config, KdfConfig::Argon2id { .. }),
        "fixture must use Argon2id, got {:?}",
        db.config.kdf_config
    );
}

#[test]
fn committed_fixture_needs_the_documented_password() {
    let err = map_kdbx(&fixture_bytes(), Some("wrong password"), None, None).unwrap_err();
    assert!(matches!(err, KdbxError::Locked), "got {err:?}");
}

#[test]
fn committed_fixture_covers_every_mapped_field_type() {
    let (items, _) = map_kdbx(&fixture_bytes(), Some(FIXTURE_PASSWORD), None, None).expect("map");
    let by_path: std::collections::BTreeMap<&str, &opensesame_kdbx_bridge::MappedItem> =
        items.iter().map(|i| (i.path.as_str(), i)).collect();

    let mail = by_path["Personal/Email/Example Mail"];
    assert_eq!(mail.entry.secret, "fixture-password-one");
    assert!(mail.entry.trailer.contains("login: alice@example.com"));
    assert!(mail
        .entry
        .trailer
        .contains("url: https://mail.example.com/"));
    assert!(mail
        .entry
        .trailer
        .contains("notes: First line of the note."));
    assert!(mail.entry.trailer.contains("  Second line."));
    assert!(mail.entry.trailer.contains("Recovery Code: abcd-efgh-ijkl"));
    assert!(mail.entry.otp.is_some(), "entry 1 carries a TOTP");

    // The collision suffix.
    let dup = by_path["Personal/Email/Example Mail (2)"];
    assert_eq!(dup.entry.secret, "fixture-password-two");

    // KeePassXC TimeOtp-* attributes folded into one otpauth URI.
    let deploy = by_path["Shared/Ops/Deploy Token"];
    let otp = deploy.entry.otp.as_ref().expect("TimeOtp mapped");
    assert_eq!(otp.digits, 8);
    assert_eq!(otp.period, 60);
    assert!(!deploy.entry.trailer.contains("TimeOtp"));

    // Sanitized group and title.
    assert!(by_path.contains_key("Weird_Name/Tab_here"));

    // Password-less entry keeps an empty line one.
    let note = by_path["Root Note"];
    assert_eq!(note.entry.secret, "");
    assert!(note
        .entry
        .trailer
        .contains("notes: A note with no password"));

    assert_eq!(by_path.len(), 5);
}

/// Regenerate the committed fixture pair. Ignored by default: it rewrites
/// files in the working tree and the KDBX bytes differ every run (fresh
/// seeds, IVs and UUIDs), so it is a deliberate act, not a test.
#[test]
#[ignore = "rewrites fixtures/kdbx/; run deliberately"]
fn regenerate_fixture() {
    let dir = fixture_dir();
    std::fs::create_dir_all(&dir).expect("fixture dir");

    let bytes = build_conformance_bytes();
    std::fs::write(dir.join("roundtrip.kdbx"), &bytes).expect("write kdbx");

    let (items, warnings) = map_kdbx(&bytes, Some(FIXTURE_PASSWORD), None, None).expect("map");
    let mut json = serde_json::to_string_pretty(&map::conformance_doc(&items)).expect("json");
    json.push('\n');
    std::fs::write(dir.join("roundtrip.expected.json"), &json).expect("write json");

    eprintln!(
        "regenerated {} items, {} warnings into {}",
        items.len(),
        warnings.len(),
        dir.display()
    );
}
