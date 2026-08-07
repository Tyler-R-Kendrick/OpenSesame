use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AuthZenSubject {
    #[serde(rename = "type")]
    pub type_: String,
    pub id: String,
    #[serde(default)]
    pub properties: Value,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AuthZenAction {
    pub name: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AuthZenResource {
    #[serde(rename = "type")]
    pub type_: String,
    pub id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AuthZenRequest {
    pub subject: AuthZenSubject,
    pub action: AuthZenAction,
    pub resource: AuthZenResource,
    #[serde(default)]
    pub context: Value,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AuthZenObligation {
    pub id: String,
    pub attributes: Value,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AuthZenDecision {
    pub decision: bool,
    pub decision_id: String,
    pub policy_version_digest: String,
    #[serde(default)]
    pub obligations: Vec<AuthZenObligation>,
    #[serde(default)]
    pub context: Value,
}
