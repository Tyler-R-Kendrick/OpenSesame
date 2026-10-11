//! The live half of the cross-implementation proof, run by
//! `scripts/test/quorum-recovery-interop.sh` and ignored otherwise.
//!
//! TypeScript has written a fresh circle to `$OPENSESAME_QUORUM_INTEROP_DIR/
//! ts-out.json` (two epochs of it, so `supersedes` is met). This opens both
//! natively, then writes `rust-out.json`: a bundle sealed natively under the
//! TypeScript policy with shares made natively, and each guardian's share
//! released (HPKE) to the recipient key TypeScript chose. TypeScript opens
//! those in the script's last step.

mod common;

use std::path::PathBuf;

use common::{assert_opens, bundle_of, release_aad, Fixture, RELEASE_INFO};
use opensesame_quorum_recovery::encoding::{b64url_decode, b64url_encode};
use opensesame_quorum_recovery::hpke::{seal_base, HpkeAead};
use opensesame_quorum_recovery::slip39::{self, GenerateParams, GroupSpec};
use opensesame_quorum_recovery::RecoveryBundle;
use rand::RngCore;
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
struct Recipient {
    #[serde(rename = "publicKey")]
    public_key: String,
}

#[derive(Deserialize)]
struct TsOut {
    #[serde(flatten)]
    fixture: Fixture,
    #[serde(rename = "releaseDigest")]
    release_digest: String,
    recipient: Recipient,
    epoch2: Fixture,
}

fn dir() -> PathBuf {
    let dir = std::env::var_os("OPENSESAME_QUORUM_INTEROP_DIR")
        .expect("OPENSESAME_QUORUM_INTEROP_DIR names the directory TypeScript wrote to");
    PathBuf::from(dir)
}

fn rust_bundle(ts: &TsOut, rng: &mut impl RngCore) -> (Value, Value, Vec<String>) {
    let signed = bundle_of(&ts.fixture).signed_policy;
    let mut secret = [0_u8; 32];
    rng.fill_bytes(&mut secret);
    let groups = [GroupSpec {
        threshold: 2,
        count: 3,
    }; 2];
    let made = slip39::generate(
        &GenerateParams {
            group_threshold: 2,
            groups: &groups,
            master_secret: &secret,
            passphrase: "",
            iteration_exponent: 1,
            extendable: true,
        },
        rng,
    )
    .expect("generates");
    let mnemonics: Vec<String> = made.iter().flat_map(|g| g[..2].to_vec()).collect();
    let payload = json!({"written": "natively", "note": "é 日本語 🔐", "n": 3});
    let mut nonce = [0_u8; 24];
    rng.fill_bytes(&mut nonce);
    let bundle = RecoveryBundle::seal(signed, &secret, nonce, payload.to_string().as_bytes())
        .expect("seals");
    (bundle.to_value(), payload, mnemonics)
}

fn releases(ts: &TsOut, rng: &mut impl RngCore) -> Vec<Value> {
    let recipient = b64url_decode(&ts.recipient.public_key).unwrap();
    ts.fixture
        .guardians
        .iter()
        .map(|g| {
            let (enc, ciphertext) = seal_base(
                rng,
                &recipient,
                RELEASE_INFO.as_bytes(),
                &release_aad(&ts.release_digest, &g.id),
                g.mnemonic.as_bytes(),
                HpkeAead::Aes128Gcm,
            )
            .expect("seals to the recipient");
            json!({
                "guardianId": g.id,
                "enc": b64url_encode(&enc),
                "ciphertext": b64url_encode(&ciphertext),
            })
        })
        .collect()
}

#[test]
#[ignore = "needs OPENSESAME_QUORUM_INTEROP_DIR; scripts/test/quorum-recovery-interop.sh runs it"]
fn opens_what_typescript_wrote_and_writes_what_typescript_opens() {
    let dir = dir();
    let ts: TsOut =
        serde_json::from_str(&std::fs::read_to_string(dir.join("ts-out.json")).unwrap())
            .expect("ts-out.json parses");

    assert_opens(&ts.fixture);
    assert_opens(&ts.epoch2);
    let second = bundle_of(&ts.epoch2).signed_policy.policy;
    assert_eq!(second.epoch, 2);
    assert!(second.supersedes.is_some_and(|s| s.epoch == 1));

    let mut rng = rand::rngs::OsRng;
    let (bundle, payload, mnemonics) = rust_bundle(&ts, &mut rng);
    let out = json!({
        "bundle": bundle,
        "payload": payload,
        "mnemonics": mnemonics,
        "releases": releases(&ts, &mut rng),
    });
    std::fs::write(dir.join("rust-out.json"), out.to_string()).unwrap();
}
