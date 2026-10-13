use super::*;
const NOW: &str = "2026-10-05T00:00:00.000Z";
const SALT: &str = "AAECAwQFBgcICQoLDA0ODw==";
const VERIFIER: &str = "lF4CYhE/M319Ne3ZL58n9f15oXGjfYdF8TdmQkbeLmg=";
// Serialize only real KDF test cases; the busy case still holds the production mutex.
static KDF_TESTS: std::sync::Mutex<()> = std::sync::Mutex::new(());
fn record() -> Records {
    let mut records = Records {
        v: 1,
        tomb: "native:test".into(),
        traps: vec![],
        events: vec![],
    };
    records.traps.push(TrapRecord {
        id: "selected".into(),
        created_at: NOW.into(),
        response: Response::Reject,
        salt: SALT.into(),
        verifier: VERIFIER.into(),
    });
    records
}
fn parse(records: &Records) -> Result<Records, TrapError> {
    Records::parse(&serde_json::to_string(records).unwrap(), &records.tomb)
}
fn invalid_password(password: &[u8], salt: &[u8; 16]) {
    assert!(matches!(
        derive_verifier(password, salt),
        Err(TrapError::Invalid)
    ));
}
#[test]
fn canonical_records_reject_foreign_unknown_and_duplicate_data() {
    let mut records = record();
    let text = serde_json::to_string(&records).unwrap();
    assert_eq!(Records::parse(&text, &records.tomb).unwrap(), records);
    assert!(Records::parse(&text, "foreign").is_err());
    let mut wire: serde_json::Value = serde_json::from_str(&text).unwrap();
    wire["traps"][0]["submittedPassword"] = "never-retained".into();
    assert!(Records::parse(&wire.to_string(), &records.tomb).is_err());
    records.traps.push(records.traps[0].clone());
    assert!(parse(&records).is_err());
    records = record();
    for version in [0, 2] {
        records.v = version;
        assert!(parse(&records).is_err());
    }
}
#[test]
fn exact_utf8_count_and_wire_size_boundaries() {
    let mut records = record();
    records.tomb = "é".repeat(128);
    records.traps[0].id = "é".repeat(64);
    for n in 1..=4 {
        records.traps = vec![record().traps.remove(0); n];
        for (i, trap) in records.traps.iter_mut().enumerate() {
            trap.id = i.to_string();
        }
        assert_eq!(parse(&records).is_ok(), n <= MAX_TRAPS);
    }
    records = record();
    records.traps[0].id = "é".repeat(64);
    assert!(parse(&records).is_ok());
    records.traps[0].id.push('a');
    assert!(parse(&records).is_err());
    records = record();
    records.tomb = "é".repeat(128);
    assert!(parse(&records).is_ok());
    records.tomb.push('a');
    assert!(parse(&records).is_err());
    records = record();
    for n in [MAX_EVENTS, MAX_EVENTS + 1] {
        records.events = vec![
            TrapEvent::RetiredCredentialObserved {
                trap_id: "selected".into(),
                at: NOW.into(),
                response: Response::Reject
            };
            n
        ];
        assert_eq!(parse(&records).is_ok(), n == MAX_EVENTS);
    }
    records = record();
    let mut text = serde_json::to_string(&records).unwrap();
    text.push_str(&" ".repeat(MAX_RECORD_BYTES - text.len()));
    assert!(Records::parse(&text, &records.tomb).is_ok());
    text.push(' ');
    assert!(Records::parse(&text, &records.tomb).is_err());
}
#[test]
fn event_variants_and_canonical_base64_fail_closed() {
    let mut records = record();
    records.events.push(TrapEvent::SyntheticDecoyInteraction {
        trap_id: "selected".into(),
        at: NOW.into(),
        response: Response::SyntheticDecoy,
        action: DecoyAction::VaultWrite,
    });
    assert_eq!(parse(&records).unwrap(), records);
    if let TrapEvent::SyntheticDecoyInteraction { response, .. } = &mut records.events[0] {
        *response = Response::Reject;
    }
    assert!(parse(&records).is_err());
    for salt in ["AAECAwQFBgcICQoLDA0ODx==", "AAECAwQFBgcICQoLDA0ODw", "AA=="] {
        assert!(verify_password(b"valid", salt, VERIFIER).is_err());
    }
    assert!(verify_password(b"valid", SALT, &VERIFIER[..43]).is_err());
}
#[test]
fn utc_datetime_matches_minute_seconds_fraction_and_calendar_contract() {
    let long = format!("2026-10-05T00:00:00.{}Z", "1".repeat(43));
    assert_eq!(long.len(), 64);
    for date in ["0000-02-29T00:00Z", "2024-02-29T23:59Z", NOW, &long] {
        let mut records = record();
        records.traps[0].created_at = date.into();
        assert_eq!(parse(&records).unwrap().traps[0].created_at, date);
    }
    let rejected = concat!(
        "2025-02-29T00:00Z|1900-02-29T00:00Z|2026-10-05t00:00Z|2026-10-05 00:00Z|",
        "2026-10-05T00:00z|2026-10-05T00:00+00:00|2026-10-05T00:00:60Z|2026-10-05T24:00Z|",
        "2026-10-05T00:60Z|2026-10-05T00:00:00.Z|2026-10-05T00:00.1Z|2026-10-05T00:00:00.１２Z"
    );
    for date in rejected.split('|') {
        let mut records = record();
        records.traps[0].created_at = date.into();
        assert!(parse(&records).is_err(), "{date}");
    }
    assert!(!valid_date(&long.replace('Z', "1Z")));
}
#[test]
fn shared_argon2id_vectors_verify_exact_utf8_without_normalization() {
    let _tests = KDF_TESTS.lock().unwrap();
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../packages/app-core/src/lib/retired-credentials/protocol-vectors.json"
    ))
    .unwrap();
    assert_eq!(
        fixture["kdf"],
        serde_json::json!({ "algorithm": "argon2id", "version": 19,
        "memoryKiB": 65536, "iterations": 3, "parallelism": 1, "hashLength": 32 })
    );
    let salt = decode::<16>(SALT).unwrap();
    let original = salt;
    for vector in fixture["vectors"].as_array().unwrap() {
        let password = vector["password"].as_str().unwrap().as_bytes().to_vec();
        let original_password = password.clone();
        let actual = derive_verifier(&password, &salt).unwrap();
        let expected = vector["verifierB64"].as_str().unwrap();
        assert_eq!(STANDARD.encode(actual), expected);
        assert_eq!(password, original_password);
        assert_eq!(salt, original);
    }
    assert!(verify_password(b"Retired vector password", SALT, VERIFIER).unwrap());
    assert!(!verify_password(b"retired vector password", SALT, VERIFIER).unwrap());
    let other_salt = STANDARD.encode([1; 16]);
    assert!(!verify_password(b"Retired vector password", &other_salt, VERIFIER).unwrap());
}
#[test]
fn raw_password_bounds_are_exact_and_caller_buffers_are_preserved() {
    let _tests = KDF_TESTS.lock().unwrap();
    let salt = [7; 16];
    for password in [
        vec![b'a'; MAX_PASSWORD_BYTES],
        "é".repeat(2048).into_bytes(),
    ] {
        let original = password.clone();
        assert!(derive_verifier(&password, &salt).is_ok());
        assert_eq!(password, original);
        assert_eq!(salt, [7; 16]);
    }
    for password in [
        vec![],
        vec![b'a'; MAX_PASSWORD_BYTES + 1],
        vec![0xff],
        vec![0xed, 0xa0, 0x80],
    ] {
        let original = password.clone();
        invalid_password(&password, &salt);
        assert_eq!(password, original);
        assert_eq!(salt, [7; 16]);
    }
}
#[test]
fn held_real_arena_refuses_overlap_then_releases_without_mutating_inputs() {
    let _tests = KDF_TESTS.lock().unwrap();
    let salt = decode::<16>(SALT).unwrap();
    {
        let _arena = KDF_WORK.lock().unwrap();
        assert!(matches!(
            derive_verifier(b"Retired vector password", &salt),
            Err(TrapError::Busy)
        ));
        invalid_password(&[0xff], &salt);
        assert_eq!(STANDARD.encode(salt), SALT);
    }
    assert_eq!(
        STANDARD.encode(derive_verifier(b"Retired vector password", &salt).unwrap()),
        VERIFIER
    );
}

