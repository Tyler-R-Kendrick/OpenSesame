//! What the recipe tests share: one organization and origin, the audit every
//! write commits, and the helpers that pin a signer, write a recipe and ask
//! whether a run may replay it.

#![allow(dead_code)]

use opensesame_storage::web_login_runs::recipes::{
    RecipeAudit, RecipeUse, RecipeVerification, RecipeWrite, RecipeWriteOutcome, StoredRecipeRecord,
};
use opensesame_storage::web_login_runs::signers::{SignerPin, SignerPinOutcome};
use opensesame_storage::Db;

pub const ORG: &str = "org:one";
pub const ORIGIN: &str = "https://login.example";
pub const NOW: &str = "2026-10-01T00:00:00+00:00";
pub const LATER: &str = "2026-10-02T00:00:00+00:00";
pub const EXPIRES: &str = "2026-12-01T00:00:00+00:00";
pub const KEY: &str = "rsk_0123456789abcdef0123456789abcdef";
pub const PUBLIC: &str = "aa00000000000000000000000000000000000000000000000000000000000000";
pub const AUDIT: RecipeAudit<'static> = RecipeAudit {
    event_type: "web_login.recipe.test",
    payload_json: "{}",
};

pub async fn audit_rows(db: &Db) -> i64 {
    sqlx::query_scalar(
        "SELECT COUNT(*) FROM outbox_events WHERE event_type = 'web_login.recipe.test'",
    )
    .fetch_one(db.pool())
    .await
    .unwrap()
}

pub async fn pinned(db: &Db, key_id: &str) {
    let pin = SignerPin {
        organization_id: ORG,
        key_id,
        public_key: PUBLIC,
        label: "release signer",
        pinned_by: "operator",
        pinned_at: NOW,
    };
    let outcome = db.pin_web_login_recipe_signer(&pin, &AUDIT).await.unwrap();
    assert!(
        matches!(outcome, SignerPinOutcome::Pinned(_)),
        "{outcome:?}"
    );
}

pub fn write<'a>(
    verification: Option<RecipeVerification<'a>>,
    steps: &'a str,
    expected_version: i64,
) -> RecipeWrite<'a> {
    RecipeWrite {
        organization_id: ORG,
        origin: ORIGIN,
        recipe_id: "rcp_login_example",
        document_json: "{\"document\":true}",
        recipe_json: steps,
        digest: "sha256:aa",
        expires_at: EXPIRES,
        verification,
        expected_version,
        updated_by: "operator",
        now: NOW,
    }
}

pub fn verification(canary: Option<&str>) -> RecipeVerification<'_> {
    RecipeVerification {
        signer_key_id: KEY,
        verified_at: NOW,
        canary_attested_at: canary,
    }
}

pub async fn put(db: &Db, w: &RecipeWrite<'_>) -> StoredRecipeRecord {
    match db.put_web_login_recipe_document(w, &AUDIT).await.unwrap() {
        RecipeWriteOutcome::Written(row) => *row,
        other => panic!("expected a write, got {other:?}"),
    }
}

pub async fn runnable(db: &Db, usage: RecipeUse<'_>) -> bool {
    db.runnable_web_login_recipe(ORG, ORIGIN, LATER, usage)
        .await
        .unwrap()
        .is_some()
}

pub const UNATTENDED: RecipeUse<'static> = RecipeUse::Unattended {
    canary_not_before: "2026-07-01T00:00:00+00:00",
};
