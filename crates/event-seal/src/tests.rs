use std::sync::Mutex;

use super::*;

/// The sealer is process-wide; tests that touch it take turns.
static SERIAL: Mutex<()> = Mutex::new(());

fn sealer() -> EventSealer {
    EventSealer::from_host_key(&[5; 32])
}

#[test]
fn a_value_round_trips_and_shows_nothing() {
    let sealed = sealer().seal("t.c", "the approval comment: call ada@example.com");
    assert!(sealed.starts_with(PREFIX) && is_sealed(&sealed));
    assert!(!sealed.contains("ada") && !sealed.contains("approval"));
    assert_eq!(
        sealer().open("t.c", &sealed).unwrap(),
        "the approval comment: call ada@example.com"
    );
}

#[test]
fn it_opens_only_under_its_key_and_its_column() {
    let sealed = sealer().seal("t.c", "x");
    assert!(sealer().open("t.other", &sealed).is_err());
    assert!(EventSealer::from_host_key(&[6; 32])
        .open("t.c", &sealed)
        .is_err());
}

#[test]
fn a_torn_or_altered_value_is_refused_not_read_as_empty() {
    let sealed = sealer().seal("t.c", "x");
    assert!(sealer().open("t.c", &sealed[..sealed.len() - 5]).is_err());
    assert!(sealer().open("t.c", PREFIX).is_err());
    let mut altered = sealed.clone();
    altered.replace_range(12..13, if &altered[12..13] == "A" { "B" } else { "A" });
    assert!(sealer().open("t.c", &altered).is_err());
}

#[test]
fn plaintext_is_available_only_to_explicit_migration() {
    assert!(sealer().open("t.c", "an older build's text").is_err());
    assert_eq!(
        sealer()
            .open_legacy_for_migration("t.c", "an older build's text")
            .unwrap(),
        "an older build's text"
    );
    assert!(sealer().open("t.c", "").is_err());
    assert_eq!(sealer().open_legacy_for_migration("t.c", "").unwrap(), "");
}

#[test]
fn two_seals_of_one_value_differ() {
    assert_ne!(sealer().seal("t.c", "same"), sealer().seal("t.c", "same"));
}

#[test]
fn the_process_wide_sealer_seals_when_installed_and_passes_through_otherwise() {
    let _turn = SERIAL.lock().unwrap_or_else(PoisonError::into_inner);
    clear();
    assert!(!is_active());
    assert_eq!(seal("t.c", "plain"), "plain");
    assert_eq!(open("t.c", "plain").unwrap(), "plain");

    install(&[5; 32]);
    assert!(is_active());
    let sealed = seal("t.c", "secret text");
    assert!(is_sealed(&sealed) && !sealed.contains("secret"));
    assert_eq!(open("t.c", &sealed).unwrap(), "secret text");
    assert_eq!(seal_opt("t.c", None), None);
    assert_eq!(open_opt("t.c", None).unwrap(), None);
    assert_eq!(
        open_opt("t.c", Some(sealed)).unwrap().as_deref(),
        Some("secret text")
    );

    clear();
    assert!(
        open(
            "t.c",
            &EventSealer::from_host_key(&[5; 32]).seal("t.c", "x")
        )
        .is_err(),
        "a sealed value with no sealer installed is refused, not returned as ciphertext"
    );
}

fn legacy_value(column: &str, text: &str) -> String {
    let nonce = XChaCha20Poly1305::generate_nonce(&mut OsRng);
    let ciphertext = sealer()
        .cipher()
        .encrypt(
            &nonce,
            Payload {
                msg: text.as_bytes(),
                aad: column.as_bytes(),
            },
        )
        .unwrap();
    let mut packed = nonce.to_vec();
    packed.extend_from_slice(&ciphertext);
    format!("{LEGACY_PREFIX}{}", URL_SAFE_NO_PAD.encode(packed))
}

#[test]
fn legacy_ciphertext_remains_readable_and_recognized() {
    let legacy = legacy_value("t.c", "old secret");
    assert!(is_sealed(&legacy));
    assert!(sealer().open("t.c", &legacy).is_err());
    assert_eq!(
        sealer().open_legacy_for_migration("t.c", &legacy).unwrap(),
        "old secret"
    );
    assert!(sealer().open("t.other", &legacy).is_err());
    assert!(sealer().open("t.c", "osev1.").is_err());
}

