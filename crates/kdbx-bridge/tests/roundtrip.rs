//! Store → KDBX → store round-trips, and the import merge semantics.

mod common;

use std::collections::BTreeMap;

use opensesame_kdbx_bridge::{
    export_kdbx, import_kdbx, Argon2Params, ExportCipher, ExportOptions, ImportOptions, KdbxError,
};

use common::{put, store_state, temp_store, TempStore, RFC_SEED};

const PASSWORD: &str = "round-trip password";

fn fast(opts: ExportOptions) -> ExportOptions {
    opts.with_argon2(Argon2Params::weak_for_tests())
}

/// A store holding one entry of every mapped shape.
fn populated() -> TempStore {
    let store = temp_store();
    put(
        &store,
        "Personal/Email/GitHub",
        "gh-fixture-password",
        &format!(
            "login: alice\nurl: https://github.com\nnotes: first\n  second\n  \n  fourth\n\
             Recovery Code: abcd\notpauth://totp/GitHub?secret={RFC_SEED}&digits=6&period=30&algorithm=SHA1\n"
        ),
    );
    put(
        &store,
        "Personal/Email/GitLab",
        "gl-fixture-password",
        "login: bob\n",
    );
    put(&store, "Toplevel", "top-fixture-password", "");
    put(
        &store,
        "Shared/Ops/Deploy",
        "deploy-fixture-password",
        // Canonical trailer order: reserved keys first, then custom fields
        // sorted by name. A round trip normalizes to this order, so a source
        // store written this way compares byte-for-byte.
        "notes: ops\nAPI Key: fixture-api-key\n",
    );
    store
}

type State = BTreeMap<String, opensesame_kdbx_bridge::map::ItemJson>;

fn round_trip(
    export_opts: ExportOptions,
    password: &str,
    keyfile: Option<&[u8]>,
) -> (State, State) {
    let source = populated();
    let bytes =
        export_kdbx(&source.root, &source.key, None, password, export_opts).expect("export");

    let target = temp_store();
    let summary = import_kdbx(
        &bytes,
        Some(password),
        keyfile,
        &target.root,
        &target.key,
        ImportOptions::default(),
    )
    .expect("import");
    assert_eq!(summary.skipped, Vec::new(), "nothing should be skipped");

    (
        store_state(&source.root, &source.key),
        store_state(&target.root, &target.key),
    )
}

#[test]
fn export_then_import_preserves_store_state_password_only() {
    let (before, after) = round_trip(fast(ExportOptions::default()), PASSWORD, None);
    assert_eq!(before, after);
    assert_eq!(before.len(), 4);
}

#[test]
fn export_then_import_preserves_store_state_with_chacha20() {
    let (before, after) = round_trip(
        fast(ExportOptions::default().with_cipher(ExportCipher::ChaCha20)),
        PASSWORD,
        None,
    );
    assert_eq!(before, after);
}

#[test]
fn export_then_import_preserves_store_state_password_and_keyfile() {
    let keyfile = b"opensesame-kdbx-test-keyfile".to_vec();
    let (before, after) = round_trip(
        fast(ExportOptions::default().with_keyfile(keyfile.clone())),
        PASSWORD,
        Some(&keyfile),
    );
    assert_eq!(before, after);
}

#[test]
fn export_then_import_preserves_store_state_keyfile_only() {
    // Keyfile-only: the KDBX composite key has a keyfile component and an
    // empty password component. `keepass` always hashes a supplied password,
    // so both sides must agree to supply an empty one.
    let keyfile = b"opensesame-kdbx-keyfile-only".to_vec();
    let source = populated();
    let bytes = export_kdbx(
        &source.root,
        &source.key,
        None,
        "",
        fast(ExportOptions::default().with_keyfile(keyfile.clone())),
    )
    .expect("export");

    let target = temp_store();
    import_kdbx(
        &bytes,
        Some(""),
        Some(&keyfile),
        &target.root,
        &target.key,
        ImportOptions::default(),
    )
    .expect("import");

    assert_eq!(
        store_state(&source.root, &source.key),
        store_state(&target.root, &target.key)
    );
}

#[test]
fn export_refuses_when_neither_password_nor_keyfile_is_supplied() {
    let store = populated();
    let err = export_kdbx(
        &store.root,
        &store.key,
        None,
        "",
        fast(ExportOptions::default()),
    )
    .unwrap_err();
    assert!(matches!(err, KdbxError::MissingCredentials), "got {err:?}");
}

