use super::*;

#[test]
fn keyless_age_writes_keep_their_format_and_obey_rotation_guards() {
    use age::secrecy::ExposeSecret;

    let dir = tempfile::tempdir().unwrap();
    let root = StoreRoot::open(dir.path()).unwrap();
    let identity = age::x25519::Identity::generate();
    fs::write(
        dir.path().join(".age-recipients"),
        identity.to_public().to_string(),
    )
    .unwrap();
    let entry = Entry::parse("age-secret\n");
    root.insert_or_replace_with_optional_key("entry", &entry, None)
        .unwrap();
    let original = fs::read(dir.path().join("entry.age")).unwrap();
    let identity_text = identity.to_string();
    assert_eq!(
        root.show_with_optional_key("entry", None, Some(identity_text.expose_secret()))
            .unwrap()
            .secret,
        "age-secret"
    );
    fs::create_dir(dir.path().join(crate::rotation::ROTATION_STAGING_DIR)).unwrap();
    assert!(root
        .insert_or_replace_with_optional_key("entry", &entry, None)
        .is_err());
    assert_eq!(fs::read(dir.path().join("entry.age")).unwrap(), original);
    fs::remove_dir(dir.path().join(crate::rotation::ROTATION_STAGING_DIR)).unwrap();
    assert!(root
        .insert_or_replace_with_optional_key(".GIT/entry", &entry, None)
        .is_err());
    fs::write(dir.path().join(".opensesame-recipients"), "").unwrap();
    root.insert_or_replace_with_optional_key("entry", &Entry::parse("updated\n"), None)
        .unwrap();
    assert_eq!(
        root.show_with_optional_key("entry", None, Some(identity_text.expose_secret()))
            .unwrap()
            .secret,
        "updated"
    );
    assert!(!dir.path().join("entry.osseal").exists());
    assert!(root
        .insert_or_replace_with_optional_key("new", &entry, None)
        .is_err());
    let before = fs::read(dir.path().join("entry.age")).unwrap();
    fs::write(
        dir.path().join(KEY_FILE),
        "a key file appeared after opening",
    )
    .unwrap();
    assert!(root
        .insert_or_replace_with_optional_key("entry", &entry, None)
        .is_err());
    assert_eq!(fs::read(dir.path().join("entry.age")).unwrap(), before);
}

#[test]
fn optional_native_key_preserves_age_but_refuses_native_shadow_entries() {
    use age::secrecy::ExposeSecret;

    let dir = tempfile::tempdir().unwrap();
    let root = init_store(dir.path(), &[]).unwrap();
    let identity = age::x25519::Identity::generate();
    age_fmt::encrypt_age_file(
        &dir.path().join("entry.age"),
        b"age-secret\n",
        &[identity.to_public().to_string()],
    )
    .unwrap();
    let identity_text = identity.to_string();
    let identity_text = Some(identity_text.expose_secret());
    assert_eq!(
        root.show_with_optional_key("entry", None, identity_text)
            .unwrap()
            .secret,
        "age-secret"
    );
    assert!(root.show_with_optional_key("entry", None, None).is_err());
    let blob = seal_osseal(b"injected\n", &ItemDataKey([0; 32]), "entry", 1).unwrap();
    fs::write(dir.path().join("entry.osseal"), blob).unwrap();
    assert!(matches!(
        root.show_with_optional_key("entry", None, identity_text),
        Err(StoreError::NotInitialized(_))
    ));
    assert!(!dir.path().join(REVISION_FILE).exists());
    fs::remove_file(dir.path().join("entry.osseal")).unwrap();
    assert_eq!(
        root.show_with_optional_key("entry", None, identity_text)
            .unwrap()
            .secret,
        "age-secret"
    );
}

#[test]
fn insert_show_ls_rm() {
    let dir = tempfile::tempdir().unwrap();
    let root = init_store(dir.path(), &[]).unwrap();
    let key = ItemDataKey([9u8; 32]);
    root.insert(
        "Dev/token",
        &Entry {
            secret: "abc".into(),
            trailer: String::new(),
            otp: None,
        },
        &key,
    )
    .unwrap();
    assert_eq!(root.show("Dev/token", &key).unwrap().secret, "abc");
    assert!(root.ls("Dev").unwrap().iter().any(|n| n.contains("token")));
    root.rm("Dev/token").unwrap();
    assert!(root.show("Dev/token", &key).is_err());
}

#[test]
fn dotted_names_keep_their_final_label() {
    let dir = tempfile::tempdir().unwrap();
    let root = init_store(dir.path(), &[]).unwrap();
    let key = ItemDataKey([4u8; 32]);
    for (name, secret) in [("Email/github.com", "a"), ("Email/github.org", "b")] {
        root.insert(
            name,
            &Entry {
                secret: secret.into(),
                trailer: String::new(),
                otp: None,
            },
            &key,
        )
        .unwrap();
    }
    // Distinct files — `.com` is part of the name, not an extension.
    assert!(dir.path().join("Email/github.com.osseal").exists());
    assert!(dir.path().join("Email/github.org.osseal").exists());
    assert_eq!(root.show("Email/github.com", &key).unwrap().secret, "a");
    assert_eq!(root.show("Email/github.org", &key).unwrap().secret, "b");
    let names = root.ls("Email").unwrap();
    assert!(names.contains(&"Email/github.com".to_string()));
    assert!(names.contains(&"Email/github.org".to_string()));
}

