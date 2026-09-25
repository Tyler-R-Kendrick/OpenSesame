use std::sync::Arc;

use argon2::password_hash::rand_core::OsRng;
use argon2::password_hash::{PasswordHasher as _, SaltString};
use sha2::{Digest, Sha256};

use super::*;

fn cheap(memory_kib: u32) -> Arc<dyn PasswordHashScheme> {
    Arc::new(Argon2idScheme::new(memory_kib, 1, 1).unwrap())
}

#[test]
fn argon2id_round_trips_and_names_itself() {
    let registry = HashRegistry::new(cheap(64));
    let stored = registry.hash(b"client-hash").unwrap();
    assert!(
        stored.starts_with("$argon2id$v=19$m=64,t=1,p=1$"),
        "{stored}"
    );
    assert_eq!(
        registry.verify(&stored, b"client-hash"),
        Verdict::Match { rehash: None }
    );
    assert_eq!(registry.verify(&stored, b"client-hasH"), Verdict::Mismatch);
    // Every hash gets its own salt.
    assert_ne!(stored, registry.hash(b"client-hash").unwrap());
}

#[test]
fn the_default_is_argon2id_at_owasp_server_parameters() {
    let registry = HashRegistry::default();
    assert_eq!(registry.current_id(), "argon2id");
    let stored = registry.hash(b"x").unwrap();
    assert!(
        stored.starts_with("$argon2id$v=19$m=19456,t=2,p=1$"),
        "{stored}"
    );
}

#[test]
fn raising_argon2_parameters_rehashes_on_the_next_sign_in() {
    let old = HashRegistry::new(cheap(64)).hash(b"secret").unwrap();
    let raised = HashRegistry::new(cheap(128));
    let Verdict::Match {
        rehash: Some(replacement),
    } = raised.verify(&old, b"secret")
    else {
        panic!("an older-parameter hash must verify and be re-hashed");
    };
    assert!(replacement.starts_with("$argon2id$v=19$m=128,t=1,p=1$"));
    assert_eq!(
        raised.verify(&replacement, b"secret"),
        Verdict::Match { rehash: None }
    );
}

#[test]
fn legacy_pbkdf2_verifies_once_and_is_replaced_by_argon2id() {
    let salt = SaltString::generate(&mut OsRng);
    let params = pbkdf2::Params {
        rounds: 1_000,
        output_length: 32,
    };
    let legacy = pbkdf2::Pbkdf2
        .hash_password_customized(
            b"secret",
            Some(pbkdf2::Algorithm::Pbkdf2Sha256.ident()),
            None,
            params,
            &salt,
        )
        .unwrap()
        .to_string();
    assert!(legacy.starts_with("$pbkdf2-sha256$"), "{legacy}");

    let registry = HashRegistry::new(cheap(64)).accept(Arc::new(Pbkdf2Sha256Legacy));
    assert_eq!(registry.verify(&legacy, b"wrong"), Verdict::Mismatch);
    let Verdict::Match {
        rehash: Some(upgraded),
    } = registry.verify(&legacy, b"secret")
    else {
        panic!("a legacy hash must verify and be upgraded");
    };
    assert!(upgraded.starts_with("$argon2id$"));

    // Without the legacy scheme accepted, the same hash never matches.
    assert_eq!(
        HashRegistry::new(cheap(64)).verify(&legacy, b"secret"),
        Verdict::Mismatch
    );
}

/// A stand-in for whatever succeeds Argon2id. Test-only: salted SHA-256 is
/// not a password hash.
struct Successor;

impl PasswordHashScheme for Successor {
    fn id(&self) -> &'static str {
        "successor-test"
    }
    fn hash(&self, secret: &[u8]) -> Result<String, HashError> {
        let salt = SaltString::generate(&mut OsRng);
        let digest = Sha256::new()
            .chain_update(salt.as_str())
            .chain_update(secret)
            .finalize();
        let encoded =
            argon2::password_hash::Output::new(&digest).map_err(|e| HashError(e.to_string()))?;
        Ok(format!("$successor-test$v=1${}${encoded}", salt.as_str()))
    }
    fn verify(&self, stored: &PasswordHash<'_>, secret: &[u8]) -> bool {
        let (Some(salt), Some(hash)) = (stored.salt, stored.hash) else {
            return false;
        };
        let digest = Sha256::new()
            .chain_update(salt.as_str())
            .chain_update(secret)
            .finalize();
        argon2::password_hash::Output::new(&digest).is_ok_and(|candidate| candidate == hash)
    }
    fn is_current(&self, stored: &PasswordHash<'_>) -> bool {
        stored.algorithm.as_str() == self.id()
    }
}

#[test]
fn argon2id_can_be_retired_for_a_successor_without_a_forced_reset() {
    let before = HashRegistry::new(cheap(64)).hash(b"secret").unwrap();
    let after = HashRegistry::new(Arc::new(Successor)).accept(cheap(64));
    assert_eq!(after.current_id(), "successor-test");

    let Verdict::Match {
        rehash: Some(migrated),
    } = after.verify(&before, b"secret")
    else {
        panic!("an Argon2id hash must still verify after the switch");
    };
    assert!(migrated.starts_with("$successor-test$"), "{migrated}");
    assert_eq!(
        after.verify(&migrated, b"secret"),
        Verdict::Match { rehash: None }
    );
    assert_eq!(after.verify(&migrated, b"nope"), Verdict::Mismatch);
}

#[test]
fn unreadable_or_unknown_hashes_never_match() {
    let registry = HashRegistry::default();
    assert_eq!(registry.verify("", b"x"), Verdict::Mismatch);
    assert_eq!(
        registry.verify("plaintext", b"plaintext"),
        Verdict::Mismatch
    );
    assert_eq!(
        registry.verify("$scrypt$ln=1,r=8,p=1$c2FsdHNhbHQ$aGFzaGhhc2g", b"x"),
        Verdict::Mismatch
    );
}

#[test]
#[should_panic(expected = "current scheme must be able to write")]
fn a_verify_only_scheme_cannot_be_current() {
    let _ = HashRegistry::new(Arc::new(Pbkdf2Sha256Legacy));
}