#[test]
fn import_refuses_when_neither_password_nor_keyfile_is_supplied() {
    let store = populated();
    let bytes = export_kdbx(
        &store.root,
        &store.key,
        None,
        PASSWORD,
        fast(ExportOptions::default()),
    )
    .expect("export");
    let target = temp_store();
    let err = import_kdbx(
        &bytes,
        None,
        None,
        &target.root,
        &target.key,
        ImportOptions::default(),
    )
    .unwrap_err();
    assert!(matches!(err, KdbxError::MissingCredentials), "got {err:?}");
}

#[test]
fn import_with_the_wrong_password_reports_locked() {
    let store = populated();
    let bytes = export_kdbx(
        &store.root,
        &store.key,
        None,
        PASSWORD,
        fast(ExportOptions::default()),
    )
    .expect("export");
    let target = temp_store();
    let err = import_kdbx(
        &bytes,
        Some("not the password"),
        None,
        &target.root,
        &target.key,
        ImportOptions::default(),
    )
    .unwrap_err();
    assert!(matches!(err, KdbxError::Locked), "got {err:?}");
    assert!(store_state(&target.root, &target.key).is_empty());
}

#[test]
fn import_is_idempotent() {
    let source = populated();
    let bytes = export_kdbx(
        &source.root,
        &source.key,
        None,
        PASSWORD,
        fast(ExportOptions::default()),
    )
    .expect("export");

    let target = temp_store();
    let first = import_kdbx(
        &bytes,
        Some(PASSWORD),
        None,
        &target.root,
        &target.key,
        ImportOptions::default(),
    )
    .expect("first import");
    assert_eq!(first.created.len(), 4);
    assert!(first.unchanged.is_empty());
    let after_first = store_state(&target.root, &target.key);

    let second = import_kdbx(
        &bytes,
        Some(PASSWORD),
        None,
        &target.root,
        &target.key,
        ImportOptions::default(),
    )
    .expect("second import");
    assert!(second.created.is_empty(), "re-import must create nothing");
    assert!(second.updated.is_empty(), "re-import must update nothing");
    assert_eq!(second.unchanged.len(), 4);
    assert!(!second.changed());
    assert_eq!(after_first, store_state(&target.root, &target.key));
}

#[test]
fn import_skips_conflicts_unless_replacing() {
    let source = populated();
    let bytes = export_kdbx(
        &source.root,
        &source.key,
        None,
        PASSWORD,
        fast(ExportOptions::default()),
    )
    .expect("export");

    let target = temp_store();
    put(&target, "Toplevel", "a-different-secret", "");

    let skipped = import_kdbx(
        &bytes,
        Some(PASSWORD),
        None,
        &target.root,
        &target.key,
        ImportOptions::default(),
    )
    .expect("import");
    assert_eq!(skipped.skipped.len(), 1);
    assert_eq!(skipped.skipped[0].path, "Toplevel");
    assert_eq!(
        target.root.show("Toplevel", &target.key).unwrap().secret,
        "a-different-secret"
    );

    let replaced = import_kdbx(
        &bytes,
        Some(PASSWORD),
        None,
        &target.root,
        &target.key,
        ImportOptions::default().replacing(),
    )
    .expect("import");
    assert_eq!(replaced.updated, vec!["Toplevel".to_string()]);
    assert_eq!(
        target.root.show("Toplevel", &target.key).unwrap().secret,
        "top-fixture-password"
    );
}

#[test]
fn import_prefix_nests_every_entry() {
    let source = populated();
    let bytes = export_kdbx(
        &source.root,
        &source.key,
        None,
        PASSWORD,
        fast(ExportOptions::default()),
    )
    .expect("export");

    let target = temp_store();
    import_kdbx(
        &bytes,
        Some(PASSWORD),
        None,
        &target.root,
        &target.key,
        ImportOptions::default().with_prefix("Imported/KeePass"),
    )
    .expect("import");

    let names = target.root.ls("").expect("ls");
    assert!(!names.is_empty());
    assert!(
        names.iter().all(|n| n.starts_with("Imported/KeePass/")),
        "{names:?}"
    );
}

