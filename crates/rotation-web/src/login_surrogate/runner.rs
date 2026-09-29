//! The runner contract for a substituted login, and the one function that
//! orders it.
//!
//! Additive to ADR 0076 §8's contract in the way [`CeremonyTransport`] is: a
//! supertrait of [`BrowserTransport`], so a runner that does not offer
//! substitution implements nothing new and a rotation never sees these verbs.
//! The agent's tool surface is unchanged. It still says
//! `fill_credential(ref, selector)`; whether the controller answers that with
//! a surrogate and an egress hook or with a CDP fill is the recipe's
//! declaration, not the model's choice.
//!
//! [`CeremonyTransport`]: crate::CeremonyTransport

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use super::gate::{ArmedSubstitution, LoginRoad};
use super::outcome::{AfterSubstitution, FallbackReason, ParkReason, Refusal};
use crate::tools::{BrowserTransport, CredentialRef, Filled, StepError, Verified};

/// The pages and nodes a surrogate login touches.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SurrogateLoginRecipe {
    pub login_url: String,
    pub password_selector: String,
    pub submit_selector: String,
}

/// What the egress hook did while a substituted submit was in flight.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EgressReport {
    /// One request carried the surrogate and was sent with the credential.
    Substituted,
    /// A request carrying the surrogate was refused and failed.
    Refused(Refusal),
    /// No request carried the surrogate before the page settled.
    NotSeen,
}

/// A runner that can substitute at its egress boundary.
///
/// Implementations own two obligations this crate cannot enforce from here,
/// and must not weaken:
///
/// - every request the page sends while `submit_substituted` is in flight
///   goes through [`ArmedSubstitution::egress`], and a refused one is failed
///   with [`Refusal::CLIENT_MESSAGE`], never forwarded;
/// - every response body and DOM read the model can see after a substitution
///   passes through a [`ResponseScrub`](super::ResponseScrub) for the same
///   credential first.
#[async_trait]
pub trait SurrogateLoginTransport: BrowserTransport {
    /// Type the declared surrogate — never the credential — into `selector`.
    async fn fill_surrogate(
        &self,
        substitution: &ArmedSubstitution,
        selector: &str,
    ) -> Result<Filled, StepError>;

    /// Click `selector` with the egress hook armed for `substitution`, the
    /// credential resolved from `reference` inside the runner, and report
    /// what the hook did.
    async fn submit_substituted(
        &self,
        substitution: &ArmedSubstitution,
        reference: &CredentialRef,
        selector: &str,
    ) -> Result<EgressReport, StepError>;

    /// Whether the page the submission landed on is signed in. Not
    /// [`BrowserTransport::verify_login`], which performs a fresh login of its
    /// own and so could not say whether *this* submission worked.
    async fn login_settled(&self) -> Result<Verified, StepError>;
}

/// Which road the login finally took.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LoginVia {
    Substitution,
    CdpFill,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LoginOutcome {
    LoggedIn,
    /// The CDP fill fallback was rejected too: the credential is wrong.
    Rejected,
    Parked(ParkReason),
}

/// One login: the road it took and where it ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LoginReport {
    pub via: LoginVia,
    pub outcome: LoginOutcome,
    /// Set when the login fell back, with why.
    pub fell_back: Option<FallbackReason>,
}

/// Log in the way `road` says: by substitution with its one CDP fallback, or
/// by CDP fill alone when the plugin's switch or the recipe did not arm one.
///
/// The road is [`LoginRoad::choose`]'s answer, so this is the only entry a
/// runner needs: it cannot reach substitution without the switch.
pub async fn run_login<T: SurrogateLoginTransport + ?Sized>(
    transport: &T,
    road: LoginRoad,
    recipe: &SurrogateLoginRecipe,
    reference: &CredentialRef,
) -> LoginReport {
    match road {
        LoginRoad::Substitute(armed) => {
            run_surrogate_login(transport, armed, recipe, reference).await
        }
        LoginRoad::CdpFill(_) => LoginReport {
            via: LoginVia::CdpFill,
            outcome: cdp_fill(transport, recipe, reference).await,
            fell_back: None,
        },
    }
}

