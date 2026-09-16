//! Drive a [`Plan`] through a [`CollabTransport`].
//!
//! ## Retries
//!
//! Only `429` is retried, and that is a protocol fact rather than a policy
//! choice: Discord rejects a rate-limited request **before** handling it, so
//! repeating it cannot double-apply. A `5xx` is the opposite — the request may
//! have been applied and the answer lost — so a failed `POST /guilds/{id}/roles`
//! is surfaced, not retried, because the alternative is a guild slowly filling
//! with duplicate roles.
//!
//! The wait comes from the 429 body's float `retry_after`, through the
//! [`Backoff`] seam. The seam exists so the rate-limit path is a test rather
//! than a hope: `tests/rate_limit.rs` records the requested waits and returns
//! immediately, and this crate does not depend on a runtime to sleep.

use async_trait::async_trait;

use crate::credential::BotToken;
use crate::model::RoleId;
use crate::plan::{Plan, RoleTarget, Step};
use crate::refusal::Refusal;
use crate::registry::Registration;
use crate::transport::{CollabTransport, Method, TransportError, WireRequest, WireResponse};
use crate::wire::{self, ApiError, Route};

/// How many times a single step may be re-sent after a 429.
pub const MAX_RATE_LIMIT_RETRIES: u32 = 3;

/// Waiting, as a seam.
///
/// A production caller supplies a runtime sleep; the fixture suite supplies a
/// recorder that returns immediately. Keeping it out of the crate means the
/// adapter has no opinion about which runtime a host uses, and no test spends
/// real seconds proving backoff arithmetic.
#[async_trait]
pub trait Backoff: Send + Sync {
    async fn wait(&self, seconds: f64);
}

/// A [`Backoff`] that does not wait. Correct for a fixture; wrong for Discord.
#[derive(Clone, Copy, Debug, Default)]
pub struct NoBackoff;

#[async_trait]
impl Backoff for NoBackoff {
    async fn wait(&self, _seconds: f64) {}
}

/// What executing a plan produced.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Outcome {
    /// The role [`Step::CreateRole`] created, for the caller to record with
    /// [`Registration::record_owned_role`]. Recording is the caller's because
    /// the registration is the caller's to persist — and a role this adapter
    /// created but nobody recorded is a role it will never delete, which is the
    /// safe direction to fail.
    pub created_role: Option<RoleId>,
    /// Step labels in the order they succeeded.
    pub completed: Vec<&'static str>,
    /// Total 429 retries across the plan.
    pub rate_limit_retries: u32,
}

