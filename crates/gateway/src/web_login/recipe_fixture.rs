//! A recipe a run may replay, built the way production builds one: a signer
//! the organization pinned, a document that signer signed, and the store's own
//! writer deriving its trust. Tests seed through this rather than writing a
//! trust level into a row, so what they exercise is the rule the runner
//! enforces.

use chrono::{Duration, Utc};
use opensesame_rotation_web::recipe_doc::{
    key_id_of, CanaryAttestation, RecipeDocument, SigningKey, SCHEMA_VERSION,
};
use opensesame_rotation_web::ChangePasswordRecipe;
use opensesame_storage::web_login_runs::recipes::{
    RecipeAudit, RecipeVerification, RecipeWrite, RecipeWriteOutcome,
};
use opensesame_storage::web_login_runs::signers::SignerPin;
use opensesame_storage::Db;

/// The signer every fixture recipe is signed by.
pub(crate) fn signer() -> SigningKey {
    SigningKey::from_bytes(&[42; 32])
}

/// A signed recipe document for `origin`, carrying a canary attestation when
/// `attested`.
pub(crate) fn document(origin: &str, attested: bool) -> RecipeDocument {
    let now = Utc::now();
    let mut document = RecipeDocument {
        schema_version: SCHEMA_VERSION,
        recipe_id: "rcp_login_example".into(),
        origin: origin.into(),
        expires_at: (now + Duration::days(30)).to_rfc3339(),
        change_password: ChangePasswordRecipe {
            change_url: format!("{origin}/.well-known/change-password"),
            current_password_selector: Some("#current".into()),
            new_password_selector: "#new".into(),
            confirm_password_selector: Some("#confirm".into()),
            submit_selector: "#save".into(),
        },
        canary: attested.then(|| CanaryAttestation {
            verified_at: now.to_rfc3339(),
        }),
        signature: None,
    };
    document.sign(&signer()).expect("a fixture document signs");
    document
}

/// Pin the fixture signer (once) and store a signed recipe for `origin`.
pub(crate) async fn seed(db: &Db, organization_id: &str, origin: &str, attested: bool) {
    let now = Utc::now().to_rfc3339();
    let key = signer().verifying_key();
    let key_id = key_id_of(&key);
    let audit = RecipeAudit {
        event_type: "web_login.fixture",
        payload_json: "{}",
    };
    // Already pinned by an earlier site is fine; a revoked fixture key is not.
    db.pin_web_login_recipe_signer(
        &SignerPin {
            organization_id,
            key_id: &key_id,
            public_key: &hex::encode(key.as_bytes()),
            label: "fixture signer",
            pinned_by: "operator",
            pinned_at: &now,
        },
        &audit,
    )
    .await
    .expect("the fixture signer pins");
    let document = document(origin, attested);
    let canary = document
        .canary
        .as_ref()
        .map(|canary| canary.verified_at.clone());
    let written = db
        .put_web_login_recipe_document(
            &RecipeWrite {
                organization_id,
                origin,
                recipe_id: &document.recipe_id,
                document_json: &serde_json::to_string(&document).unwrap(),
                recipe_json: &serde_json::to_string(document.steps()).unwrap(),
                digest: &document.digest().unwrap(),
                expires_at: &document.expires_at,
                verification: Some(RecipeVerification {
                    signer_key_id: &key_id,
                    verified_at: &now,
                    canary_attested_at: canary.as_deref(),
                }),
                expected_version: 0,
                updated_by: "operator",
                now: &now,
            },
            &audit,
        )
        .await
        .expect("the fixture recipe is stored");
    assert!(matches!(written, RecipeWriteOutcome::Written(_)));
}
