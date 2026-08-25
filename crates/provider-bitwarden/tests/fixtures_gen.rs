//! Recorded API fixtures: generation and drift detection.
//!
//! `tests/fixtures/{cloud,vaultwarden}/*.json` are **self-generated** (C9 and
//! C3: no third-party test data is vendored) from the deterministic account
//! material in `common`. They are committed so the API-layer tests replay a
//! fixed wire format rather than whatever the code happens to emit today.
//!
//! `committed_fixtures_match_the_generator` is the guard: if the `EncString`
//! wire form, the KDF composition, or the fixture account material changes,
//! the committed JSON stops matching and the diff has to be looked at.

mod common;

use common::{build_fixtures, fixture_dir, Shape};
use serde_json::Value;

const SHAPES: [Shape; 2] = [Shape::Cloud, Shape::Vaultwarden];

#[test]
fn committed_fixtures_match_the_generator() {
    for shape in SHAPES {
        for (name, expected) in build_fixtures(shape) {
            let path = fixture_dir(shape).join(name);
            let raw = std::fs::read_to_string(&path)
                .unwrap_or_else(|e| panic!("missing fixture {}: {e}", path.display()));
            let committed: Value =
                serde_json::from_str(&raw).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
            assert_eq!(
                committed,
                expected,
                "{} drifted — regenerate deliberately with `--ignored regenerate_fixtures`",
                path.display()
            );
        }
    }
}

#[test]
fn fixtures_cover_both_server_topologies_and_both_kdfs() {
    let cloud = build_fixtures(Shape::Cloud);
    let vaultwarden = build_fixtures(Shape::Vaultwarden);
    // Cloud speaks PascalCase and PBKDF2 and hands the key back on the token.
    assert_eq!(cloud["prelogin.json"]["Kdf"], 0);
    assert!(cloud["token.json"]["Key"].is_string());
    assert!(cloud["sync.json"]["Ciphers"].is_array());
    // Vaultwarden speaks camelCase and Argon2id and only exposes the key on
    // the sync profile, so both user-key acquisition paths are exercised.
    assert_eq!(vaultwarden["prelogin.json"]["kdf"], 1);
    assert!(vaultwarden["prelogin.json"]["kdfMemory"].is_number());
    assert!(vaultwarden["token.json"].get("Key").is_none());
    assert!(vaultwarden["sync.json"]["profile"]["key"].is_string());
}

#[test]
#[ignore = "regenerates tests/fixtures/**; run after an intentional wire-format change"]
fn regenerate_fixtures() {
    for shape in SHAPES {
        let dir = fixture_dir(shape);
        std::fs::create_dir_all(&dir).expect("create fixture dir");
        for (name, value) in build_fixtures(shape) {
            let path = dir.join(name);
            std::fs::write(
                &path,
                format!(
                    "{}\n",
                    serde_json::to_string_pretty(&value).expect("serialize")
                ),
            )
            .expect("write fixture");
            eprintln!("wrote {}", path.display());
        }
    }
}
