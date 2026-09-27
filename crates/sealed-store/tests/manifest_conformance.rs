//! ADR 0139 drift test for the sealed-store bridge (ADR 0037 §6): the store
//! path manifest Pages saves (`spec/conformance/store-manifest.json`, pinned
//! on the TypeScript side by `store-manifest.conformance.test.ts`) is sealed
//! by the same code `opensesame pass seal` runs, and every entry comes back
//! exactly — path, secret, trailer, and an otpauth line as structured OTP —
//! whatever kind of item it holds: a login, a secret, a note, a card, a
//! certificate whose PEMs span lines, a passkey.

use opensesame_human_vault::ItemDataKey;
use opensesame_sealed_store::{init_store, parse_manifest, seal_manifest};
use serde_json::Value;

const FIXTURE: &str = include_str!("../../../spec/conformance/store-manifest.json");

/// The kind the trailer's JSON line names (the line that is not `otpauth://`).
fn trailer_kind(trailer: &str) -> Option<String> {
    let line = trailer
        .lines()
        .find(|line| line.trim_start().starts_with('{'))?;
    let meta: Value = serde_json::from_str(line).ok()?;
    meta["kind"].as_str().map(str::to_string)
}

fn fixture() -> Value {
    serde_json::from_str(FIXTURE).expect("store-manifest.json parses")
}

#[test]
fn pages_manifest_seals_entry_for_entry() {
    let fixture = fixture();
    let manifest = serde_json::to_string(&fixture["manifest"]).expect("manifest serializes");
    let entries = parse_manifest(&manifest).expect("the Pages manifest is a pass seal manifest");
    let sealed = fixture["sealed"].as_array().expect("sealed is an array");
    assert!(!entries.is_empty(), "the fixture holds entries");
    assert_eq!(entries.len(), sealed.len());

    let dir = tempfile::tempdir().expect("tempdir");
    let root = init_store(dir.path(), &[]).expect("init store");
    let key = ItemDataKey([7u8; 32]);
    let outcome = seal_manifest(&root, &key, &entries, false).expect("seal manifest");
    assert_eq!(outcome.sealed, entries.len());
    assert!(outcome.skipped.is_empty(), "{:?}", outcome.skipped);
    assert!(outcome.rejected.is_empty(), "{:?}", outcome.rejected);

    let mut names = root.ls("").expect("ls");
    names.sort();
    let mut expected: Vec<String> = sealed
        .iter()
        .map(|entry| entry["name"].as_str().expect("name").to_string())
        .collect();
    expected.sort();
    assert_eq!(names, expected);

    for (entry, expect) in entries.iter().zip(sealed) {
        let name = expect["name"].as_str().expect("name");
        let shown = root.show(name, &key).expect("show sealed entry");
        assert!(
            !entry.secret.contains(['\r', '\n']),
            "{name}: line one is one line"
        );
        assert_eq!(shown.secret, entry.secret, "{name}: secret");
        assert_eq!(shown.trailer, entry.trailer, "{name}: trailer");
        assert_eq!(
            trailer_kind(&shown.trailer).as_deref(),
            expect["kind"].as_str(),
            "{name}: kind"
        );
        // What `opensesame pass show` prints: line one, then the trailer.
        assert_eq!(
            shown.render(),
            format!("{}\n{}", entry.secret, entry.trailer),
            "{name}: pass show"
        );
        assert_eq!(
            shown.otp.is_some(),
            expect["otp"].as_bool().expect("otp flag"),
            "{name}: otp"
        );
    }
}

#[test]
fn sealing_the_same_manifest_twice_changes_nothing() {
    let manifest = serde_json::to_string(&fixture()["manifest"]).expect("manifest serializes");
    let entries = parse_manifest(&manifest).expect("parse");
    let dir = tempfile::tempdir().expect("tempdir");
    let root = init_store(dir.path(), &[]).expect("init store");
    let key = ItemDataKey([7u8; 32]);
    seal_manifest(&root, &key, &entries, false).expect("first seal");
    let again = seal_manifest(&root, &key, &entries, false).expect("second seal");
    assert_eq!(again.sealed, 0);
    assert_eq!(again.skipped.len(), entries.len());
}
