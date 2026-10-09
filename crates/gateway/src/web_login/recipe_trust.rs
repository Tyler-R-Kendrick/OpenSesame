//! The recipe a run may replay, and the proof it is entitled to (ADR 0076 §4,
//! ADR 0159).
//!
//! The store hands back a row only when its signer is pinned and unrevoked
//! *now* and the row is unexpired, and — for an unattended run — carries a
//! fresh passing canary. This module then trusts nothing the row says about
//! itself. It reads the stored document, checks the signature against the
//! signer's key as the store holds it today, checks the document is the very
//! one the row's digest names and is itself unexpired, and takes the steps to
//! replay from the document and from nowhere else. A row edited behind the Host's back, a
//! document swapped under a verified digest, or a signature that no longer
//! checks is "no verified recipe", the same as none.
//!
//! *Attended* and *unattended* are the caller's statement, not the recipe's:
//! a run started by the lifecycle scanner nobody is watching is unattended;
//! one a person asked for, and drives, is attended. The first canary can only
//! be attended, which is the whole reason the two differ.

use chrono::{DateTime, Duration, Utc};
use opensesame_rotation_web::recipe_doc::{
    parse_public_key_hex, RecipeDocument, CANARY_MAX_AGE_DAYS,
};
use opensesame_storage::web_login_runs::recipes::{RecipeUse, StoredRecipeRecord};
use opensesame_storage::Db;

/// Whether a person is driving the run.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Attendance {
    /// A person asked for this run and holds its page.
    Attended,
    /// Nobody is watching: the lifecycle scanner started it.
    Unattended,
}

/// A recipe whose signature has just been checked.
#[derive(Debug)]
pub(crate) struct VerifiedRecipe {
    pub record: StoredRecipeRecord,
    pub document: RecipeDocument,
}

/// Why no recipe may run.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Unrunnable {
    /// The store could not be read.
    Unreadable,
    /// Absent, unverified, expired, or signed by a key no longer pinned.
    NoRecipe,
    /// Verified, but nothing has proven it by a real change yet (or not
    /// lately), and nobody is driving.
    NoCanary,
    /// The stored document is not a recipe this build reads.
    Invalid,
}

/// The recipe `attendance` may replay for `origin` at `now`.
///
/// # Errors
///
/// [`Unrunnable`] naming why not.
pub(crate) async fn verified_recipe(
    db: &Db,
    organization_id: &str,
    origin: &str,
    attendance: Attendance,
    now: DateTime<Utc>,
) -> Result<VerifiedRecipe, Unrunnable> {
    let at = now.to_rfc3339();
    let cutoff = (now - Duration::days(CANARY_MAX_AGE_DAYS)).to_rfc3339();
    let usage = match attendance {
        Attendance::Attended => RecipeUse::Attended,
        Attendance::Unattended => RecipeUse::Unattended {
            canary_not_before: &cutoff,
        },
    };
    let found = db
        .runnable_web_login_recipe(organization_id, origin, &at, usage)
        .await
        .map_err(|_| Unrunnable::Unreadable)?;
    let Some(found) = found else {
        // Say which of the two it was, so a person knows what to do next.
        if attendance == Attendance::Unattended {
            let attended = db
                .runnable_web_login_recipe(organization_id, origin, &at, RecipeUse::Attended)
                .await
                .map_err(|_| Unrunnable::Unreadable)?;
            if attended.is_some() {
                return Err(Unrunnable::NoCanary);
            }
        }
        return Err(Unrunnable::NoRecipe);
    };
    let record = found.record;
    let document = record
        .document_json
        .as_deref()
        .ok_or(Unrunnable::NoRecipe)
        .and_then(|text| RecipeDocument::parse(text.as_bytes()).map_err(|_| Unrunnable::Invalid))?;
    let key = parse_public_key_hex(&found.signer_public_key).map_err(|_| Unrunnable::NoRecipe)?;
    let named_by_the_row = record.signer_key_id.as_deref();
    // The expiry that counts is the one the signer signed, not the column
    // the store keeps beside it for indexing.
    let unexpired = DateTime::parse_from_rfc3339(&document.expires_at)
        .is_ok_and(|expires| expires.with_timezone(&Utc) > now);
    let proven = document.verify(&key).is_ok()
        && document.signer_key_id().ok() == named_by_the_row
        && document.digest().ok() == record.digest
        && document.origin == origin
        && unexpired;
    if !proven {
        return Err(Unrunnable::NoRecipe);
    }
    Ok(VerifiedRecipe { record, document })
}
