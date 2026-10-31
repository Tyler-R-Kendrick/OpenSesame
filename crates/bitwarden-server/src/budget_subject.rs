//! A durable attempt budget belongs to a credential object loaded from storage.

use opensesame_storage::bitwarden::{BitwardenAuthRequest, BitwardenSend, BitwardenUser};

/// No variant accepts a caller-selected username or request ID. Unknown
/// identifiers have no stored credential and must not allocate durable state.
pub(crate) enum BudgetSubject<'a> {
    Account(&'a BitwardenUser),
    ApiKey(&'a BitwardenUser),
    Send(&'a BitwardenSend),
    AuthRequest(&'a BitwardenAuthRequest),
    SignInRequest(&'a BitwardenUser),
}

impl BudgetSubject<'_> {
    /// Preserve the original canonical keys so deployment does not reset
    /// existing lockouts. Object population, rather than invented IDs or a
    /// deployment-wide row cap, bounds the number of live credential budgets.
    pub(super) fn key(&self) -> String {
        match self {
            Self::Account(user) => format!("account:{}", user.email.trim().to_ascii_lowercase()),
            Self::ApiKey(user) => format!("api-key:user.{}", user.id),
            Self::Send(send) => format!("send:{}", send.id),
            Self::AuthRequest(request) => format!("auth-request:{}", request.id),
            Self::SignInRequest(user) => user.email.trim().to_ascii_lowercase(),
        }
    }
}

#[cfg(test)]
#[path = "budget_subject_tests.rs"]
pub(crate) mod tests;
