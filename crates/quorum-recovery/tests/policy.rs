//! The signed policy, natively: what `policy.ts` accepts is accepted and each
//! rule it enforces is enforced here, on policies built and signed in this
//! file (the committed fixture covers the accepted shape from TypeScript).

use ed25519_dalek::{Signer, SigningKey};
use opensesame_quorum_recovery::encoding::b64url_encode;
use opensesame_quorum_recovery::policy::{bytes_to_sign, policy_digest, verify_signed_policy};
use opensesame_quorum_recovery::{share_commitment, PolicyError};
use serde_json::{json, Value};

fn owner() -> SigningKey {
    SigningKey::from_bytes(&[7; 32])
}

fn guardian(id: &str, credential: &str) -> Value {
    json!({
        "id": id,
        "name": id.to_uppercase(),
        "contactRef": null,
        "custodyDomain": format!("home-{id}"),
        "hpkePublicKey": b64url_encode(&[1; 32]),
        "credentials": [{
            "credentialId": credential,
            "publicKey": "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE",
            "alg": -7,
            "label": "Security key",
            "prf": true,
            "addedAt": "2026-10-10T12:00:00.000Z"
        }]
    })
}

/// A sound 2-of-3 circle that recovers a collection.
fn policy() -> Value {
    let ids = ["ada", "ben", "cy"];
    let commitments: serde_json::Map<String, Value> = ids
        .iter()
        .map(|id| {
            (
                (*id).to_owned(),
                json!(share_commitment("c-test", id, "a share")),
            )
        })
        .collect();
    json!({
        "v": 1,
        "circleId": "c-test",
        "epoch": 1,
        "label": "Family",
        "collection": "Family emergency",
        "rpId": "vault.example.test",
        "origins": ["https://vault.example.test", "https://app.vault.example.test"],
        "ownerKey": b64url_encode(owner().verifying_key().as_bytes()),
        "groupThreshold": 1,
        "groups": [{"id": "all", "threshold": 2, "guardianIds": ids}],
        "guardians": [guardian("ada", "cred-a"), guardian("ben", "cred-b"), guardian("cy", "cred-c")],
        "shareCommitments": commitments,
        "operations": ["recover-collection"],
        "approvalWindowSec": 900,
        "releaseDelaySec": 86400,
        "requestLifetimeSec": 604_800,
        "requireUserVerification": true,
        "createdAt": "2026-10-10T12:00:00.000Z"
    })
}

fn sign(policy: &Value, key: &SigningKey) -> Value {
    // A policy the canonical form refuses (a float) is signed over nothing; it
    // must be refused as malformed before any signature is looked at.
    let digest = policy_digest(policy).unwrap_or_else(|_| format!("sha256:{}", "0".repeat(64)));
    let signature = key.sign(&bytes_to_sign(&digest));
    json!({
        "policy": policy,
        "digest": digest,
        "signature": b64url_encode(&signature.to_bytes()),
    })
}

fn signed(change: impl FnOnce(&mut Value)) -> Value {
    let mut p = policy();
    change(&mut p);
    sign(&p, &owner())
}

fn refused(change: impl FnOnce(&mut Value)) -> PolicyError {
    verify_signed_policy(&signed(change), None).unwrap_err()
}

fn code(error: &PolicyError) -> &'static str {
    match error {
        PolicyError::Unsound { code, .. } => code,
        other => panic!("not an unsound policy: {other}"),
    }
}

#[test]
fn accepts_a_sound_signed_policy_and_keeps_the_document() {
    let document = signed(|_| {});
    let verified = verify_signed_policy(&document, None).unwrap();
    assert_eq!(verified.policy.circle_id, "c-test");
    assert_eq!(verified.document(), &document);
    assert!(verify_signed_policy(&document, Some(&verified.policy.owner_key)).is_ok());
}

#[test]
fn key_order_and_whitespace_do_not_change_the_digest() {
    let document = signed(|_| {});
    let text = serde_json::to_string_pretty(&document).unwrap();
    let reparsed: Value = serde_json::from_str(&text).unwrap();
    assert!(verify_signed_policy(&reparsed, None).is_ok());
}

#[test]
fn the_chain_rules() {
    assert_eq!(
        code(&refused(
            |p| p["supersedes"] =
                json!({"epoch": 1, "digest": format!("sha256:{}", "a".repeat(64))})
        )),
        "chain"
    );
    assert_eq!(code(&refused(|p| p["epoch"] = json!(2))), "chain");
    assert_eq!(
        code(&refused(|p| {
            p["epoch"] = json!(3);
            p["supersedes"] = json!({"epoch": 1, "digest": format!("sha256:{}", "a".repeat(64))});
        })),
        "chain"
    );
    let later = signed(|p| {
        p["epoch"] = json!(2);
        p["supersedes"] = json!({"epoch": 1, "digest": format!("sha256:{}", "a".repeat(64))});
    });
    assert_eq!(verify_signed_policy(&later, None).unwrap().policy.epoch, 2);
}