/// Log in with a surrogate, and fall back to CDP fill — once — if that fails.
///
/// ```text
/// navigate -> fill surrogate -> submit with the egress hook armed
///   -> settled? -> LoggedIn
///   -> otherwise: conclude (the declaration is consumed)
///        -> tripwire / indeterminate: park
///        -> anything else: navigate -> fill_credential -> submit -> settled?
/// ```
///
/// `substitution` is taken by value and consumed before the fallback starts,
/// so the fallback has no declaration it could substitute with.
pub async fn run_surrogate_login<T: SurrogateLoginTransport + ?Sized>(
    transport: &T,
    substitution: ArmedSubstitution,
    recipe: &SurrogateLoginRecipe,
    reference: &CredentialRef,
) -> LoginReport {
    match attempt(transport, substitution, recipe, reference).await {
        AfterSubstitution::LoggedIn => LoginReport {
            via: LoginVia::Substitution,
            outcome: LoginOutcome::LoggedIn,
            fell_back: None,
        },
        AfterSubstitution::Park(reason) => LoginReport {
            via: LoginVia::Substitution,
            outcome: LoginOutcome::Parked(reason),
            fell_back: None,
        },
        AfterSubstitution::FallBackToCdpFill(why) => LoginReport {
            via: LoginVia::CdpFill,
            outcome: cdp_fill(transport, recipe, reference).await,
            fell_back: Some(why),
        },
    }
}

async fn attempt<T: SurrogateLoginTransport + ?Sized>(
    transport: &T,
    substitution: ArmedSubstitution,
    recipe: &SurrogateLoginRecipe,
    reference: &CredentialRef,
) -> AfterSubstitution {
    let step = |error| AfterSubstitution::FallBackToCdpFill(FallbackReason::Step(error));
    if let Err(error) = transport.navigate(&recipe.login_url).await {
        return step(error);
    }
    match transport
        .fill_surrogate(&substitution, &recipe.password_selector)
        .await
    {
        Ok(Filled::Ok) => {}
        Ok(Filled::NoSuchField) => {
            return AfterSubstitution::FallBackToCdpFill(FallbackReason::NoSuchField)
        }
        Err(error) => return step(error),
    }
    let report = match transport
        .submit_substituted(&substitution, reference, &recipe.submit_selector)
        .await
    {
        Ok(report) => report,
        Err(error) => return step(error),
    };
    match report {
        EgressReport::Refused(refusal) => refusal.next(),
        EgressReport::NotSeen => AfterSubstitution::FallBackToCdpFill(FallbackReason::NotSubmitted),
        EgressReport::Substituted => match transport.login_settled().await {
            Ok(verified) => substitution.conclude(verified),
            Err(error) => step(error),
        },
    }
}

async fn cdp_fill<T: SurrogateLoginTransport + ?Sized>(
    transport: &T,
    recipe: &SurrogateLoginRecipe,
    reference: &CredentialRef,
) -> LoginOutcome {
    let parked = |error| LoginOutcome::Parked(ParkReason::Step(error));
    if let Err(error) = transport.navigate(&recipe.login_url).await {
        return parked(error);
    }
    match transport
        .fill_credential(reference, &recipe.password_selector)
        .await
    {
        Ok(Filled::Ok) => {}
        Ok(Filled::NoSuchField) => return LoginOutcome::Parked(ParkReason::NoSuchField),
        Err(error) => return parked(error),
    }
    if let Err(error) = transport.submit(&recipe.submit_selector).await {
        return parked(error);
    }
    match transport.login_settled().await {
        Ok(Verified::Works) => LoginOutcome::LoggedIn,
        Ok(Verified::Rejected) => LoginOutcome::Rejected,
        Ok(Verified::Indeterminate) => LoginOutcome::Parked(ParkReason::Indeterminate),
        Err(error) => parked(error),
    }
}
