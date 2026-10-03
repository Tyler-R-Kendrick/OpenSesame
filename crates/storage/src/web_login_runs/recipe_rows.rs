//! What a stored recipe is, how it is read back, and the writes behind
//! [`super::recipes`]: the record, the verification a write carries, the
//! outcomes, and the SQL for a compare-and-set insert and update. The rule that
//! makes a recipe replayable lives with the `Db` methods in `recipes`.

use sqlx::{sqlite::SqliteRow, Row};

/// Recipes one listing returns. Far above any organization's real set.
pub const MAX_LISTED_RECIPES: i64 = 500;

/// One stored recipe, as written by this module.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredRecipeRecord {
    pub organization_id: String,
    pub origin: String,
    pub recipe_id: String,
    /// `candidate`, `canary_verified` or `corpus`. Derived, never supplied.
    pub trust: String,
    /// The operator-edit counter: 1 on the first write, +1 on each one after.
    /// A run recording its canary does not move it.
    pub version: i64,
    /// The whole document as stored, signature included. `None` on a row
    /// written before recipes had a writer; such a row is never replayable.
    pub document_json: Option<String>,
    /// The executor's projection of the document, which a run replays.
    pub recipe_json: String,
    /// `sha256:` of the document's signed form.
    pub digest: Option<String>,
    pub signer_key_id: Option<String>,
    /// When the Host verified the signature. Set only by verification.
    pub verified_at: Option<String>,
    /// `passed` or `failed`, or `None` when no canary has been seen.
    pub canary_result: Option<String>,
    pub canary_at: Option<String>,
    pub canary_run_id: Option<String>,
    /// `signed` (the document's attestation) or `run` (the Host's own run).
    pub canary_source: Option<String>,
    pub expires_at: String,
    pub created_at: String,
    pub updated_at: String,
    pub updated_by: String,
}

/// The audit event committed with a change, in the same transaction as it.
pub struct RecipeAudit<'a> {
    pub event_type: &'a str,
    pub payload_json: &'a str,
}

/// What the Host verified about a document before writing it.
pub struct RecipeVerification<'a> {
    /// The pinned signer whose signature checked.
    pub signer_key_id: &'a str,
    pub verified_at: &'a str,
    /// The canary the signed document attests, when it carries one.
    pub canary_attested_at: Option<&'a str>,
}

/// A recipe to store.
pub struct RecipeWrite<'a> {
    pub organization_id: &'a str,
    pub origin: &'a str,
    pub recipe_id: &'a str,
    pub document_json: &'a str,
    pub recipe_json: &'a str,
    pub digest: &'a str,
    pub expires_at: &'a str,
    /// `None` stores a `candidate`.
    pub verification: Option<RecipeVerification<'a>>,
    /// The version this was made against; 0 when nothing is stored yet.
    pub expected_version: i64,
    pub updated_by: &'a str,
    pub now: &'a str,
}

/// How a write ended.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RecipeWriteOutcome {
    Written(Box<StoredRecipeRecord>),
    /// Another write landed first; nothing changed.
    Conflict {
        current_version: i64,
    },
    /// The signer was revoked (or never pinned) between verification and the
    /// write; nothing changed.
    SignerNotPinned,
}

/// How a delete ended.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RecipeDeleteOutcome {
    Deleted,
    NotFound,
    Conflict { current_version: i64 },
}

/// Who is asking for a recipe to replay.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RecipeUse<'a> {
    /// A person is driving: a verified recipe suffices.
    Attended,
    /// Nobody is watching: the recipe also needs a passing canary no older
    /// than `canary_not_before`.
    Unattended { canary_not_before: &'a str },
}

/// A recipe a run may replay, and the signer's key as it stands now, for the
/// run to check the signature against again.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RunnableRecipe {
    pub record: StoredRecipeRecord,
    pub signer_public_key: String,
}

/// What a run proved about the recipe it replayed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RunResult {
    /// The change was accepted and a fresh login confirmed it.
    Passed,
    /// The page did not match the recipe, or the change could not be
    /// confirmed: the recipe is no longer proven.
    Failed,
}

pub(super) const RECIPE_COLUMNS: &str =
    "organization_id, origin, recipe_id, trust, version, document_json, \
     recipe_json, digest, signer_key_id, verified_at, canary_result, canary_at, canary_run_id, \
     canary_source, expires_at, created_at, updated_at, updated_by";

pub(super) const RUNNABLE_COLUMNS: &str =
    "r.organization_id, r.origin, r.recipe_id, r.trust, r.version, \
     r.document_json, r.recipe_json, r.digest, r.signer_key_id, r.verified_at, r.canary_result, \
     r.canary_at, r.canary_run_id, r.canary_source, r.expires_at, r.created_at, r.updated_at, \
     r.updated_by";