#[test]
fn the_graph_rules() {
    let dup = refused(|p| p["guardians"][1]["id"] = json!("ada"));
    assert_eq!(code(&dup), "duplicate_guardian");
    let two = refused(|p| {
        p["groups"] = json!([
            {"id": "x", "threshold": 2, "guardianIds": ["ada", "ben"]},
            {"id": "y", "threshold": 2, "guardianIds": ["ben", "cy"]},
        ]);
    });
    assert_eq!(code(&two), "guardian_in_two_groups");
    let stranger = refused(|p| p["groups"][0]["guardianIds"] = json!(["ada", "ben", "zed"]));
    assert_eq!(code(&stranger), "group_membership");
    let left_out = refused(|p| p["groups"][0]["guardianIds"] = json!(["ada", "ben"]));
    assert_eq!(code(&left_out), "group_membership");
    assert_eq!(
        code(&refused(|p| p["groupThreshold"] = json!(2))),
        "group_threshold"
    );
    assert_eq!(
        code(&refused(|p| p["groups"][0]["threshold"] = json!(4))),
        "member_threshold"
    );
    assert_eq!(
        code(&refused(|p| p["groups"][0]["threshold"] = json!(1))),
        "member_threshold_one"
    );
}

#[test]
fn the_credential_rules() {
    let shared = refused(|p| p["guardians"][1]["credentials"][0]["credentialId"] = json!("cred-a"));
    assert_eq!(code(&shared), "shared_credential");
    let no_prf = refused(|p| p["guardians"][2]["credentials"][0]["prf"] = json!(false));
    assert_eq!(code(&no_prf), "no_prf");
    assert!(no_prf.to_string().contains("CY"));
    let missing = refused(|p| {
        p["shareCommitments"].as_object_mut().unwrap().remove("cy");
    });
    assert_eq!(code(&missing), "commitments");
    // A circle that only approves actions holds no shares, and says so.
    let action_only = signed(|p| {
        p["operations"] = json!(["grant-access"]);
        p["shareCommitments"] = json!({});
        p["guardians"][2]["credentials"][0]["prf"] = json!(false);
    });
    assert!(verify_signed_policy(&action_only, None).is_ok());
    let committed_anyway = refused(|p| p["operations"] = json!(["grant-access"]));
    assert_eq!(code(&committed_anyway), "commitments");
}

#[test]
fn the_origin_and_timing_rules() {
    let elsewhere = refused(|p| p["origins"] = json!(["https://evil.example.test"]));
    assert_eq!(code(&elsewhere), "rp_id");
    let suffix = refused(|p| p["origins"] = json!(["https://notvault.example.test"]));
    assert_eq!(code(&suffix), "rp_id");
    assert_eq!(
        code(&refused(|p| p["requestLifetimeSec"] = json!(600))),
        "lifetime"
    );
    assert_eq!(
        code(&refused(|p| p["releaseDelaySec"] = json!(604_800))),
        "lifetime"
    );
}

#[test]
fn malformed_policies_are_refused_before_anything_else() {
    for change in [
        |p: &mut Value| p["extra"] = json!(1),
        |p: &mut Value| p["v"] = json!(2),
        |p: &mut Value| p["circleId"] = json!("has space"),
        |p: &mut Value| p["epoch"] = json!(0),
        |p: &mut Value| p["groupThreshold"] = json!(0),
        |p: &mut Value| p["approvalWindowSec"] = json!(59),
        |p: &mut Value| p["approvalWindowSec"] = json!(900.5),
        |p: &mut Value| p["createdAt"] = json!("yesterday"),
        |p: &mut Value| p["operations"] = json!([]),
        |p: &mut Value| p["operations"] = json!(["launch-missiles"]),
        |p: &mut Value| p["guardians"][0]["credentials"] = json!([]),
        |p: &mut Value| p["guardians"][0]["credentials"][0]["alg"] = json!(-257),
        |p: &mut Value| p["shareCommitments"]["ada"] = json!("sha256:abc"),
        |p: &mut Value| p["supersedes"] = Value::Null,
        |p: &mut Value| p["origins"] = json!([]),
    ] {
        let error = refused(change);
        assert!(matches!(error, PolicyError::Malformed(_)), "{error}");
    }
}

#[test]
fn a_document_that_is_not_a_signed_policy_is_malformed() {
    for document in [
        json!(null),
        json!({}),
        json!({"policy": {}, "digest": "x", "signature": "y"}),
    ] {
        assert!(matches!(
            verify_signed_policy(&document, None).unwrap_err(),
            PolicyError::Malformed(_)
        ));
    }
    let mut extra = signed(|_| {});
    extra["note"] = json!("unsigned extra");
    assert!(matches!(
        verify_signed_policy(&extra, None).unwrap_err(),
        PolicyError::Malformed(_)
    ));
}

#[test]
fn the_digest_the_signature_and_the_pinned_key_are_each_checked() {
    let mut edited = signed(|_| {});
    edited["policy"]["label"] = json!("Changed after signing");
    assert_eq!(
        verify_signed_policy(&edited, None).unwrap_err(),
        PolicyError::DigestMismatch
    );

    let stranger = SigningKey::from_bytes(&[9; 32]);
    let forged = sign(&policy(), &stranger);
    assert_eq!(
        verify_signed_policy(&forged, None).unwrap_err(),
        PolicyError::BadSignature
    );

    let genuine = signed(|_| {});
    let other = b64url_encode(stranger.verifying_key().as_bytes());
    assert_eq!(
        verify_signed_policy(&genuine, Some(&other)).unwrap_err(),
        PolicyError::OwnerKeyChanged
    );

    let mut short = signed(|_| {});
    short["signature"] = json!(b64url_encode(&[1; 10]));
    assert_eq!(
        verify_signed_policy(&short, None).unwrap_err(),
        PolicyError::BadSignature
    );
}