#[test]
fn wire_duplicates_and_unpaired_surrogates_are_refused_before_verification() {
    let records = record();
    let text = serde_json::to_string(&records).unwrap();
    for (needle, replacement) in [
        (r#""v":1"#, r#""v":0,"v":1"#),
        (r#""v":1"#, r#""v":1,"\u0076":1"#),
        (
            r#""tomb":"native:test""#,
            r#""tomb":"foreign","tomb":"native:test""#,
        ),
        (r#""id":"selected""#, r#""\u0069d":"other","id":"selected""#),
        (r#""id":"selected""#, r#""id":"\ud800""#),
        (r#""id":"selected""#, r#""id":"\udfff""#),
        (r#""tomb":"native:test""#, r#""tomb":"\ud800""#),
    ] {
        assert!(text.contains(needle));
        assert!(Records::parse(&text.replacen(needle, replacement, 1), &records.tomb).is_err());
    }
    let mut with_event = record();
    with_event
        .events
        .push(TrapEvent::RetiredCredentialObserved {
            trap_id: "selected".into(),
            at: NOW.into(),
            response: Response::Reject,
        });
    let text = serde_json::to_string(&with_event).unwrap();
    for (needle, replacement) in [
        (
            r#""trapId":"selected""#,
            r#""trapId":"other","trap\u0049d":"selected""#,
        ),
        (r#""trapId":"selected""#, r#""trapId":"\ud800""#),
        (
            r#""type":"retired_credential_observed""#,
            r#""type":"retired_credential_observed","type":"retired_credential_observed""#,
        ),
    ] {
        assert!(text.contains(needle));
        assert!(Records::parse(&text.replacen(needle, replacement, 1), &with_event.tomb).is_err());
    }
    let paired = serde_json::to_string(&Records {
        tomb: "🚀".into(),
        traps: vec![],
        events: vec![],
        v: 1,
    })
    .unwrap()
    .replace('🚀', r"\ud83d\ude80");
    assert_eq!(Records::parse(&paired, "🚀").unwrap().tomb, "🚀");
}