#[test]
fn customer_envelopes_require_the_customer_and_root() {
    let first = EventSealer::from_customer_key(&[5; 32], "first");
    let sealed = first.seal("t.c", "customer secret");
    assert_eq!(first.open("t.c", &sealed).unwrap(), "customer secret");
    assert!(EventSealer::from_customer_key(&[5; 32], "second")
        .open("t.c", &sealed)
        .is_err());
    assert!(EventSealer::from_customer_key(&[6; 32], "first")
        .open("t.c", &sealed)
        .is_err());
    assert!(sealer().open("t.c", &sealed).is_err());
    assert!(first.open("t.c", &legacy_value("t.c", "old")).is_err());
}

#[test]
fn scoped_process_envelopes_bind_customer_record_and_column() {
    let _turn = SERIAL.lock().unwrap_or_else(PoisonError::into_inner);
    install(&[5; 32]);
    let sealed = seal_in("first", "t.c", "record1", "secret");
    assert_eq!(
        open_in("first", "t.c", "record1", &sealed).unwrap(),
        "secret"
    );
    assert!(open_in("second", "t.c", "record1", &sealed).is_err());
    assert!(open_in("first", "t.c", "record2", &sealed).is_err());
    assert!(open_in("first", "t.other", "record1", &sealed).is_err());
    assert!(open("t.c", &sealed).is_err());
    let legacy = legacy_value("t.c", "old");
    for customer in ["first", "second"] {
        for record in ["record1", "record2"] {
            assert!(open_in(customer, "t.c", record, &legacy).is_err());
            assert!(open_in(customer, "t.c", record, "old plaintext").is_err());
        }
    }
    assert_eq!(open_legacy_for_migration("t.c", &legacy).unwrap(), "old");
    let migrated = seal_in(
        "first",
        "t.c",
        "record1",
        &open_legacy_for_migration("t.c", &legacy).unwrap(),
    );
    assert_eq!(
        open_in("first", "t.c", "record1", &migrated).unwrap(),
        "old"
    );
    assert!(open_in("second", "t.c", "record1", &migrated).is_err());
    assert!(open_in("first", "t.c", "record2", &migrated).is_err());
    clear();
    assert!(open_in("first", "t.c", "record1", &sealed).is_err());
}

#[test]
fn malformed_envelopes_fail_closed() {
    for body in ["", "!", "AA", "AAAA"] {
        let stored = format!("{PREFIX}{body}");
        assert!(is_sealed(&stored));
        assert!(sealer().open("t.c", &stored).is_err());
    }
    let sealed = sealer().seal("t.c", "");
    assert_eq!(sealer().open("t.c", &sealed).unwrap(), "");
    let packed = URL_SAFE_NO_PAD
        .decode(sealed.strip_prefix(PREFIX).unwrap())
        .unwrap();
    for offset in [0, NONCE_LEN, NONCE_LEN + WRAPPED_KEY_LEN, packed.len() - 1] {
        let mut altered = packed.clone();
        altered[offset] ^= 1;
        assert!(sealer()
            .open(
                "t.c",
                &format!("{PREFIX}{}", URL_SAFE_NO_PAD.encode(altered))
            )
            .is_err());
    }
}

#[test]
fn unknown_envelope_versions_are_not_plaintext() {
    for stored in ["osev3.AA", "osev99.unknown", "osev2", "osev"] {
        assert!(is_sealed(stored));
        assert!(sealer().open("t.c", stored).is_err());
    }
}

#[test]
fn explicit_migration_without_a_key_accepts_only_development_plaintext() {
    let _turn = SERIAL.lock().unwrap_or_else(PoisonError::into_inner);
    clear();
    for plain in ["development value", ""] {
        assert_eq!(open_legacy_for_migration("t.c", plain).unwrap(), plain);
    }
    for sealed in [
        legacy_value("t.c", "old"),
        sealer().seal("t.c", "new"),
        "osev1.malformed".to_owned(),
    ] {
        assert!(open_legacy_for_migration("t.c", &sealed).is_err());
    }
    install(&[5; 32]);
    assert!(open_in("first", "t.c", "record", "development value").is_err());
    clear();
}
