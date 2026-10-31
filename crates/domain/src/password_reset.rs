//! Per-run, per-capability scope for CUA password reset (ADR 0213).
//!
//! This is an authorization check only. Durable execution and idempotency are
//! separate concerns: a caller must still bind the frozen intent and invocation
//! to the same run before performing an effect.

use crate::{DomainError, Grant, Intent};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PasswordResetCapability {
    DomainMetadata,
    Item,
    Mailbox,
    Browser,
    Runtime,
    Model,
    Proxy,
    PasswordProduction,
    HumanTakeover,
    Reconciliation,
    Compensation,
}

impl PasswordResetCapability {
    #[must_use]
    pub const fn required_action(self) -> &'static str {
        match self {
            Self::DomainMetadata => "password_reset.domain_metadata.list",
            Self::Item => "password_reset.item.use",
            Self::Mailbox => "password_reset.mailbox.read",
            Self::Browser => "password_reset.browser.drive",
            Self::Runtime => "password_reset.runtime.execute",
            Self::Model => "password_reset.model.plan",
            Self::Proxy => "password_reset.proxy.substitute",
            Self::PasswordProduction => "password_reset.password.produce",
            Self::HumanTakeover => "password_reset.human.takeover",
            Self::Reconciliation => "password_reset.run.reconcile",
            Self::Compensation => "password_reset.run.compensate",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PasswordResetGrantScope {
    run_id: String,
    domain: String,
    item_id: Option<String>,
    capability: PasswordResetCapability,
}

impl PasswordResetGrantScope {
    /// Start with the only grant that can list accounts for a domain.
    ///
    /// # Errors
    /// Returns an error when the run id or normalized domain is invalid.
    pub fn domain_metadata(run_id: &str, domain: &str) -> Result<Self, DomainError> {
        validate_run_id(run_id)?;
        validate_domain(domain)?;
        Ok(Self {
            run_id: run_id.into(),
            domain: domain.into(),
            item_id: None,
            capability: PasswordResetCapability::DomainMetadata,
        })
    }

    /// Narrow domain discovery to one chosen item and one new capability.
    ///
    /// # Errors
    /// Returns an error when called on an item grant, asked for metadata again,
    /// or given an invalid item id or capability.
    pub fn narrow_to_item(
        &self,
        item_id: &str,
        capability: PasswordResetCapability,
    ) -> Result<Self, DomainError> {
        if self.capability != PasswordResetCapability::DomainMetadata {
            return Err(denied("domain metadata is the only discovery grant"));
        }
        if capability == PasswordResetCapability::DomainMetadata {
            return Err(denied("item grants cannot list domain metadata"));
        }
        validate_segment("item id", item_id)?;
        Ok(Self {
            run_id: self.run_id.clone(),
            domain: self.domain.clone(),
            item_id: Some(item_id.into()),
            capability,
        })
    }

    #[must_use]
    pub fn resource(&self) -> String {
        match &self.item_id {
            Some(item_id) => format!("password-reset:domain:{}:item:{item_id}", self.domain),
            None => format!("password-reset:domain:{}:metadata", self.domain),
        }
    }

    #[must_use]
    pub fn audience(&self) -> String {
        format!("opensesame:password-reset:{}", self.run_id)
    }

    /// Check the ordinary grant and frozen invocation fields together.
    ///
    /// A reset grant carries exactly one action and exact resource. Wildcards
    /// are deliberately insufficient even where `permits_resource` would match.
    ///
    /// # Errors
    /// Returns an error when the grant is inactive, exports raw credentials, or
    /// either side names another capability, item, domain or run.
    pub fn authorize(
        &self,
        grant: &Grant,
        intent: &Intent,
        now: DateTime<Utc>,
    ) -> Result<(), DomainError> {
        grant.assert_active(now)?;
        if grant.constraints.raw_credential_export {
            return Err(DomainError::ExportDenied);
        }
        let action = self.capability.required_action();
        let resource = self.resource();
        if grant.actions.len() != 1 || grant.actions[0] != action {
            return Err(denied("grant does not name exactly this capability"));
        }
        if grant.resources.len() != 1
            || grant.resources[0] != resource
            || !grant.permits_resource(&resource)
        {
            return Err(denied("grant does not name exactly this item or domain"));
        }
        let audience = self.audience();
        if grant.constraints.audiences.len() != 1 || grant.constraints.audiences[0] != audience {
            return Err(denied("grant belongs to another reset run"));
        }
        if intent.operation != action || intent.resource != resource {
            return Err(denied("intent is outside the reset grant"));
        }
        if intent.audience != audience {
            return Err(denied("intent belongs to another reset run"));
        }
        Ok(())
    }
}

fn validate_domain(domain: &str) -> Result<(), DomainError> {
    let valid = domain.len() <= 253
        && domain.split('.').count() >= 2
        && domain.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        });
    if valid {
        Ok(())
    } else {
        Err(DomainError::InvalidId(
            "reset domain must be normalized DNS names".into(),
        ))
    }
}

fn validate_run_id(run_id: &str) -> Result<(), DomainError> {
    validate_segment("run id", run_id)
}

fn validate_segment(name: &str, value: &str) -> Result<(), DomainError> {
    if !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
    {
        Ok(())
    } else {
        Err(DomainError::InvalidId(format!(
            "{name} must be a bounded opaque segment"
        )))
    }
}

fn denied(reason: &str) -> DomainError {
    DomainError::AuthorizationDenied(reason.into())
}

#[cfg(test)]
#[path = "password_reset_tests.rs"]
mod tests;