pub(super) fn record_from_row(row: &SqliteRow) -> anyhow::Result<StoredRecipeRecord> {
    Ok(StoredRecipeRecord {
        organization_id: row.try_get("organization_id")?,
        origin: row.try_get("origin")?,
        recipe_id: row.try_get("recipe_id")?,
        trust: row.try_get("trust")?,
        version: row.try_get("version")?,
        document_json: row.try_get("document_json")?,
        recipe_json: row.try_get("recipe_json")?,
        digest: row.try_get("digest")?,
        signer_key_id: row.try_get("signer_key_id")?,
        verified_at: row.try_get("verified_at")?,
        canary_result: row.try_get("canary_result")?,
        canary_at: row.try_get("canary_at")?,
        canary_run_id: row.try_get("canary_run_id")?,
        canary_source: row.try_get("canary_source")?,
        expires_at: row.try_get("expires_at")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
        updated_by: row.try_get("updated_by")?,
    })
}

/// The canary a write leaves on the row: `(result, at, run, source, trust)`.
pub(super) type Canary = (
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    &'static str,
);

/// Derive trust and the canary columns from what was verified and what the
/// row already proved. A signed attestation wins; failing that, a run's own
/// proof carries over only for the very same steps.
pub(super) fn derive_canary(
    write: &RecipeWrite<'_>,
    existing: Option<&StoredRecipeRecord>,
) -> Canary {
    let Some(verification) = &write.verification else {
        return (None, None, None, None, "candidate");
    };
    if let Some(at) = verification.canary_attested_at {
        let passed = Some("passed".to_owned());
        return (
            passed,
            Some(at.to_owned()),
            None,
            Some("signed".into()),
            "canary_verified",
        );
    }
    match existing {
        Some(old)
            if old.recipe_json == write.recipe_json
                && old.canary_result.as_deref() == Some("passed")
                && old.canary_source.as_deref() == Some("run") =>
        {
            (
                old.canary_result.clone(),
                old.canary_at.clone(),
                old.canary_run_id.clone(),
                old.canary_source.clone(),
                "canary_verified",
            )
        }
        _ => (None, None, None, None, "candidate"),
    }
}

pub(super) async fn read_recipe<'e, E>(
    executor: E,
    organization_id: &str,
    origin: &str,
) -> anyhow::Result<Option<StoredRecipeRecord>>
where
    E: sqlx::Executor<'e, Database = sqlx::Sqlite>,
{
    // ast-grep-ignore: sql-format-injection
    let sql = format!(
        "SELECT {RECIPE_COLUMNS} FROM web_login_recipes WHERE organization_id = ? AND origin = ?"
    );
    sqlx::query(&sql)
        .bind(organization_id)
        .bind(origin)
        .fetch_optional(executor)
        .await?
        .as_ref()
        .map(record_from_row)
        .transpose()
}

pub(super) async fn insert(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    write: &RecipeWrite<'_>,
    canary: &Canary,
) -> anyhow::Result<u64> {
    let verification = write.verification.as_ref();
    let done = sqlx::query(
        "INSERT INTO web_login_recipes \
         (organization_id, origin, recipe_id, trust, version, document_json, recipe_json, digest, \
          signer_key_id, verified_at, canary_result, canary_at, canary_run_id, canary_source, \
          expires_at, created_at, updated_at, updated_by) \
         VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) \
         ON CONFLICT(organization_id, origin) DO NOTHING",
    )
    .bind(write.organization_id)
    .bind(write.origin)
    .bind(write.recipe_id)
    .bind(canary.4)
    .bind(write.document_json)
    .bind(write.recipe_json)
    .bind(write.digest)
    .bind(verification.map(|v| v.signer_key_id))
    .bind(verification.map(|v| v.verified_at))
    .bind(&canary.0)
    .bind(&canary.1)
    .bind(&canary.2)
    .bind(&canary.3)
    .bind(write.expires_at)
    .bind(write.now)
    .bind(write.now)
    .bind(write.updated_by)
    .execute(&mut **tx)
    .await?;
    Ok(done.rows_affected())
}

pub(super) async fn update(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    write: &RecipeWrite<'_>,
    canary: &Canary,
) -> anyhow::Result<u64> {
    let verification = write.verification.as_ref();
    let done = sqlx::query(
        "UPDATE web_login_recipes SET recipe_id = ?, trust = ?, version = version + 1, \
         document_json = ?, recipe_json = ?, digest = ?, signer_key_id = ?, verified_at = ?, \
         canary_result = ?, canary_at = ?, canary_run_id = ?, canary_source = ?, \
         expires_at = ?, updated_at = ?, updated_by = ? \
         WHERE organization_id = ? AND origin = ? AND version = ?",
    )
    .bind(write.recipe_id)
    .bind(canary.4)
    .bind(write.document_json)
    .bind(write.recipe_json)
    .bind(write.digest)
    .bind(verification.map(|v| v.signer_key_id))
    .bind(verification.map(|v| v.verified_at))
    .bind(&canary.0)
    .bind(&canary.1)
    .bind(&canary.2)
    .bind(&canary.3)
    .bind(write.expires_at)
    .bind(write.now)
    .bind(write.updated_by)
    .bind(write.organization_id)
    .bind(write.origin)
    .bind(write.expected_version)
    .execute(&mut **tx)
    .await?;
    Ok(done.rows_affected())
}
