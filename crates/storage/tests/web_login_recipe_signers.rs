//! The keys an organization trusts to sign web-login recipes (ADR 0076 §4,
//! ADR 0150): pinned once, revoked for good, bounded, and audited with the row.

mod recipes_support;

use opensesame_storage::web_login_runs::signers::{
    SignerPin, SignerPinOutcome, SignerRevokeOutcome, MAX_SIGNERS_PER_ORGANIZATION,
};
use opensesame_storage::Db;
use recipes_support::*;

#[tokio::test]
async fn signers_are_pinned_once_revoked_finally_and_audited() {
    let db = Db::connect_memory().await.unwrap();
    pinned(&db, KEY).await;
    let pin = SignerPin {
        organization_id: ORG,
        key_id: KEY,
        public_key: PUBLIC,
        label: "again",
        pinned_by: "operator",
        pinned_at: LATER,
    };
    assert!(matches!(
        db.pin_web_login_recipe_signer(&pin, &AUDIT).await.unwrap(),
        SignerPinOutcome::Exists(row) if row.label == "release signer"
    ));
    assert_eq!(audit_rows(&db).await, 1, "a refused pin appends nothing");

    let revoked = db
        .revoke_web_login_recipe_signer(ORG, KEY, "operator", LATER, &AUDIT)
        .await
        .unwrap();
    assert!(
        matches!(&revoked, SignerRevokeOutcome::Revoked(row) if row.revoked_by.as_deref() == Some("operator"))
    );
    assert!(matches!(
        db.revoke_web_login_recipe_signer(ORG, KEY, "operator", LATER, &AUDIT)
            .await
            .unwrap(),
        SignerRevokeOutcome::AlreadyRevoked(_)
    ));
    assert!(matches!(
        db.revoke_web_login_recipe_signer(
            ORG,
            "rsk_ffffffffffffffffffffffffffffffff",
            "operator",
            LATER,
            &AUDIT
        )
        .await
        .unwrap(),
        SignerRevokeOutcome::NotFound
    ));
    assert_eq!(audit_rows(&db).await, 2);
    assert!(
        matches!(
            db.pin_web_login_recipe_signer(&pin, &AUDIT).await.unwrap(),
            SignerPinOutcome::Exists(row) if row.revoked_at.is_some()
        ),
        "a revoked key is never pinned again"
    );

    // Organizations do not share signers.
    assert!(db
        .list_web_login_recipe_signers("org:two")
        .await
        .unwrap()
        .is_empty());
    assert_eq!(
        db.list_web_login_recipe_signers(ORG).await.unwrap().len(),
        1
    );
}

#[tokio::test]
async fn the_table_refuses_a_malformed_signer_and_bounds_how_many() {
    let db = Db::connect_memory().await.unwrap();
    for (key_id, public_key, label) in [
        ("rsk_short", PUBLIC, "x"),
        ("not_a_key_id_0123456789abcdef012345", PUBLIC, "x"),
        (KEY, "abcd", "x"),
        (KEY, PUBLIC, ""),
    ] {
        let pin = SignerPin {
            organization_id: ORG,
            key_id,
            public_key,
            label,
            pinned_by: "operator",
            pinned_at: NOW,
        };
        assert!(
            db.pin_web_login_recipe_signer(&pin, &AUDIT).await.is_err(),
            "{key_id} {label}"
        );
    }
    assert_eq!(audit_rows(&db).await, 0);

    for n in 0..MAX_SIGNERS_PER_ORGANIZATION {
        pinned(&db, &format!("rsk_{n:032x}")).await;
    }
    let pin = SignerPin {
        organization_id: ORG,
        key_id: KEY,
        public_key: PUBLIC,
        label: "one too many",
        pinned_by: "operator",
        pinned_at: NOW,
    };
    assert_eq!(
        db.pin_web_login_recipe_signer(&pin, &AUDIT).await.unwrap(),
        SignerPinOutcome::LimitReached
    );
}
