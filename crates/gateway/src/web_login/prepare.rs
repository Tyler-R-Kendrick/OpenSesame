//! What a web-login run needs before it may start, and the honest reason
//! when something is missing (ADR 0076 T5: a target with no way through
//! notifies and parks — it never improvises).
//!
//! Each prerequisite is checked here rather than discovered mid-run, so a
//! parked job names the thing a person has to supply:
//!
//! - **an owner** — only the policy's owner may watch or drive the run
//!   (ADR 0081 §8), so a run with none has nobody to claim its steps;
//! - **a replayable recipe** — signed by an organization-pinned key that is
//!   still pinned, unexpired, whose change URL is on the target origin, and —
//!   when nobody is watching — proven by a fresh canary
//!   ([`super::recipe_trust`]). A candidate recipe is a hypothesis and is
//!   never replayed;
//! - **a hook policy the Host can read** — a stored document this build no
//!   longer parses is refused, never replaced by the default (ADR 0159).

use chrono::Utc;
use opensesame_domain::OrganizationId;
use opensesame_rotation_web::ChangePasswordRecipe;
use opensesame_storage::Db;

use super::recipe_trust::{verified_recipe, Attendance, Unrunnable};
use crate::agent_hooks::{load_policy, LoadedHookPolicy};

pub(crate) const DEFER_NO_OWNER: &str = "web_login rotation needs a policy owner to drive its run";
pub(crate) const DEFER_NO_RECIPE: &str =
    "web_login rotation has no verified recipe for this origin";
pub(crate) const DEFER_NO_CANARY: &str = "the recipe for this origin has no passing canary yet; \
     prove it with an attended run before it rotates unattended";
pub(crate) const DEFER_RECIPES_UNREADABLE: &str = "web_login recipes could not be read";
pub(crate) const DEFER_RECIPE_INVALID: &str =
    "the recipe for this origin is not a valid change-password recipe";
pub(crate) const DEFER_HOOK_POLICY: &str =
    "the organization's agent-hooks policy could not be read";

/// Longest selector a recipe may name.
const MAX_SELECTOR_CHARS: usize = 512;

/// Everything a run starts from.
#[derive(Debug)]
pub(crate) struct Plan {
    pub organization_id: OrganizationId,
    pub origin: String,
    /// The principal whose browser drives the run.
    pub owner: String,
    pub recipe_id: String,
    /// `sha256:` of the signed document the run replays: what it records a
    /// canary against, so a recipe replaced mid-run is not credited.
    pub recipe_digest: String,
    pub recipe: ChangePasswordRecipe,
    pub hooks: LoadedHookPolicy,
}

/// Check every prerequisite for an unattended run (the lifecycle scanner's),
/// or name the first one missing. The launcher itself always says which
/// ([`prepare_for`]); this is the scanner's view, for the tests that ask what
/// the scanner would be told.
///
/// # Errors
///
/// The value-blind deferral detail the job parks with.
#[cfg(test)]
pub(crate) async fn prepare(
    db: &Db,
    organization_id: &OrganizationId,
    origin: &str,
    owner: Option<&str>,
) -> Result<Plan, &'static str> {
    prepare_for(db, organization_id, origin, owner, Attendance::Unattended).await
}

/// [`prepare`] for a run a person is, or is not, driving.
///
/// # Errors
///
/// The value-blind deferral detail the job parks with.
pub(crate) async fn prepare_for(
    db: &Db,
    organization_id: &OrganizationId,
    origin: &str,
    owner: Option<&str>,
    attendance: Attendance,
) -> Result<Plan, &'static str> {
    let owner = owner
        .map(str::trim)
        .filter(|owner| !owner.is_empty())
        .ok_or(DEFER_NO_OWNER)?;
    let verified = verified_recipe(
        db,
        &organization_id.to_string(),
        origin,
        attendance,
        Utc::now(),
    )
    .await
    .map_err(|why| match why {
        Unrunnable::Unreadable => DEFER_RECIPES_UNREADABLE,
        Unrunnable::NoRecipe => DEFER_NO_RECIPE,
        Unrunnable::NoCanary => DEFER_NO_CANARY,
        Unrunnable::Invalid => DEFER_RECIPE_INVALID,
    })?;
    let recipe = verified.document.steps().clone();
    if !recipe_is_sound(&recipe, origin) {
        return Err(DEFER_RECIPE_INVALID);
    }
    let hooks = load_policy(db, organization_id)
        .await
        .map_err(|_| DEFER_HOOK_POLICY)?;
    Ok(Plan {
        organization_id: *organization_id,
        origin: origin.to_owned(),
        owner: owner.to_owned(),
        recipe_id: verified.document.recipe_id.clone(),
        recipe_digest: verified.record.digest.unwrap_or_default(),
        recipe,
        hooks,
    })
}

/// A recipe this runner may replay against `origin`: an https change URL on
/// the target origin, and selectors that are there and bounded.
pub(crate) fn recipe_is_sound(recipe: &ChangePasswordRecipe, origin: &str) -> bool {
    let on_origin = url::Url::parse(&recipe.change_url).is_ok_and(|url| {
        url.scheme() == "https"
            && url.username().is_empty()
            && url.password().is_none()
            && url.origin().ascii_serialization() == origin
    });
    let selector =
        |value: &str| !value.trim().is_empty() && value.chars().count() <= MAX_SELECTOR_CHARS;
    on_origin
        && selector(&recipe.new_password_selector)
        && selector(&recipe.submit_selector)
        && recipe
            .current_password_selector
            .as_deref()
            .is_none_or(selector)
        && recipe
            .confirm_password_selector
            .as_deref()
            .is_none_or(selector)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn recipe(change_url: &str) -> ChangePasswordRecipe {
        ChangePasswordRecipe {
            change_url: change_url.into(),
            current_password_selector: Some("#current".into()),
            new_password_selector: "#new".into(),
            confirm_password_selector: None,
            submit_selector: "#save".into(),
        }
    }

    #[test]
    fn a_recipe_stays_on_its_origin() {
        let origin = "https://example.com";
        assert!(recipe_is_sound(
            &recipe("https://example.com/.well-known/change-password"),
            origin
        ));
        for off in [
            "http://example.com/settings",
            "https://evil.example/settings",
            "https://example.com:8443/settings",
            "https://user:pw@example.com/settings",
            "not a url",
        ] {
            assert!(!recipe_is_sound(&recipe(off), origin), "{off}");
        }
        let mut blank = recipe("https://example.com/settings");
        blank.submit_selector = "  ".into();
        assert!(!recipe_is_sound(&blank, origin));
        let mut long = recipe("https://example.com/settings");
        long.confirm_password_selector = Some("x".repeat(MAX_SELECTOR_CHARS + 1));
        assert!(!recipe_is_sound(&long, origin));
    }

    #[tokio::test]
    async fn each_missing_prerequisite_is_named() {
        let db = Db::connect_memory().await.unwrap();
        let org = OrganizationId::new();
        let origin = "https://example.com";
        assert_eq!(
            prepare(&db, &org, origin, None).await.unwrap_err(),
            DEFER_NO_OWNER
        );
        assert_eq!(
            prepare(&db, &org, origin, Some(" ")).await.unwrap_err(),
            DEFER_NO_OWNER
        );
        assert_eq!(
            prepare(&db, &org, origin, Some("principal:a"))
                .await
                .unwrap_err(),
            DEFER_NO_RECIPE
        );
    }
}
