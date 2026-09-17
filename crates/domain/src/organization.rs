use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OrganizationRole {
    Owner,
    Admin,
    Member,
}

impl OrganizationRole {
    #[must_use]
    pub fn can_configure_integrations(self) -> bool {
        matches!(self, Self::Owner | Self::Admin)
    }

    /// Cohort/template editors may be admins. Reserved issuance (export, policy
    /// edit) requires the realm owner — explicit higher-scope authority.
    #[must_use]
    pub fn may_issue_reserved_administration(self) -> bool {
        matches!(self, Self::Owner)
    }
}
