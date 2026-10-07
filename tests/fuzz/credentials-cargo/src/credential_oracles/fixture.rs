use base64::{engine::general_purpose::STANDARD, Engine};
use chrono::{DateTime, Utc};
use opensesame_human_vault::credential_canaries::receiver::{Metadata, Package, Provision};
use serde_json::Value;

pub const IDENTITY: &str = "fixture-vault";
pub const TOMB: &str = "credential-depth-fixture";
pub const NOW: &str = "2026-10-06T00:00:00.000Z";

pub fn observation() -> (Provision, Metadata, Package, Value, DateTime<Utc>) {
    let vector: Value = serde_json::from_str(include_str!(
        "../../../../../packages/app-core/src/lib/credential-observation/protocol-vectors.json"
    ))
    .expect("public golden vector");
    let bytes: Vec<u8> = serde_json::from_value(vector["publicIndependentKeyBytes"].clone())
        .expect("public numeric key fixture");
    assert_eq!(bytes, (0_u8..64).collect::<Vec<_>>());
    let mut provision = vector["provision"].clone();
    provision["independentKeyMaterialB64"] = STANDARD.encode(bytes).into();
    (
        serde_json::from_value(provision).unwrap(),
        serde_json::from_value(vector["metadata"].clone()).unwrap(),
        serde_json::from_value(vector["packet"].clone()).unwrap(),
        vector,
        NOW.parse().unwrap(),
    )
}

pub fn hostile_text(bytes: &[u8], limit: usize) -> String {
    String::from_utf8_lossy(&bytes[..bytes.len().min(limit)]).into_owned()
}
