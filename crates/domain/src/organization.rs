use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OrganizationRole {
    Owner,
    Admin,
    Member,
}

impl OrganizationRole {
    pub fn can_configure_integrations(self) -> bool {
        matches!(self, Self::Owner | Self::Admin)
    }
}
