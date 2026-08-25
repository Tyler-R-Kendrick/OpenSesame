//! Shared test scaffolding: temp stores and the conformance-fixture builder.
//!
//! Every value here is synthetic. The "secrets" are fixture strings and the
//! TOTP seed is the RFC 6238 Appendix B test vector.

#![allow(dead_code)]

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use keepass::config::{
    CompressionConfig, DatabaseConfig, DatabaseVersion, InnerCipherConfig, KdfConfig,
    OuterCipherConfig,
};
use keepass::db::{Database, GroupId};
use keepass::DatabaseKey;
use opensesame_sealed_store::{init_store, Entry, ItemDataKey, StoreRoot};
use tempfile::TempDir;

/// Password the committed conformance fixture is sealed with.
pub const FIXTURE_PASSWORD: &str = "correct horse battery staple";

/// RFC 6238 Appendix B seed (`"12345678901234567890"`) in base32.
pub const RFC_SEED: &str = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"; // gitleaks:allow -- RFC fixture

/// A store on a temp dir, plus the item key its entries are sealed under.
pub struct TempStore {
    /// Kept alive so the directory outlives the store.
    pub dir: TempDir,
    /// The opened store.
    pub root: StoreRoot,
    /// Item data key. Built directly rather than through `init_store_key` so
    /// tests do not pay for a 64 MiB Argon2id pass each.
    pub key: ItemDataKey,
}

/// A fresh, empty store.
pub fn temp_store() -> TempStore {
    let dir = tempfile::tempdir().expect("tempdir");
    let root = init_store(dir.path(), &[]).expect("init store");
    TempStore {
        dir,
        root,
        key: ItemDataKey([7u8; 32]),
    }
}

/// Every entry in a store, in canonical form.
///
/// `map::item_json` rather than `Entry::render`: `sealed_store::Entry`'s
/// render/parse pair is not a fixed point — parsing a rendered entry keeps the
/// blank separator line inside the trailer, and rendering that again drops it —
/// so raw rendered text differs between an entry's first and second write
/// generation even when nothing changed. The canonical view compares what the
/// entry *means*.
pub fn store_state(
    root: &StoreRoot,
    key: &ItemDataKey,
) -> BTreeMap<String, opensesame_kdbx_bridge::map::ItemJson> {
    root.ls("")
        .expect("ls")
        .into_iter()
        .map(|name| {
            let entry = root.show(&name, key).expect("show");
            (name, opensesame_kdbx_bridge::map::item_json(&entry))
        })
        .collect()
}

/// Insert an entry, replacing whatever is there.
///
/// The body is assembled and re-parsed so an `otpauth://` trailer line is
/// picked up as the entry's structured OTP, exactly as the CLI's insert path
/// does.
pub fn put(store: &TempStore, path: &str, secret: &str, trailer: &str) {
    let text = if trailer.is_empty() {
        format!("{secret}\n")
    } else {
        format!("{secret}\n\n{trailer}")
    };
    let entry = Entry::parse(&text);
    store
        .root
        .insert_or_replace(path, &entry, &store.key)
        .expect("insert");
}

/// Repository root, resolved from this crate's manifest directory.
pub fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("repo root")
}

/// Directory holding the committed conformance fixtures.
pub fn fixture_dir() -> PathBuf {
    repo_root().join("fixtures/kdbx")
}

/// The committed conformance database.
pub fn fixture_bytes() -> Vec<u8> {
    std::fs::read(fixture_dir().join("roundtrip.kdbx")).expect("fixtures/kdbx/roundtrip.kdbx")
}

/// The committed expected mapping.
pub fn fixture_expected() -> String {
    std::fs::read_to_string(fixture_dir().join("roundtrip.expected.json"))
        .expect("fixtures/kdbx/roundtrip.expected.json")
}

/// Argon2id work factors used for the committed fixture.
///
/// Reduced from the export default so the fixture opens quickly in the Rust,
/// the TypeScript (`kdbxweb` + `hash-wasm`), and any future test suite. Real
/// exports use [`opensesame_kdbx_bridge::Argon2Params::default`].
pub const FIXTURE_ARGON2_MEMORY_KIB: u64 = 16 * 1024;
/// Passes for the committed fixture.
pub const FIXTURE_ARGON2_ITERATIONS: u64 = 2;
/// Lanes for the committed fixture.
pub const FIXTURE_ARGON2_PARALLELISM: u32 = 4;

/// The constrained writer profile, rebuilt here independently of
/// `export::database_config` so the conformance test has a second opinion on
/// what "`KDBX 4.1` / `AES-256` / `ChaCha20` inner / `GZip` / `Argon2id`"
/// means.
pub fn fixture_config() -> DatabaseConfig {
    config_with(
        FIXTURE_ARGON2_ITERATIONS,
        FIXTURE_ARGON2_MEMORY_KIB,
        FIXTURE_ARGON2_PARALLELISM,
    )
}

/// The same profile with a deliberately cheap KDF, for tests that build or
/// open many databases and are not asserting anything about work factors.
pub fn weak_config() -> DatabaseConfig {
    config_with(1, 64, 1)
}

