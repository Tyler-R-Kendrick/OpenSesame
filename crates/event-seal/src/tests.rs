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
fn plaintext_is_returned_as_it_is() {
    assert_eq!(
        sealer().open("t.c", "an older build's text").unwrap(),
        "an older build's text"
    );
    assert_eq!(sealer().open("t.c", "").unwrap(), "");
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
