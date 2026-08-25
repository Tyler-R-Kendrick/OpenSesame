//! Deterministic fixtures shared by unit tests and the golden protocol tests
//! under `tests/`.
//!
//! This module exists because integration tests cannot reach `#[cfg(test)]`
//! items. It builds **fixture** stores only — it never reads a real profile,
//! never touches the network, and holds no production logic.

use std::path::Path;

use opensesame_sealed_store::{init_store, init_store_key, Entry, StoreRoot};

/// Passphrase every fixture store is sealed under.
pub const FIXTURE_PASSPHRASE: &[u8] = b"correct horse";

/// RFC 6238 test key, base32-encoded — a published vector, not a credential.
pub const FIXTURE_OTPAUTH: &str =
    "otpauth://totp/Example:alice?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Example";

/// Create a two-entry sealed store at `root`:
///
/// - `Web/example.com` — secret + `login:`/`url:` trailer + TOTP.
/// - `Dev/github` — secret only, reachable solely by the name heuristic.
///
/// # Panics
///
/// Panics when the deterministic fixture store cannot be initialized.
pub fn init_store_fixture(root: &Path) {
    init_store(root, &[]).expect("init store");
    let key = init_store_key(root, FIXTURE_PASSPHRASE).expect("init key");
    let store = StoreRoot::open(root).expect("open store");

    store
        .insert(
            "Web/example.com",
            &Entry {
                secret: "hunter2".into(),
                trailer: format!(
                    "login: alice\nurl: https://example.com/login\n{FIXTURE_OTPAUTH}\n"
                ),
                otp: None,
            }
            .with_otp(opensesame_sealed_store::parse_otpauth(FIXTURE_OTPAUTH).ok()),
            &key,
        )
        .expect("insert web entry");

    store
        .insert(
            "Dev/github",
            &Entry {
                secret: "ghp-fixture-token".into(),
                trailer: String::new(),
                otp: None,
            },
            &key,
        )
        .expect("insert dev entry");
}
