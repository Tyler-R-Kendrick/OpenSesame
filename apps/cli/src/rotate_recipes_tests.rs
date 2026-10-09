//! The local half of `rotate recipe` and `rotate signer`: key files that are
//! secrets, signing that names no Host, and what a signature may say.

use std::path::{Path, PathBuf};

use chrono::{Duration, Utc};
use opensesame_rotation_web::recipe_doc::{parse_public_key_hex, RecipeDocument};
use serde_json::{json, Value};

use super::sign::{self, SignOptions};

fn recipe_file(dir: &Path, edit: impl FnOnce(&mut Value)) -> PathBuf {
    let mut document = json!({
        "schema_version": 1,
        "recipe_id": "rcp_unit",
        "origin": "https://unit.example",
        "expires_at": (Utc::now() + Duration::days(10)).to_rfc3339(),
        "change_password": {
            "change_url": "https://unit.example/password",
            "new_password_selector": "#new",
            "submit_selector": "#save"
        }
    });
    edit(&mut document);
    let path = dir.join("recipe.json");
    std::fs::write(&path, document.to_string()).unwrap();
    path
}

fn key_file(dir: &Path) -> (PathBuf, Value) {
    let path = dir.join("signer.key");
    let made = sign::keygen(&path).unwrap();
    (path, made)
}

#[test]
fn keygen_makes_a_private_file_and_prints_only_the_public_half() {
    let dir = tempfile::tempdir().unwrap();
    let (path, made) = key_file(dir.path());
    let seed = std::fs::read_to_string(&path).unwrap();
    assert_eq!(seed.trim().len(), 64);
    let printed = made.to_string();
    assert!(
        !printed.contains(seed.trim()),
        "the private key is never printed"
    );
    assert!(made["key_id"].as_str().unwrap().starts_with("rsk_"));
    let public = parse_public_key_hex(made["public_key"].as_str().unwrap()).unwrap();
    let (key_id, public_hex) = sign::public_half(&path).unwrap();
    assert_eq!(made["key_id"], key_id);
    assert_eq!(made["public_key"], public_hex);
    assert_eq!(hex::encode(public.as_bytes()), public_hex);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let perms = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(perms & 0o777, 0o600);
    }
    // Never overwritten: a key lost to a second `keygen` is a signer lost.
    assert!(sign::keygen(&path).is_err());
    assert_eq!(std::fs::read_to_string(&path).unwrap(), seed);
    // And two keys are two keys.
    let other = sign::keygen(&dir.path().join("other.key")).unwrap();
    assert_ne!(other["public_key"], made["public_key"]);
}

#[cfg(unix)]
#[test]
fn a_key_other_users_can_read_is_refused_without_echoing_it() {
    use std::os::unix::fs::PermissionsExt as _;
    let dir = tempfile::tempdir().unwrap();
    let (path, _) = key_file(dir.path());
    let seed = std::fs::read_to_string(&path).unwrap();
    for mode in [0o640, 0o604, 0o644, 0o666] {
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode)).unwrap();
        let refusal = sign::read_signing_key(&path).unwrap_err().to_string();
        assert!(refusal.contains("chmod 600"), "{mode:o}: {refusal}");
        assert!(!refusal.contains(seed.trim()));
    }
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o400)).unwrap();
    assert!(sign::read_signing_key(&path).is_ok());
}

#[test]
fn a_key_file_that_is_not_a_seed_says_so_and_repeats_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("bad.key");
    for body in ["", "hunter2-not-a-key", &"zz".repeat(32), &"ab".repeat(31)] {
        std::fs::write(&path, body).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        }
        let refusal = sign::read_signing_key(&path).unwrap_err().to_string();
        assert!(refusal.contains("64 hex characters"), "{refusal}");
        assert!(body.is_empty() || !refusal.contains(body), "{refusal}");
    }
    assert!(sign::read_signing_key(&dir.path().join("missing.key")).is_err());
}

