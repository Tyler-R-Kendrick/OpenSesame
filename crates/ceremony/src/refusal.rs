//! What a ceremony must never do, as types rather than as prose.
//!
//! ADR 0082 §5 lists five refusals. A list in a document decays; the ones here
//! are reachable only through [`Guard::admit`], so a step that would break one
//! cannot be issued rather than being caught by a reviewer later.

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// A step a ceremony wants to take, in the terms the refusals are written in.
///
/// Deliberately coarse. This is not the step IR — it is the small set of
/// *kinds* of act that §5 has an opinion about, so the guard can be exhaustive
/// over them and the compiler can say so.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Act {
    /// Read the page, move around it, wait.
    Navigate,
    /// Put a non-credential value into a field the recipe named.
    FillField,
    /// Put a credential into a field the recipe named.
    FillCredential,
    /// Take a declared slot's value out of the page.
    Capture,
    /// Tick the box that accepts a provider's terms of service.
    AcceptTerms,
    /// Submit a form that creates an account.
    SubmitAccountCreation,
    /// Submit a form that creates an app or client.
    SubmitRegistration,
    /// Choose which organization the app is registered against or installed on.
    SelectOrganization,
    /// Answer a CAPTCHA or similar challenge.
    SolveChallenge,
}

/// Why an act was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Error, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Refusal {
    /// A person accepts a provider's terms, not an agent. Not legal caution
    /// dressed as design: an agent that can accept terms can enter somebody
    /// into agreements they never read.
    #[error("a person accepts terms of service, never an agent")]
    TermsAreForAPerson,
    /// The agent may fill a signup form; the human submits it.
    #[error("the human submits an account creation, never the agent")]
    AccountCreationIsForAPerson,
    /// C2 requires the user present and watching.
    #[error("an agentic ceremony requires the user present and watching")]
    UserNotPresent,
    /// Picking an org on someone's behalf is picking whose data is at stake.
    #[error("the organization must be one the user named")]
    OrganizationNotNamed,
    /// ADR 0076 constraint 4, carried over whole.
    #[error("a challenge is never solved or evaded")]
    ChallengeMustNotBeSolved,
}

// There is deliberately no `TargetNotDeclared` here. The recipe pinning what
// may be filled or captured is real, and it is enforced where the target is
// known: `crates/rotation-web`'s tool boundary for fills, and
// `crate::capture::DeclaredSlots` for captures. A third spelling of it in this
// enum would be a rule with two homes, and the one a reader found first would
// be the one nobody had wired up.

/// Whether the person this ceremony is for is present and watching.
///
/// A ceremony exists because somebody is stuck setting the product up, so this
/// is true by definition in the normal case. It is modelled anyway, because
/// "by definition" is what a scheduler ignores.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Presence {
    /// Attached to the run's live preview.
    Watching,
    /// Not attached. Every act that needs a person is refused.
    Absent,
}

/// What the user has consented to for this run, in advance.
///
/// Carried rather than inferred: an org the user named is a fact about a
/// conversation that already happened, and a run that could derive it from the
/// page could derive the wrong one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Consent {
    named_organizations: Vec<String>,
}

impl Consent {
    /// Nobody named anything. The honest default.
    #[must_use]
    pub const fn none() -> Self {
        Self {
            named_organizations: Vec::new(),
        }
    }

    #[must_use]
    pub fn for_organizations(names: &[&str]) -> Self {
        Self {
            named_organizations: names.iter().map(|name| (*name).to_string()).collect(),
        }
    }

    /// Whether the user named this organization.
    ///
    /// Compared case-insensitively, because a provider's own display of an org
    /// name and the user's typing of it routinely differ in case and nothing
    /// else — and refusing on that would push somebody to re-type it until it
    /// matched, which teaches them to click past the consent step.
    #[must_use]
    pub fn names(&self, organization: &str) -> bool {
        self.named_organizations
            .iter()
            .any(|named| named.eq_ignore_ascii_case(organization.trim()))
    }
}

/// The state one act is judged against.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Guard {
    presence: Presence,
    uses_a_model: bool,
    consent: Consent,
}

impl Guard {
    #[must_use]
    pub const fn new(presence: Presence, uses_a_model: bool, consent: Consent) -> Self {
        Self {
            presence,
            uses_a_model,
            consent,
        }
    }

