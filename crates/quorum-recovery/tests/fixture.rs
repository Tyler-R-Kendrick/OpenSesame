//! The committed fixture, `spec/conformance/quorum-recovery-fixture.json`, made
//! by the TypeScript suite `recovery-fixture.test.ts` and opened here with the
//! native reader (ADR 0187 follow-up 3). Its keys are test-only.

mod common;

use common::{assert_opens, bundle_of, committed, mnemonics_of, quorum_mnemonics, Fixture};
use opensesame_quorum_recovery::slip39::{self, Slip39Error};
use opensesame_quorum_recovery::{recover, BundleError, PolicyError, RecoverError, RecoveryBundle};
use serde_json::{json, Value};

#[test]
fn says_its_keys_are_test_only() {
    assert!(committed().about.starts_with("Test-only keys"));
}

#[test]
fn opens_natively_end_to_end() {
    assert_opens(&committed());
}

#[test]
fn matches_each_share_to_its_guardian_by_the_owners_commitment() {
    let fixture = committed();
    let bundle = bundle_of(&fixture);
    let recovered = recover(&bundle, &quorum_mnemonics(&fixture)).unwrap();
    let names: Vec<(String, String)> = recovered
        .shares
        .iter()
        .map(|m| {
            let g = m.guardian.as_ref().expect("matched");
            (g.name.clone(), g.group_id.clone())
        })
        .collect();
    assert_eq!(
        names,
        [
            ("Ada", "family"),
            ("Cy", "family"),
            ("Eli", "friends"),
            ("Fay", "friends")
        ]
        .map(|(n, g)| (n.to_owned(), g.to_owned()))
    );
}

#[test]
fn a_share_nobody_committed_to_matches_no_guardian() {
    let fixture = committed();
    let bundle = bundle_of(&fixture);
    let mut mnemonics = quorum_mnemonics(&fixture);
    mnemonics[0] = format!("  {}  ", mnemonics[0].to_uppercase());
    let matches =
        opensesame_quorum_recovery::match_shares(&bundle.signed_policy.policy, &mnemonics);
    assert_eq!(
        matches[0].guardian.as_ref().map(|g| g.id.as_str()),
        Some("ada"),
        "case and spacing do not matter, as in the commitment"
    );
    let stranger = "academic ".repeat(20);
    let matches =
        opensesame_quorum_recovery::match_shares(&bundle.signed_policy.policy, &[stranger]);
    assert!(matches[0].guardian.is_none());
}

#[test]
fn other_quorums_recombine_too() {
    let fixture = committed();
    let bundle = bundle_of(&fixture);
    for ids in [["ben", "cy", "dee", "eli"], ["ada", "ben", "dee", "fay"]] {
        let recovered = recover(&bundle, &mnemonics_of(&fixture, &ids)).unwrap();
        assert_eq!(recovered.payload.expose(), fixture.payload_text.as_bytes());
    }
}

#[test]
fn less_than_a_quorum_and_more_than_one_asks_for_are_refused() {
    let fixture = committed();
    let bundle = bundle_of(&fixture);
    let refused = |ids: &[&str]| recover(&bundle, &mnemonics_of(&fixture, ids)).unwrap_err();
    assert!(matches!(
        refused(&["ada", "cy"]),
        RecoverError::Shares(Slip39Error::GroupCount {
            expected: 2,
            got: 1
        })
    ));
    assert!(matches!(
        refused(&["ada", "cy", "eli"]),
        RecoverError::Shares(Slip39Error::GroupSize { .. })
    ));
    assert!(matches!(
        refused(&["ada", "ben", "cy", "eli", "fay"]),
        RecoverError::Shares(Slip39Error::GroupSize { .. })
    ));
}

#[test]
fn another_circles_shares_do_not_open_this_bundle() {
    let fixture = committed();
    let bundle = bundle_of(&fixture);
    // A valid SLIP-0039 set from a different backup: it recombines, and the
    // secret it gives is not this circle's.
    let mut rng = rand::rngs::OsRng;
    let groups = [slip39::GroupSpec {
        threshold: 2,
        count: 3,
    }];
    let made = slip39::generate(
        &slip39::GenerateParams {
            group_threshold: 1,
            groups: &groups,
            master_secret: &[7; 32],
            passphrase: "",
            iteration_exponent: 1,
            extendable: true,
        },
        &mut rng,
    )
    .unwrap();
    let error = recover(&bundle, &made[0][..2]).unwrap_err();
    assert_eq!(error, RecoverError::Bundle(BundleError::Open));
}

fn with_bundle(fixture: &Fixture, change: impl FnOnce(&mut Value)) -> Value {
    let mut bundle = fixture.bundle.clone();
    change(&mut bundle);
    bundle
}

#[test]
fn a_changed_bundle_is_refused_where_it_is_changed() {
    let fixture = committed();
    let pin = Some(fixture.owner_public_key.as_str());
    let parse = |v: &Value| RecoveryBundle::from_value(v, pin).unwrap_err();

    // The policy is signed: any edit to it breaks the digest.
    let edited = with_bundle(&fixture, |b| {
        b["signedPolicy"]["policy"]["label"] = json!("Not the family");
    });
    assert_eq!(
        parse(&edited),
        BundleError::Policy(PolicyError::DigestMismatch)
    );

    // A policy someone else signed does not match the owner key we hold.
    assert_eq!(
        RecoveryBundle::from_value(&fixture.bundle, Some("AAAA")).unwrap_err(),
        BundleError::Policy(PolicyError::OwnerKeyChanged)
    );

    // A different signature does not verify.
    let resigned = with_bundle(&fixture, |b| {
        let sig = b["signedPolicy"]["signature"].as_str().unwrap().to_owned();
        let flipped = if sig.starts_with('A') { 'B' } else { 'A' };
        b["signedPolicy"]["signature"] = json!(format!("{flipped}{}", &sig[1..]));
    });
    assert_eq!(
        parse(&resigned),
        BundleError::Policy(PolicyError::BadSignature)
    );

    // Fields the schema does not know, a wrong version and bad encodings.
    for change in [
        |b: &mut Value| b["extra"] = json!(1),
        |b: &mut Value| b["v"] = json!(2),
        |b: &mut Value| b["nonce"] = json!("not base64!"),
        |b: &mut Value| b["ciphertext"] = json!(""),
        |b: &mut Value| b["signedPolicy"]["policy"]["extra"] = json!(true),
    ] {
        assert!(matches!(
            parse(&with_bundle(&fixture, change)),
            BundleError::Malformed(_) | BundleError::Policy(PolicyError::Malformed(_))
        ));
    }
}

#[test]
fn a_changed_ciphertext_or_nonce_does_not_authenticate() {
    let fixture = committed();
    let secret = {
        let mnemonics = quorum_mnemonics(&fixture);
        slip39::combine(&mnemonics, &slip39::CombineOptions::default()).unwrap()
    };
    for field in ["ciphertext", "nonce"] {
        let changed = with_bundle(&fixture, |b| {
            let text = b[field].as_str().unwrap().to_owned();
            let flipped = if text.starts_with('A') { 'B' } else { 'A' };
            b[field] = json!(format!("{flipped}{}", &text[1..]));
        });
        let bundle = RecoveryBundle::from_value(&changed, None).unwrap();
        assert_eq!(bundle.open(secret.expose()).unwrap_err(), BundleError::Open);
    }
}

#[test]
fn a_bundle_round_trips_through_its_own_json() {
    let fixture = committed();
    let bundle = bundle_of(&fixture);
    assert_eq!(bundle.to_value(), fixture.bundle);
}