#[test]
fn signing_replaces_any_signature_and_verifies_under_the_public_half() {
    let dir = tempfile::tempdir().unwrap();
    let (key, made) = key_file(dir.path());
    let file = recipe_file(dir.path(), |_| {});
    let signed = sign::sign(&key, &file, SignOptions::default()).unwrap();
    let public = parse_public_key_hex(made["public_key"].as_str().unwrap()).unwrap();
    signed
        .verify(&public)
        .expect("signed by the key's own public half");
    assert_eq!(signed.signature.as_ref().unwrap().key_id, made["key_id"]);
    assert_eq!(signed.canary, None, "a signature is not a canary");

    // Signing a signed file again, with another key, replaces the signature.
    let again_path = dir.path().join("again.json");
    sign::emit(&signed, Some(&again_path)).unwrap();
    let other = dir.path().join("other.key");
    sign::keygen(&other).unwrap();
    let resigned = sign::sign(&other, &again_path, SignOptions::default()).unwrap();
    assert_ne!(resigned.signature, signed.signature);
    assert_eq!(resigned.digest().unwrap(), signed.digest().unwrap());
    assert!(resigned.verify(&public).is_err());

    // What `emit` wrote is a document the Host's parser reads back unchanged.
    let text = std::fs::read(&again_path).unwrap();
    assert_eq!(RecipeDocument::parse(&text).unwrap(), signed);
}

#[test]
fn a_signature_says_only_what_it_was_asked_to() {
    let dir = tempfile::tempdir().unwrap();
    let (key, _) = key_file(dir.path());
    let file = recipe_file(dir.path(), |_| {});

    let canary = sign::sign(
        &key,
        &file,
        SignOptions {
            canary_at: Some("now"),
            expires_in_days: None,
        },
    )
    .unwrap();
    assert!(canary.canary.is_some());

    let renewed = sign::sign(
        &key,
        &file,
        SignOptions {
            canary_at: None,
            expires_in_days: Some(60),
        },
    )
    .unwrap();
    let expires = chrono::DateTime::parse_from_rfc3339(&renewed.expires_at).unwrap();
    let days = (expires.with_timezone(&Utc) - Utc::now()).num_days();
    assert!((59..=60).contains(&days), "{days}");

    // Nothing is signed outside its window or about the future.
    let long = sign::sign(
        &key,
        &file,
        SignOptions {
            canary_at: None,
            expires_in_days: Some(94),
        },
    );
    assert!(long.unwrap_err().to_string().contains("93 days"));
    let future = (Utc::now() + Duration::days(1)).to_rfc3339();
    let refused = sign::sign(
        &key,
        &file,
        SignOptions {
            canary_at: Some(&future),
            expires_in_days: None,
        },
    );
    assert!(refused.unwrap_err().to_string().contains("future"));
    let stale = (Utc::now() - Duration::days(100)).to_rfc3339();
    let refused = sign::sign(
        &key,
        &file,
        SignOptions {
            canary_at: Some(&stale),
            expires_in_days: None,
        },
    );
    assert!(refused
        .unwrap_err()
        .to_string()
        .contains("older than 90 days"));
    assert!(sign::sign(
        &key,
        &file,
        SignOptions {
            canary_at: Some("yesterday"),
            expires_in_days: None
        }
    )
    .is_err());
    let lapsed = recipe_file(dir.path(), |d| {
        d["expires_at"] = json!("2020-01-01T00:00:00Z");
    });
    assert!(sign::sign(&key, &lapsed, SignOptions::default())
        .unwrap_err()
        .to_string()
        .contains("expired"));
}

#[test]
fn a_recipe_that_is_not_one_is_refused_before_anything_is_signed_or_sent() {
    let dir = tempfile::tempdir().unwrap();
    let (key, _) = key_file(dir.path());
    for edit in [
        (|d: &mut Value| d["trust"] = json!("corpus")) as fn(&mut Value),
        |d| d["change_password"]["value"] = json!("hunter2"),
        |d| d["origin"] = json!("http://unit.example"),
        |d| d["change_password"]["change_url"] = json!("https://evil.example/x"),
    ] {
        let file = recipe_file(dir.path(), edit);
        assert!(sign::read_recipe(&file).is_err());
        assert!(sign::sign(&key, &file, SignOptions::default()).is_err());
    }
    let big = dir.path().join("big.json");
    std::fs::write(&big, vec![b' '; 20 * 1024]).unwrap();
    assert!(sign::read_recipe(&big)
        .unwrap_err()
        .to_string()
        .contains("larger than"));
}