    /// Decide one act.
    ///
    /// `organization` is `Some` only for [`Act::SelectOrganization`]; the
    /// signature keeps it optional rather than splitting the method, so a
    /// caller cannot route around the org check by calling the other one.
    ///
    /// # Errors
    ///
    /// [`Refusal`] naming which of ADR 0082 §5's rules the act would break.
    pub fn admit(&self, act: Act, organization: Option<&str>) -> Result<(), Refusal> {
        // The presence rule is checked first and applies to every act a model
        // drives, not only the consent-bearing ones: ADR 0082 §5 says C2
        // requires the user present, full stop.
        if self.uses_a_model && self.presence == Presence::Absent {
            return Err(Refusal::UserNotPresent);
        }
        match act {
            Act::AcceptTerms => Err(Refusal::TermsAreForAPerson),
            Act::SubmitAccountCreation => Err(Refusal::AccountCreationIsForAPerson),
            Act::SolveChallenge => Err(Refusal::ChallengeMustNotBeSolved),
            Act::SelectOrganization => match organization {
                Some(name) if self.consent.names(name) => Ok(()),
                _ => Err(Refusal::OrganizationNotNamed),
            },
            Act::Navigate
            | Act::FillField
            | Act::FillCredential
            | Act::Capture
            | Act::SubmitRegistration => Ok(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn watching_model() -> Guard {
        Guard::new(
            Presence::Watching,
            true,
            Consent::for_organizations(&["acme-corp"]),
        )
    }

    #[test]
    fn an_agent_never_accepts_terms_however_it_is_configured() {
        // Not gated on presence, on tier, or on anything else. Filling the
        // signup form is allowed; the human submits it.
        for presence in [Presence::Watching, Presence::Absent] {
            for uses_a_model in [true, false] {
                let guard = Guard::new(presence, uses_a_model, Consent::none());
                assert!(matches!(
                    guard.admit(Act::AcceptTerms, None),
                    Err(Refusal::TermsAreForAPerson | Refusal::UserNotPresent)
                ));
            }
        }
        // And specifically: with the user right there and no model involved, it
        // is still refused for its own reason.
        let deterministic = Guard::new(Presence::Watching, false, Consent::none());
        assert_eq!(
            deterministic.admit(Act::AcceptTerms, None),
            Err(Refusal::TermsAreForAPerson)
        );
        assert_eq!(deterministic.admit(Act::FillField, None), Ok(()));
    }

    #[test]
    fn the_agent_fills_a_signup_form_and_the_human_submits_it() {
        let guard = watching_model();
        assert_eq!(guard.admit(Act::FillField, None), Ok(()));
        assert_eq!(
            guard.admit(Act::SubmitAccountCreation, None),
            Err(Refusal::AccountCreationIsForAPerson),
        );
        // Registering an app is not creating an account, and is allowed.
        assert_eq!(guard.admit(Act::SubmitRegistration, None), Ok(()));
    }

    #[test]
    fn an_org_the_user_did_not_name_is_refused() {
        // Picking one on somebody's behalf is picking whose data is at stake.
        let guard = watching_model();
        assert_eq!(
            guard.admit(Act::SelectOrganization, Some("acme-corp")),
            Ok(())
        );
        assert_eq!(
            guard.admit(Act::SelectOrganization, Some("acme-corp-staging")),
            Err(Refusal::OrganizationNotNamed),
        );
        assert_eq!(
            guard.admit(Act::SelectOrganization, None),
            Err(Refusal::OrganizationNotNamed),
            "an unnamed org is not a permissive default",
        );
    }

    #[test]
    fn an_org_name_matches_regardless_of_case() {
        // A provider's display of an org and a user's typing of it differ in
        // case constantly. Refusing on that teaches people to click past the
        // consent step until it matches.
        let guard = watching_model();
        assert_eq!(
            guard.admit(Act::SelectOrganization, Some("ACME-Corp")),
            Ok(())
        );
        assert_eq!(
            guard.admit(Act::SelectOrganization, Some(" acme-corp ")),
            Ok(())
        );
    }

    #[test]
    fn naming_nothing_permits_no_organization_at_all() {
        let guard = Guard::new(Presence::Watching, false, Consent::none());
        assert_eq!(
            guard.admit(Act::SelectOrganization, Some("anything")),
            Err(Refusal::OrganizationNotNamed)
        );
    }

    #[test]
    fn a_model_driving_with_nobody_watching_does_nothing_at_all() {
        // ADR 0082 §5: C2 requires the user present. Not "present for the
        // risky steps" — present.
        let guard = Guard::new(
            Presence::Absent,
            true,
            Consent::for_organizations(&["acme-corp"]),
        );
        for act in [
            Act::Navigate,
            Act::FillField,
            Act::FillCredential,
            Act::Capture,
            Act::SubmitRegistration,
        ] {
            assert_eq!(
                guard.admit(act, None),
                Err(Refusal::UserNotPresent),
                "{act:?}"
            );
        }
        assert_eq!(
            guard.admit(Act::SelectOrganization, Some("acme-corp")),
            Err(Refusal::UserNotPresent),
        );
    }

    #[test]
    fn a_deterministic_replay_does_not_need_a_watcher_to_navigate() {
        // C1 has no model in the loop, so the presence rule does not gate it —
        // live preview still defaults on (ADR 0082 §9), which is a different
        // control from this one.
        let guard = Guard::new(
            Presence::Absent,
            false,
            Consent::for_organizations(&["acme-corp"]),
        );
        assert_eq!(guard.admit(Act::Navigate, None), Ok(()));
        assert_eq!(guard.admit(Act::Capture, None), Ok(()));
        // The absolute refusals are still absolute.
        assert_eq!(
            guard.admit(Act::SolveChallenge, None),
            Err(Refusal::ChallengeMustNotBeSolved)
        );
    }

    #[test]
    fn a_challenge_is_never_solved() {
        // ADR 0076 constraint 4, carried over whole. The user may complete one
        // themselves in the attached session; the agent may not.
        for presence in [Presence::Watching, Presence::Absent] {
            let guard = Guard::new(presence, false, Consent::none());
            assert_eq!(
                guard.admit(Act::SolveChallenge, None),
                Err(Refusal::ChallengeMustNotBeSolved)
            );
        }
    }
}
