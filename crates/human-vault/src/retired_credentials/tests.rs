use super::*;
const NOW: &str = "2026-10-05T00:00:00.000Z";

#[test]
fn enrollment_rejects_noncanonical_spelling_without_rewriting_passwords() {
    let mut records = Records::new("native:test");
    assert!(records
        .enroll("e\u{301}".as_bytes(), Response::Reject, NOW)
        .is_err());
    assert!(records.traps.is_empty());
    assert!(records
        .enroll("\u{ff21}".as_bytes(), Response::Reject, NOW)
        .is_err());
}

proptest::proptest! {
    #![proptest_config(proptest::test_runner::Config::with_cases(128))]
    #[test]
    fn bounded_untrusted_bytes_never_panic_and_accepted_records_round_trip(bytes in proptest::collection::vec(proptest::prelude::any::<u8>(), 0..8192)) {
        if let Ok(text) = std::str::from_utf8(&bytes) {
            if let Ok(records) = Records::parse(text, "native:test") {
                let serialized = serde_json::to_string(&records).unwrap();
                proptest::prop_assert_eq!(Records::parse(&serialized, "native:test").unwrap(), records);
            }
        }
    }
    #[test]
    fn structured_wire_versions_and_retention_limits(version in 0_u32..4, count in 0_usize..6, reject in proptest::prelude::any::<bool>()) {
        let mut records = Records::new("native:test");
        records.v = version;
        records.traps = (0..count).map(|index| TrapRecord {
            id: format!("fixture-{index}"), created_at: NOW.into(),
            response: if reject { Response::Reject } else { Response::SyntheticDecoy },
            salt: "AAECAwQFBgcICQoLDA0ODw==".into(),
            verifier: "lF4CYhE/M319Ne3ZL58n9f15oXGjfYdF8TdmQkbeLmg=".into(),
        }).collect();
        let parsed = Records::parse(&serde_json::to_string(&records).unwrap(), "native:test");
        proptest::prop_assert_eq!(parsed.is_ok(), version == 1 && count <= 3);
        if let Ok(parsed) = parsed { proptest::prop_assert_eq!(parsed, records); }
    }
}

#[test]
fn typescript_argon2id_vectors_exact_utf8_bytes() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../packages/app-core/src/lib/retired-credentials/protocol-vectors.json"
    ))
    .unwrap();
    assert_eq!(fixture["kdf"]["memoryKiB"], 65536);
    assert_eq!(fixture["kdf"]["iterations"], 3);
    for vector in fixture["vectors"].as_array().unwrap() {
        let salt = decode::<16>(vector["saltB64"].as_str().unwrap()).unwrap();
        let actual =
            derive_verifier(vector["password"].as_str().unwrap().as_bytes(), &salt).unwrap();
        assert_eq!(
            STANDARD.encode(actual),
            vector["verifierB64"].as_str().unwrap()
        );
    }
}

#[test]
fn context_and_bounded_records_fail_closed_before_derivation() {
    let mut records = Records::new("native:test");
    let trap = TrapRecord {
        id: "selected".into(),
        created_at: NOW.into(),
        response: Response::Reject,
        salt: "AAECAwQFBgcICQoLDA0ODw==".into(),
        verifier: "lF4CYhE/M319Ne3ZL58n9f15oXGjfYdF8TdmQkbeLmg=".into(),
    };
    records.traps.push(trap.clone());
    let text = serde_json::to_string(&records).unwrap();
    assert!(Records::parse(&text, "foreign").is_err());
    assert_eq!(Records::parse(&text, "native:test").unwrap(), records);
    records.traps.push(trap);
    assert!(records.probe(b"anything").is_err());
    assert!(Records::parse(&"x".repeat(MAX_RECORD_BYTES + 1), "native:test").is_err());
}

#[test]
fn exact_selected_passwords_and_non_destructive_bounded_events() {
    let mut records = Records::new("native:test");
    let trap = records
        .enroll(b"selected old password", Response::SyntheticDecoy, NOW)
        .unwrap();
    assert_eq!(
        records.probe(b"selected old password").unwrap(),
        Some(trap.clone())
    );
    assert!(records.probe(b"Selected old password").unwrap().is_none());
    for _ in 0..40 {
        records.observe(&trap, NOW).unwrap();
    }
    assert_eq!(records.events.len(), MAX_EVENTS);
    assert!(!serde_json::to_string(&records)
        .unwrap()
        .contains("selected old password"));
    assert!(records
        .enroll(b"selected old password", Response::Reject, NOW)
        .is_err());
}
