//! Session lifetime and secrecy discipline.
//!
//! Constitution C5: key material lives in `secrecy::SecretBox`, is zeroized on
//! drop, is never logged, and never reaches disk. Two of those are checkable
//! mechanically, and this file checks them:
//!
//! * a key type that implements `Debug` can be printed into a log by accident;
//! * a key type that implements `Serialize` can be written to disk or into a
//!   receipt by accident.
//!
//! The probes below assert the *absence* of those impls using autoref
//! specialization, so adding `#[derive(Debug, Serialize)]` to a key type in a
//! moment of convenience fails this test rather than shipping.

use std::time::{Duration, SystemTime};

use opensesame_provider_bitwarden::api::TokenResponse;
use opensesame_provider_bitwarden::{MasterKey, Session, SymmetricKey, Vault};

// ---------------------------------------------------------------------------
// Autoref-specialization probes: `Probe(&value).is_debug()` resolves to the
// inherent method (true) only when the type implements the trait, and falls
// back to the blanket trait method (false) otherwise.
// ---------------------------------------------------------------------------

struct DebugProbe<'a, T>(#[allow(dead_code)] &'a T);
impl<T: std::fmt::Debug> DebugProbe<'_, T> {
    fn is_debug(&self) -> bool {
        let _ = self;
        true
    }
}
trait NotDebug {
    fn is_debug(&self) -> bool {
        false
    }
}
impl<T> NotDebug for DebugProbe<'_, T> {}

struct SerializeProbe<'a, T>(#[allow(dead_code)] &'a T);
impl<T: serde::Serialize> SerializeProbe<'_, T> {
    fn is_serialize(&self) -> bool {
        let _ = self;
        true
    }
}
trait NotSerialize {
    fn is_serialize(&self) -> bool {
        false
    }
}
impl<T> NotSerialize for SerializeProbe<'_, T> {}

fn key() -> SymmetricKey {
    SymmetricKey::from_bytes(&[7u8; 64]).expect("64-byte key")
}

fn token(expires_in: u64) -> TokenResponse {
    serde_json::from_value(serde_json::json!({
        "access_token": "access-token",
        "refresh_token": "refresh-token",
        "expires_in": expires_in,
    }))
    .expect("token response")
}

#[test]
fn key_material_is_neither_debug_nor_serialize() {
    let master = MasterKey::from_bytes([1u8; 32]);
    let symmetric = key();
    assert!(
        !DebugProbe(&master).is_debug(),
        "MasterKey must not implement Debug — a stray {{:?}} would print it"
    );
    assert!(
        !DebugProbe(&symmetric).is_debug(),
        "SymmetricKey must not implement Debug"
    );
    assert!(
        !SerializeProbe(&master).is_serialize(),
        "MasterKey must not implement Serialize — it would be persistable"
    );
    assert!(
        !SerializeProbe(&symmetric).is_serialize(),
        "SymmetricKey must not implement Serialize"
    );
}

#[test]
fn a_session_is_never_serializable_so_it_cannot_be_persisted() {
    let session = Session::new(
        &token(3600),
        key(),
        Duration::from_secs(900),
        SystemTime::now(),
    );
    assert!(
        !SerializeProbe(&session).is_serialize(),
        "Session must not implement Serialize — there is no on-disk session by design"
    );
    // The probe itself proves the type is sound to use in tests; make sure it
    // is not vacuously false by checking a type that *does* implement both.
    assert!(DebugProbe(&Vault::default()).is_debug());
    assert!(SerializeProbe(&Vault::default()).is_serialize());
}

#[test]
fn session_debug_redacts_tokens_and_keys() {
    let session = Session::new(
        &token(3600),
        key(),
        Duration::from_secs(900),
        SystemTime::now(),
    );
    let rendered = format!("{session:?}");
    assert!(rendered.contains("redacted"), "{rendered}");
    assert!(rendered.contains("token_expires_at"), "{rendered}");
    assert!(rendered.contains("expires_at"), "{rendered}");
    assert!(!rendered.contains("access-token"), "{rendered}");
    assert!(!rendered.contains("refresh-token"), "{rendered}");
}

#[test]
fn the_ttl_is_a_hard_wall_even_for_a_long_lived_token() {
    let start = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
    // A token good for a day, inside a session capped at 15 minutes.
    let session = Session::new(&token(86_400), key(), Duration::from_secs(900), start);
    assert!(!session.is_expired_at(start));
    assert!(session.access_token_at(start).is_ok());
    assert!(session.user_key_at(start).is_ok());

    let after = start + Duration::from_secs(901);
    assert!(session.is_expired_at(after));
    assert_eq!(
        session.access_token_at(after).unwrap_err().code(),
        "session_expired"
    );
    assert_eq!(
        session.user_key_at(after).err().expect("expired").code(),
        "session_expired",
        "an expired session must yield no decryption capability either"
    );
}

#[test]
fn refreshing_replaces_the_token_without_extending_the_session() {
    let start = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
    let mut session = Session::new(&token(60), key(), Duration::from_secs(900), start);
    assert!(
        session.needs_refresh_at(start),
        "60s token is inside the skew"
    );

    let refreshed = serde_json::from_value::<TokenResponse>(serde_json::json!({
        "access_token": "second-access-token",
        "refresh_token": "second-refresh-token",
        "expires_in": 3600,
    }))
    .unwrap();
    session.adopt(&refreshed, start);
    assert_eq!(
        session.access_token_at(start).unwrap(),
        "second-access-token"
    );
    assert_eq!(session.refresh_token(), Some("second-refresh-token"));
    assert!(!session.needs_refresh_at(start));

    // The TTL still ends where it always did: refreshing cannot keep an
    // unlock alive forever.
    assert!(session.is_expired_at(start + Duration::from_secs(901)));
}

#[test]
fn a_refresh_without_a_new_refresh_token_keeps_the_old_one() {
    let start = SystemTime::UNIX_EPOCH;
    let mut session = Session::new(&token(60), key(), Duration::from_secs(900), start);
    let refreshed = serde_json::from_value::<TokenResponse>(serde_json::json!({
        "access_token": "rotated",
        "expires_in": 3600,
    }))
    .unwrap();
    session.adopt(&refreshed, start);
    assert_eq!(session.refresh_token(), Some("refresh-token"));
}

#[test]
fn expire_now_drops_the_session_immediately() {
    let mut session = Session::new(
        &token(3600),
        key(),
        Duration::from_secs(900),
        SystemTime::now(),
    );
    assert!(!session.is_expired());
    session.expire_now();
    assert!(session.is_expired());
    assert_eq!(
        session.access_token().unwrap_err().code(),
        "session_expired"
    );
}

#[test]
fn a_token_without_an_expiry_gets_a_conservative_default() {
    let start = SystemTime::UNIX_EPOCH;
    let token: TokenResponse =
        serde_json::from_value(serde_json::json!({ "access_token": "t" })).unwrap();
    let session = Session::new(&token, key(), Duration::from_secs(7200), start);
    assert!(session.refresh_token().is_none());
    assert!(!session.needs_refresh_at(start));
    assert!(
        session.needs_refresh_at(start + Duration::from_secs(3600)),
        "the default assumed lifetime is one hour"
    );
}