fn config_with(iterations: u64, memory_kib: u64, parallelism: u32) -> DatabaseConfig {
    let argon2_version = match DatabaseConfig::default().kdf_config {
        KdfConfig::Argon2 { version, .. } | KdfConfig::Argon2id { version, .. } => version,
        other => panic!("keepass no longer defaults to Argon2: {other:?}"),
    };
    #[allow(clippy::field_reassign_with_default)]
    let mut config = DatabaseConfig::default();
    config.version = DatabaseVersion::KDB4(1);
    config.outer_cipher_config = OuterCipherConfig::AES256;
    config.compression_config = CompressionConfig::GZip;
    config.inner_cipher_config = InnerCipherConfig::ChaCha20;
    config.kdf_config = KdfConfig::Argon2id {
        iterations,
        memory: memory_kib * 1024,
        parallelism,
        version: argon2_version,
    };
    config
}

fn add_group(db: &mut Database, parent: GroupId, name: &str) -> GroupId {
    let mut parent_group = db.group_mut(parent).expect("parent group");
    let mut child = parent_group.add_group();
    child.name = name.to_string();
    child.id()
}

fn add_entry(db: &mut Database, parent: GroupId, fields: &[(&str, &str, bool)]) {
    let mut parent_group = db.group_mut(parent).expect("parent group");
    let mut entry = parent_group.add_entry();
    for (key, value, protected) in fields {
        if *protected {
            entry.set_protected(*key, *value);
        } else {
            entry.set_unprotected(*key, *value);
        }
    }
}

/// Build the conformance database in memory.
///
/// Written against `keepass` directly rather than through `export_kdbx`, so
/// the fixture exercises KDBX shapes the exporter cannot produce: `KeePassXC`
/// `TimeOtp-*` attributes, two entries with the same title in one group, and
/// group/title names that need sanitizing.
pub fn build_conformance_db() -> Database {
    build_conformance_db_with(fixture_config())
}

/// [`build_conformance_db`] with an explicit writer configuration.
pub fn build_conformance_db_with(config: DatabaseConfig) -> Database {
    let mut db = Database::with_config(config);
    db.root_mut().name = "OpenSesame Conformance".to_string();
    let root = db.root().id();

    let personal = add_group(&mut db, root, "Personal");
    let email = add_group(&mut db, personal, "Email");
    let shared = add_group(&mut db, root, "Shared");
    let ops = add_group(&mut db, shared, "Ops");
    let weird = add_group(&mut db, root, "Weird/Name");

    // 1. Every mapped field type, TOTP carried as a full otpauth URI.
    add_entry(
        &mut db,
        email,
        &[
            ("Title", "Example Mail", false),
            ("UserName", "alice@example.com", false),
            ("Password", "fixture-password-one", true),
            ("URL", "https://mail.example.com/", false),
            (
                "Notes",
                "First line of the note.\nSecond line.\n\nFourth line, after a blank one.",
                false,
            ),
            ("Recovery Code", "abcd-efgh-ijkl", false),
            (
                "otp",
                &format!("otpauth://totp/Example%20Mail?secret={RFC_SEED}&issuer=Example&digits=6&period=30&algorithm=SHA1"),
                true,
            ),
        ],
    );

    // 2. Same title, same group: exercises the ` (2)` collision suffix.
    add_entry(
        &mut db,
        email,
        &[
            ("Title", "Example Mail", false),
            ("UserName", "bob@example.com", false),
            ("Password", "fixture-password-two", true),
        ],
    );

    // 3. KeePassXC TimeOtp attributes + a field that exports protected.
    add_entry(
        &mut db,
        ops,
        &[
            ("Title", "Deploy Token", false),
            ("Password", "fixture-deploy-token", true),
            ("API Key", "fixture-api-key", true),
            ("TimeOtp-Secret-Base32", RFC_SEED, true),
            ("TimeOtp-Length", "8", false),
            ("TimeOtp-Period", "60", false),
            ("TimeOtp-Algorithm", "HMAC-SHA-256", false),
        ],
    );

    // 4. Hostile group and title names: sanitization.
    add_entry(
        &mut db,
        weird,
        &[
            ("Title", "Tab\there", false),
            ("Password", "fixture-weird", true),
        ],
    );

    // 5. Root-level, no password: line one stays empty.
    add_entry(
        &mut db,
        root,
        &[
            ("Title", "Root Note", false),
            ("Notes", "A note with no password at all.", false),
        ],
    );

    db
}

/// Serialize the conformance database with [`FIXTURE_PASSWORD`].
pub fn build_conformance_bytes() -> Vec<u8> {
    save(&build_conformance_db())
}

/// The same content sealed with [`weak_config`], for tests that open many
/// databases and do not assert on work factors.
pub fn build_weak_bytes() -> Vec<u8> {
    save(&build_conformance_db_with(weak_config()))
}

fn save(db: &Database) -> Vec<u8> {
    let mut out = Vec::new();
    db.save(&mut out, DatabaseKey::new().with_password(FIXTURE_PASSWORD))
        .expect("save fixture");
    out
}
