use super::fixture::{hostile_text, NOW, TOMB};
use opensesame_human_vault::retired_credentials::{Records, MAX_RECORD_BYTES};
use serde_json::json;

fn accepted_roundtrip(raw: &str) {
    if let Ok(records) = Records::parse(raw, TOMB) {
        records.validate(TOMB).unwrap();
        let encoded = serde_json::to_string(&records).unwrap();
        assert_eq!(Records::parse(&encoded, TOMB).unwrap(), records);
        assert!(Records::parse(&encoded, "foreign-vault").is_err());
    }
}

pub fn retired_records(bytes: &[u8]) {
    // Never call probe/enroll/derive here: their real 64MiB KDF is tested separately.
    accepted_roundtrip(&hostile_text(bytes, MAX_RECORD_BYTES + 1));
    let count = usize::from(bytes.first().copied().unwrap_or(0) % 6);
    let version = u32::from(bytes.get(1).copied().unwrap_or(1) % 4);
    let traps = (0..count)
        .map(|index| {
            json!({
                "id": format!("selected-{index}"), "createdAt": NOW,
                "response": "reject", "salt": "AAAAAAAAAAAAAAAAAAAAAA==",
                "verifier": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
            })
        })
        .collect::<Vec<_>>();
    let wire = json!({"v":version,"tomb":TOMB,"traps":traps,"events":[]}).to_string();
    assert_eq!(
        Records::parse(&wire, TOMB).is_ok(),
        version == 1 && count <= 3
    );
    accepted_roundtrip(&wire);
    let mut changed: serde_json::Value = serde_json::from_str(&wire).unwrap();
    changed["plaintextPassword"] = "public-fuzz-fixture".into();
    assert!(Records::parse(&changed.to_string(), TOMB).is_err());
}
