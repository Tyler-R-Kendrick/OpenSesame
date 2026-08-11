use chrono::{DateTime, Utc};
use opensesame_domain::OrganizationRole;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SessionMetadata {
    pub session_id: String,
    pub principal_id: String,
    pub actor_id: String,
    pub client_id: Option<String>,
    pub instance_id: Option<String>,
    pub issuer: String,
    pub assurance: String,
    pub organization_id: Option<String>,
    pub organization_role: Option<OrganizationRole>,
    pub project_id: Option<String>,
    pub environment_id: Option<String>,
    pub expires_at: DateTime<Utc>,
    /// Opaque handle reference — never a refresh token.
    pub credential_handle: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct WhoAmI {
    pub principal_id: String,
    pub actor_id: String,
    pub client_id: Option<String>,
    pub instance_id: Option<String>,
    pub issuer: String,
    pub assurance: String,
    pub context: String,
}
