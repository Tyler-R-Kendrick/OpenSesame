use super::fixture::{hostile_text, observation};
use chrono::Duration;
use opensesame_human_vault::credential_canaries::receiver::{
    acknowledge, authenticate, open, seal, verify_acknowledgement, Package, Provision,
};
use serde_json::{json, Value};

pub fn observation_wire(bytes: &[u8]) {
    let (provision, metadata, packet, vector, now) = observation();
    let golden = serde_json::to_string(&packet).unwrap();
    assert_eq!(
        serde_json::to_value(open(&golden, &provision, now).unwrap()).unwrap(),
        vector["metadata"]
    );
    assert!(verify_acknowledgement(
        &vector["ack"].to_string(),
        &packet,
        &provision,
        now + Duration::seconds(1)
    )
    .is_ok());
    let raw = hostile_text(bytes, 8193);
    let _ = Provision::parse(&raw);
    if let Ok(clear) = open(&raw, &provision, now) {
        clear.validate().unwrap();
    }
    let _ = verify_acknowledgement(&hostile_text(bytes, 2049), &packet, &provision, now);
    let mut hostile = serde_json::to_value(&packet).unwrap();
    let field = [
        "v",
        "packageId",
        "receiverId",
        "bindingId",
        "keyEpoch",
        "issuedAt",
        "expiresAt",
        "nonceB64",
        "ciphertextB64",
        "macB64",
    ][usize::from(bytes.first().copied().unwrap_or(0)) % 10];
    let original = hostile[field].clone();
    hostile[field] = if field == "v" || field == "keyEpoch" {
        json!(u32::from(bytes.get(1).copied().unwrap_or(0)))
    } else {
        Value::String(hostile_text(bytes.get(1..).unwrap_or_default(), 4096))
    };
    if hostile[field] != original {
        assert!(open(&hostile.to_string(), &provision, now).is_err());
    }
    // A genuine ACK for a different genuinely sealed package is not an ACK for this one.
    let other = seal(&metadata, &provision, now).unwrap();
    let ack = acknowledge(&other, &provision, now).unwrap();
    assert!(verify_acknowledgement(
        &serde_json::to_string(&ack).unwrap(),
        &packet,
        &provision,
        now
    )
    .is_err());
    for offset in [-301, -300, -299, 86_399, 86_400, 86_401] {
        let at = now + Duration::seconds(offset);
        assert_eq!(
            authenticate(&packet, &provision, at).is_ok(),
            (-300..86_400).contains(&offset)
        );
    }
    // Parsed hostile packages never grant access to a production key; this API has none.
    if let Ok(parsed) = serde_json::from_str::<Package>(&raw) {
        let _ = parsed.validate_shape();
        let _ = authenticate(&parsed, &provision, now);
    }
}