#[test]
fn passphrase_wrap_round_trip() {
    let dir = tempfile::tempdir().unwrap();
    let root = init_store(dir.path(), &["alice".into()]).unwrap();
    let key = init_store_key(dir.path(), b"correct horse").unwrap();
    root.insert(
        "x",
        &Entry {
            secret: "v".into(),
            trailer: String::new(),
            otp: None,
        },
        &key,
    )
    .unwrap();
    let unlocked = unlock_store_key(dir.path(), b"correct horse").unwrap();
    assert_eq!(root.show("x", &unlocked).unwrap().secret, "v");
    assert!(unlock_store_key(dir.path(), b"wrong").is_err());
}

#[test]
fn rejects_ciphertext_moved_to_another_entry() {
    let dir = tempfile::tempdir().unwrap();
    let root = init_store(dir.path(), &[]).unwrap();
    let key = ItemDataKey([5u8; 32]);
    for name in ["Dev/a", "Dev/b"] {
        root.insert(
            name,
            &Entry {
                secret: name.into(),
                trailer: String::new(),
                otp: None,
            },
            &key,
        )
        .unwrap();
    }
    fs::copy(
        dir.path().join("Dev/a.osseal"),
        dir.path().join("Dev/b.osseal"),
    )
    .unwrap();
    assert!(root.show("Dev/b", &key).is_err());
}

#[test]
fn rejects_an_older_revision() {
    let dir = tempfile::tempdir().unwrap();
    let root = init_store(dir.path(), &[]).unwrap();
    let key = ItemDataKey([6u8; 32]);
    let entry = |secret: &str| Entry {
        secret: secret.into(),
        trailer: String::new(),
        otp: None,
    };
    root.insert("Dev/a", &entry("one"), &key).unwrap();
    let old = fs::read(dir.path().join("Dev/a.osseal")).unwrap();
    root.insert_or_replace("Dev/a", &entry("two"), &key)
        .unwrap();
    fs::write(dir.path().join("Dev/a.osseal"), old).unwrap();
    assert!(root.show("Dev/a", &key).is_err());
}

#[cfg(unix)]
#[test]
fn refuses_intermediate_and_final_symlinks() {
    use std::os::unix::fs::symlink;

    let dir = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let root = init_store(dir.path(), &[]).unwrap();
    let key = ItemDataKey([7u8; 32]);
    let entry = Entry {
        secret: "never outside".into(),
        trailer: String::new(),
        otp: None,
    };

    symlink(outside.path(), dir.path().join("Dev")).unwrap();
    assert!(root.insert("Dev/token", &entry, &key).is_err());
    assert!(!outside.path().join("token.osseal").exists());

    fs::remove_file(dir.path().join("Dev")).unwrap();
    fs::create_dir(dir.path().join("Dev")).unwrap();
    symlink(
        outside.path().join("target"),
        dir.path().join("Dev/token.osseal"),
    )
    .unwrap();
    assert!(root.insert("Dev/token", &entry, &key).is_err());
    assert!(!outside.path().join("target").exists());
}

/// A backup remote carries the whole commit history. If a subject line
/// names the entry, the repository publishes the folder tree, the item
/// names, and how often each one changes — the exact metadata that made
/// stolen password-manager vaults triageable, sitting next to ciphertext
/// that never opened.
#[test]
fn commit_subjects_never_name_the_entry() {
    let dir = tempfile::tempdir().unwrap();
    let root = init_store(dir.path(), &[]).unwrap();
    crate::git::ensure_git_repo(dir.path()).unwrap();
    let key = ItemDataKey([9u8; 32]);

    // Distinctive enough that a substring hit cannot be a coincidence.
    let planted = "XZQPLANTED/api-token";
    let entry = |secret: &str| Entry {
        secret: secret.into(),
        trailer: String::new(),
        otp: None,
    };

    root.insert(planted, &entry("first"), &key).unwrap();
    root.insert_or_replace(planted, &entry("second"), &key)
        .unwrap();
    root.rm(planted).unwrap();

    let log = std::process::Command::new("git")
        .args(["log", "--format=%B"])
        .current_dir(dir.path())
        .output()
        .unwrap();
    let subjects = String::from_utf8(log.stdout).unwrap();

    assert!(
        !subjects.contains("XZQPLANTED"),
        "entry name leaked into commit history: {subjects}"
    );
    assert!(
        !subjects.contains("api-token"),
        "entry name leaked into commit history: {subjects}"
    );
    // The operation is still legible without naming the target.
    assert!(subjects.contains(COMMIT_ADD));
    assert!(subjects.contains(COMMIT_EDIT));
    assert!(subjects.contains(COMMIT_REMOVE));

    // Restore writes its own subject from history.rs; it must stay
    // name-free too, or the leak returns through a different verb.
    assert_eq!(COMMIT_RESTORE, "seal: restore entry");
}
