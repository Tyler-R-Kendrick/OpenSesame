//! The fixture file and the steps both integration suites take with it.
#![allow(dead_code)]

use opensesame_quorum_recovery::canonical::frame;
use opensesame_quorum_recovery::encoding::b64url_decode;
use opensesame_quorum_recovery::hpke::{open_base, HpkeAead};
use opensesame_quorum_recovery::{recover, share_commitment, RecoveryBundle};
use serde::Deserialize;
use serde_json::Value;

/// `circle.ts`'s `DELIVERY_INFO`; pinned here as the TypeScript test pins it.
pub const DELIVERY_INFO: &str = "opensesame:quorum-delivery:v1";
/// `approve.ts`'s `RELEASE_INFO`.
pub const RELEASE_INFO: &str = "opensesame:quorum-release:v1";

pub const COMMITTED: &str =
    include_str!("../../../../spec/conformance/quorum-recovery-fixture.json");

#[derive(Debug, Deserialize)]
pub struct Delivery {
    #[serde(rename = "circleId")]
    pub circle_id: String,
    #[serde(rename = "guardianId")]
    pub guardian_id: String,
    pub epoch: u64,
    pub enc: String,
    pub ciphertext: String,
}

#[derive(Debug, Deserialize)]
pub struct FixtureGuardian {
    pub id: String,
    pub name: String,
    pub group: String,
    pub mnemonic: String,
    #[serde(rename = "hpkeSecretKey")]
    pub hpke_secret_key: String,
    pub delivery: Delivery,
}

#[derive(Debug, Deserialize)]
pub struct Fixture {
    pub about: String,
    #[serde(rename = "ownerPublicKey")]
    pub owner_public_key: String,
    pub bundle: Value,
    pub payload: Value,
    #[serde(rename = "payloadText")]
    pub payload_text: String,
    pub quorum: Vec<String>,
    pub guardians: Vec<FixtureGuardian>,
}

pub fn committed() -> Fixture {
    serde_json::from_str(COMMITTED).expect("the committed fixture parses")
}

pub fn bundle_of(fixture: &Fixture) -> RecoveryBundle {
    RecoveryBundle::from_value(&fixture.bundle, Some(&fixture.owner_public_key))
        .expect("the fixture's bundle verifies against its owner key")
}

pub fn mnemonics_of(fixture: &Fixture, ids: &[&str]) -> Vec<String> {
    ids.iter()
        .map(|id| {
            fixture
                .guardians
                .iter()
                .find(|g| g.id == *id)
                .unwrap_or_else(|| panic!("no guardian {id}"))
                .mnemonic
                .clone()
        })
        .collect()
}

pub fn quorum_mnemonics(fixture: &Fixture) -> Vec<String> {
    let ids: Vec<&str> = fixture.quorum.iter().map(String::as_str).collect();
    mnemonics_of(fixture, &ids)
}

/// What the TypeScript `deliveryAad` frames.
pub fn delivery_aad(delivery: &Delivery) -> Vec<u8> {
    frame(&[
        DELIVERY_INFO,
        &delivery.circle_id,
        &delivery.guardian_id,
        &delivery.epoch.to_string(),
    ])
}

/// What the TypeScript `releaseAad` frames.
pub fn release_aad(digest: &str, guardian_id: &str) -> Vec<u8> {
    frame(&[RELEASE_INFO, digest, guardian_id])
}

/// Everything a fixture promises, checked natively: the policy is the owner's,
/// every share is committed to and delivered, and the quorum opens the bundle.
pub fn assert_opens(fixture: &Fixture) {
    let bundle = bundle_of(fixture);
    let policy = &bundle.signed_policy.policy;
    assert_eq!(policy.share_commitments.len(), fixture.guardians.len());
    for g in &fixture.guardians {
        assert_eq!(
            policy.share_commitments.get(&g.id),
            Some(&share_commitment(&policy.circle_id, &g.id, &g.mnemonic)),
            "{} is committed to",
            g.name
        );
        let opened = open_base(
            &b64url_decode(&g.hpke_secret_key).unwrap(),
            &b64url_decode(&g.delivery.enc).unwrap(),
            DELIVERY_INFO.as_bytes(),
            &delivery_aad(&g.delivery),
            &b64url_decode(&g.delivery.ciphertext).unwrap(),
            HpkeAead::Aes128Gcm,
        )
        .unwrap_or_else(|e| panic!("{}'s delivery: {e}", g.name));
        assert_eq!(opened.expose(), g.mnemonic.as_bytes(), "{}", g.name);
    }
    let recovered = recover(&bundle, &quorum_mnemonics(fixture)).expect("the quorum recovers");
    assert_eq!(recovered.payload.expose(), fixture.payload_text.as_bytes());
    let value: Value = serde_json::from_slice(recovered.payload.expose()).unwrap();
    assert_eq!(value, fixture.payload);
    assert!(recovered.shares.iter().all(|m| m.guardian.is_some()));
}