#[test]
fn export_prefix_selects_a_subtree() {
    let source = populated();
    let bytes = export_kdbx(
        &source.root,
        &source.key,
        Some("Personal"),
        PASSWORD,
        fast(ExportOptions::default()),
    )
    .expect("export");

    let target = temp_store();
    import_kdbx(
        &bytes,
        Some(PASSWORD),
        None,
        &target.root,
        &target.key,
        ImportOptions::default(),
    )
    .expect("import");

    assert_eq!(
        target.root.ls("").expect("ls"),
        vec![
            "Personal/Email/GitHub".to_string(),
            "Personal/Email/GitLab".to_string()
        ]
    );
}

#[test]
fn exporting_an_empty_store_produces_a_readable_empty_database() {
    let store = temp_store();
    let bytes = export_kdbx(
        &store.root,
        &store.key,
        None,
        PASSWORD,
        fast(ExportOptions::default()),
    )
    .expect("export");

    let target = temp_store();
    let summary = import_kdbx(
        &bytes,
        Some(PASSWORD),
        None,
        &target.root,
        &target.key,
        ImportOptions::default(),
    )
    .expect("import");
    assert_eq!(summary.total(), 0);
    assert!(store_state(&target.root, &target.key).is_empty());
}

#[test]
fn round_trip_preserves_totp_and_custom_fields_exactly() {
    let source = populated();
    let bytes = export_kdbx(
        &source.root,
        &source.key,
        None,
        PASSWORD,
        fast(ExportOptions::default()),
    )
    .expect("export");

    let target = temp_store();
    import_kdbx(
        &bytes,
        Some(PASSWORD),
        None,
        &target.root,
        &target.key,
        ImportOptions::default(),
    )
    .expect("import");

    let entry = target
        .root
        .show("Personal/Email/GitHub", &target.key)
        .expect("show");
    let otp = entry.otp.as_ref().expect("totp survived");
    assert!(otp.uri.contains(RFC_SEED));
    assert!(entry.trailer.contains("Recovery Code: abcd"));
    assert!(entry.trailer.contains("notes: first"));
    assert!(entry.trailer.contains("  second"));
    assert!(entry.trailer.contains("  fourth"));

    let deploy = target
        .root
        .show("Shared/Ops/Deploy", &target.key)
        .expect("show");
    assert!(deploy.trailer.contains("API Key: fixture-api-key"));
}

#[test]
fn a_second_export_of_an_imported_store_is_stable() {
    let source = populated();
    let first = export_kdbx(
        &source.root,
        &source.key,
        None,
        PASSWORD,
        fast(ExportOptions::default()),
    )
    .expect("export");

    let middle = temp_store();
    import_kdbx(
        &first,
        Some(PASSWORD),
        None,
        &middle.root,
        &middle.key,
        ImportOptions::default(),
    )
    .expect("import");

    let second = export_kdbx(
        &middle.root,
        &middle.key,
        None,
        PASSWORD,
        fast(ExportOptions::default()),
    )
    .expect("re-export");

    let last = temp_store();
    import_kdbx(
        &second,
        Some(PASSWORD),
        None,
        &last.root,
        &last.key,
        ImportOptions::default(),
    )
    .expect("re-import");

    assert_eq!(
        store_state(&middle.root, &middle.key),
        store_state(&last.root, &last.key)
    );
}

#[test]
fn a_password_less_entry_is_idempotent_too() {
    // Regression: an entry with an empty line one used to be reported as a
    // conflict on re-import, because `sealed_store::Entry`'s render/parse pair
    // promotes the first trailer line into the secret when line one is empty.
    let store = temp_store();
    put(&store, "Notes/No Password", "", "notes: just a note\n");
    let bytes = export_kdbx(
        &store.root,
        &store.key,
        None,
        PASSWORD,
        fast(ExportOptions::default()),
    )
    .expect("export");

    let target = temp_store();
    for pass in 1..=3 {
        let summary = import_kdbx(
            &bytes,
            Some(PASSWORD),
            None,
            &target.root,
            &target.key,
            ImportOptions::default(),
        )
        .expect("import");
        assert!(summary.skipped.is_empty(), "pass {pass}: {summary:?}");
        if pass > 1 {
            assert!(!summary.changed(), "pass {pass} changed the store");
        }
    }

    let entry = target
        .root
        .show("Notes/No Password", &target.key)
        .expect("show");
    assert_eq!(entry.secret, "");
    assert!(entry.trailer.contains("notes: just a note"));
}