/// A failure while executing a plan.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum ExecutionError {
    #[error(transparent)]
    Refused(#[from] Refusal),
    #[error(transparent)]
    Transport(#[from] TransportError),
    /// Discord answered with an error body.
    #[error("{step} failed: HTTP {status} discord code {code}: {message}")]
    Api {
        step: &'static str,
        status: u16,
        code: u32,
        message: String,
    },
    #[error("{step} answered a body this adapter could not read: {detail}")]
    Decode { step: &'static str, detail: String },
    /// Still rate limited after [`MAX_RATE_LIMIT_RETRIES`].
    #[error("{step} is still rate limited after {attempts} attempts")]
    RateLimited { step: &'static str, attempts: u32 },
    /// A plan referenced [`RoleTarget::PendingCreate`] with no create before it.
    /// A planner bug, surfaced rather than papered over with a guess.
    #[error("the plan referenced a pending role before creating one")]
    MissingCreatedRole,
}

/// A Discord client bound to one bot credential.
pub struct CollabClient<T, B> {
    transport: T,
    backoff: B,
    token: BotToken,
}

impl<T: CollabTransport, B: Backoff> CollabClient<T, B> {
    pub const fn new(transport: T, backoff: B, token: BotToken) -> Self {
        Self {
            transport,
            backoff,
            token,
        }
    }

    /// Send one route, retrying only on 429.
    ///
    /// # Errors
    ///
    /// [`ExecutionError::Transport`], [`ExecutionError::Api`], or
    /// [`ExecutionError::RateLimited`].
    pub(crate) async fn send(
        &self,
        registration: &Registration,
        route: &Route,
        audit_reason: Option<&str>,
        step: &'static str,
    ) -> Result<(WireResponse, u32), ExecutionError> {
        let mut retries = 0;
        loop {
            let response = self
                .transport
                .send(self.request(registration, route, audit_reason))
                .await?;
            if response.is_success() {
                return Ok((response, retries));
            }
            if response.is_rate_limited() && retries < MAX_RATE_LIMIT_RETRIES {
                // A 429 was refused before it was handled, so re-sending cannot
                // double-apply — even a POST.
                self.backoff
                    .wait(response.retry_after_seconds().unwrap_or(1.0))
                    .await;
                retries += 1;
                continue;
            }
            if response.is_rate_limited() {
                return Err(ExecutionError::RateLimited {
                    step,
                    attempts: retries + 1,
                });
            }
            let error = ApiError::parse(response.status, &response.body);
            return Err(ExecutionError::Api {
                step,
                status: response.status,
                code: error.code,
                message: error.message,
            });
        }
    }

    fn request(
        &self,
        registration: &Registration,
        route: &Route,
        audit_reason: Option<&str>,
    ) -> WireRequest {
        WireRequest {
            method: route.method,
            url: format!("{}{}", registration.base_url(), route.path),
            authorization: self.token.authorization_header(),
            // A read carries no reason: `X-Audit-Log-Reason` on a GET is noise
            // Discord ignores.
            audit_reason: match route.method {
                Method::Get => None,
                _ => audit_reason.map(str::to_owned),
            },
            body: route.body.clone(),
        }
    }

    /// Execute every step in order, stopping at the first failure.
    ///
    /// Stopping is deliberate: the plan's order is a safety property (see
    /// [`crate::apply`]), so continuing past a failed overwrite would run the
    /// membership step that the overwrite was supposed to bound.
    ///
    /// # Errors
    ///
    /// Any [`ExecutionError`]. A partial plan leaves the guild in whatever state
    /// the completed steps produced; [`Outcome::completed`] is not returned on
    /// the error path, so a caller that needs to know re-observes rather than
    /// guessing.
    pub async fn execute(
        &self,
        registration: &Registration,
        plan: &Plan,
    ) -> Result<Outcome, ExecutionError> {
        let mut outcome = Outcome::default();
        for step in &plan.steps {
            let label = step.label();
            let route = route_for(&outcome, plan, step)?;
            let (response, retries) = self
                .send(registration, &route, Some(&plan.audit_reason), label)
                .await?;
            outcome.rate_limit_retries += retries;
            if matches!(step, Step::CreateRole { .. }) {
                outcome.created_role = Some(created_role_id(label, &response.body)?);
            }
            outcome.completed.push(label);
        }
        Ok(outcome)
    }
}

/// # Errors
///
/// [`ExecutionError::Decode`] when a create did not answer with a role.
fn created_role_id(step: &'static str, body: &[u8]) -> Result<RoleId, ExecutionError> {
    wire::parse_role(body)
        .map(|role| role.id)
        .map_err(|detail| ExecutionError::Decode { step, detail })
}

/// # Errors
///
/// [`ExecutionError::MissingCreatedRole`] when a step names
/// [`RoleTarget::PendingCreate`] and no create has run.
fn route_for(outcome: &Outcome, plan: &Plan, step: &Step) -> Result<Route, ExecutionError> {
    let guild = &plan.guild;
    Ok(match step {
        Step::CreateRole { name, permissions } => wire::create_role(guild, name, *permissions),
        Step::UpdateRolePermissions { role, permissions } => {
            wire::update_role_permissions(guild, role, *permissions)
        }
        Step::SetChannelOverwrite {
            channel,
            role,
            allow,
            deny,
        } => wire::put_channel_overwrite(channel, resolve(outcome, role)?, *allow, *deny),
        Step::AddMemberRole { user, role } => {
            wire::add_member_role(guild, user, resolve(outcome, role)?)
        }
        Step::RemoveMemberRole { user, role } => wire::remove_member_role(guild, user, role),
        Step::DeleteRole { role } => wire::delete_role(guild, role),
    })
}

/// # Errors
///
/// [`ExecutionError::MissingCreatedRole`].
fn resolve<'a>(outcome: &'a Outcome, target: &'a RoleTarget) -> Result<&'a RoleId, ExecutionError> {
    match target {
        RoleTarget::Existing(role) => Ok(role),
        RoleTarget::PendingCreate => outcome
            .created_role
            .as_ref()
            .ok_or(ExecutionError::MissingCreatedRole),
    }
}
