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

/// What vaultwarden stores: PBKDF2-SHA256 over the client's hash string, under
/// a 64-byte salt, in raw columns the importer turns into one record.
fn vaultwarden_columns(secret: &[u8], iterations: u32) -> (Vec<u8>, Vec<u8>) {
    let salt: Vec<u8> = (0..64_u8).map(|b| b.wrapping_mul(37)).collect();
    let mut hash = vec![0_u8; 32];
    pbkdf2::pbkdf2_hmac::<Sha256>(secret, &salt, iterations, &mut hash);
    (salt, hash)
}

#[test]
fn a_vaultwarden_hash_with_its_long_salt_verifies_once_and_is_replaced() {
    let (salt, hash) = vaultwarden_columns(b"client-hash", 1_000);
    let record = pbkdf2_sha256_record(1_000, &salt, &hash);
    // Longer than a generic PHC parser takes: the scheme reads it itself.
    assert!(PasswordHash::new(&record).is_err(), "{record}");

    let registry = HashRegistry::new(cheap(64)).accept(Arc::new(Pbkdf2Sha256Legacy));
    assert_eq!(registry.verify(&record, b"client-hasH"), Verdict::Mismatch);
    let Verdict::Match {
        rehash: Some(upgraded),
    } = registry.verify(&record, b"client-hash")
    else {
        panic!("an imported vaultwarden hash must verify and be upgraded");
    };
    assert!(upgraded.starts_with("$argon2id$"), "{upgraded}");
    // Not accepted, not matched.
    assert_eq!(
        HashRegistry::new(cheap(64)).verify(&record, b"client-hash"),
        Verdict::Mismatch
    );
}

#[test]
fn a_short_salted_record_goes_through_the_phc_parser_and_still_verifies() {
    let salt = [7_u8; 16];
    let mut hash = [0_u8; 32];
    pbkdf2::pbkdf2_hmac::<Sha256>(b"secret", &salt, 1_000, &mut hash);
    let record = pbkdf2_sha256_record(1_000, &salt, &hash);
    assert!(PasswordHash::new(&record).is_ok(), "{record}");
    assert!(matches!(
        HashRegistry::default().verify(&record, b"secret"),
        Verdict::Match { rehash: Some(_) }
    ));
}

#[test]
fn a_malformed_long_record_never_matches() {
    let (salt, hash) = vaultwarden_columns(b"x", 1_000);
    let good = pbkdf2_sha256_record(1_000, &salt, &hash);
    let registry = HashRegistry::default();
    let broken = [
        good.replace("i=1000", "i=0"),
        good.replace("i=1000", "i=99999999999"),
        good.replace(",l=32", ",l=31"),
        good.replace("i=1000", "i=1000,x=1"),
        format!("{good}$extra"),
        good.replacen("pbkdf2-sha256", "pbkdf2-sha512", 1),
        good.replace('$', "!"),
    ];
    for record in broken {
        assert_eq!(
            registry.verify(&record, b"x"),
            Verdict::Mismatch,
            "{record}"
        );
    }
}
