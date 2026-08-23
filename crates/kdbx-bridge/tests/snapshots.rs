//! Characterization snapshots.
//!
//! The mapping *is* the contract another implementation builds against, so it
//! is pinned exactly rather than re-argued. Snapshots are reviewed with
//! `cargo insta review` and the `.snap` files are committed.
//!
//! Everything snapshotted here is deterministic by construction: the mapping
//! is a pure function, the fixture is a committed artifact, and store paths
//! are the only identifiers involved. No timestamps, nonces or UUIDs reach a
//! snapshot, so no redactions are needed — the one nondeterministic input,
//! the temp-store directory, never appears in a mapped value.

mod common;

use std::collections::BTreeMap;

use opensesame_kdbx_bridge::{
    export_kdbx, import_kdbx, map, map_kdbx, Argon2Params, ExportOptions, ImportOptions,
};

use common::{fixture_bytes, put, temp_store, FIXTURE_PASSWORD, RFC_SEED};

#[test]
fn fixture_mapping_is_pinned() {
    let (items, _) = map_kdbx(&fixture_bytes(), Some(FIXTURE_PASSWORD), None, None).expect("map");
    insta::assert_json_snapshot!(map::conformance_doc(&items));
}

#[test]
fn fixture_mapping_warnings_are_pinned() {
    let (_, warnings) =
        map_kdbx(&fixture_bytes(), Some(FIXTURE_PASSWORD), None, None).expect("map");
    insta::assert_json_snapshot!(warnings);
}

#[test]
fn fixture_mapping_under_a_prefix_is_pinned() {
    let (items, _) = map_kdbx(
        &fixture_bytes(),
        Some(FIXTURE_PASSWORD),
        None,
        Some("Imported/KeePass"),
    )
    .expect("map");
    let paths: Vec<&str> = items.iter().map(|i| i.path.as_str()).collect();
    insta::assert_json_snapshot!(paths);
}

#[test]
fn trailer_rendering_is_pinned() {
    let cases: BTreeMap<&str, String> = [
        (
            "reserved keys only",
            render(&[("login", "alice"), ("url", "https://x"), ("notes", "n")]),
        ),
        (
            "multi-line value",
            render(&[("notes", "one\ntwo\n\nfour")]),
        ),
        (
            "value whose lines are already indented",
            render(&[("notes", "  two spaces\n    four spaces")]),
        ),
        (
            "value containing a colon",
            render(&[("Custom", "key: value")]),
        ),
        ("empty value", render(&[("Custom", "")])),
    ]
    .into_iter()
    .collect();
    insta::assert_json_snapshot!(cases);
}

fn render(pairs: &[(&str, &str)]) -> String {
    map::render_trailer(
        &pairs
            .iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
            .collect::<Vec<_>>(),
    )
}

#[test]
fn import_summary_shape_is_pinned() {
    let store = temp_store();
    let first = import_kdbx(
        &fixture_bytes(),
        Some(FIXTURE_PASSWORD),
        None,
        &store.root,
        &store.key,
        ImportOptions::default(),
    )
    .expect("first import");
    let second = import_kdbx(
        &fixture_bytes(),
        Some(FIXTURE_PASSWORD),
        None,
        &store.root,
        &store.key,
        ImportOptions::default(),
    )
    .expect("second import");
    insta::assert_json_snapshot!(serde_json::json!({
        "first": first,
        "second_is_a_no_op": second,
    }));
}

#[test]
fn exported_kdbx_field_layout_is_pinned() {
    let store = temp_store();
    put(
        &store,
        "Personal/Email/GitHub",
        "fixture-password",
        &format!(
            "login: alice\nurl: https://github.com\nnotes: one\n  two\n\
             API Key: fixture-api-key\nComment: not secret\n\
             otpauth://totp/GitHub?secret={RFC_SEED}&digits=6&period=30&algorithm=SHA1\n"
        ),
    );
    let entry = store
        .root
        .show("Personal/Email/GitHub", &store.key)
        .expect("show");
    let unmapped = map::unmap_entry("Personal/Email/GitHub", &entry);
    insta::assert_json_snapshot!(serde_json::json!({
        "group_path": unmapped.group_path,
        "title": unmapped.title,
        "fields": unmapped
            .fields
            .iter()
            .map(|f| serde_json::json!({
                "key": f.key,
                "value": f.value,
                "protected": f.protected,
            }))
            .collect::<Vec<_>>(),
    }));
}

#[test]
fn exported_then_reimported_mapping_matches_the_source_store() {
    let store = temp_store();
    put(
        &store,
        "Personal/Email/GitHub",
        "fixture-password",
        "login: alice\nAPI Key: fixture-api-key\n",
    );
    let bytes = export_kdbx(
        &store.root,
        &store.key,
        None,
        "export password",
        ExportOptions::default().with_argon2(Argon2Params::weak_for_tests()),
    )
    .expect("export");
    let (items, _) = map_kdbx(&bytes, Some("export password"), None, None).expect("map");
    insta::assert_json_snapshot!(map::conformance_doc(&items));
}
