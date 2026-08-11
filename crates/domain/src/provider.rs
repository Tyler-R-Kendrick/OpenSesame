use crate::{AuthorityHandle, ConnectionId, OrganizationId, ProjectId};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderCategory {
    Encryption,
    CloudSecretManager,
    PasswordManager,
    LocalStorage,
    RemoteStorage,
    Lease,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderCapability {
    Read,
    Write,
    Delete,
    List,
    Encrypt,
    Decrypt,
    Lease,
    Revoke,
    Sync,
    Test,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderSupport {
    Experimental,
    ContractTested,
    Supported,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionTarget {
    PersonalDaemon,
    WorkloadWorker,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthenticationMode {
    VendorCli,
    WorkloadIdentity,
    HostSession,
    LocalKeyring,
    Hardware,
    StaticToken,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderDefinition {
    pub id: String,
    pub display_name: String,
    pub categories: Vec<ProviderCategory>,
    pub capabilities: Vec<ProviderCapability>,
    pub authentication: Vec<AuthenticationMode>,
    pub execution_targets: Vec<ExecutionTarget>,
    pub support: ProviderSupport,
    pub adapter: String,
    pub live_test_environment: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ConnectionRecord {
    pub id: ConnectionId,
    pub organization_id: OrganizationId,
    pub project_id: Option<ProjectId>,
    pub provider_id: String,
    pub display_name: String,
    /// Non-secret provider coordinates such as region, vault name, or mount.
    pub public_config: Value,
    /// Internal authority reference. This is never included in agent views.
    pub credential_ref: Option<AuthorityHandle>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl ConnectionRecord {
    pub fn assert_public_config_safe(&self) -> Result<(), String> {
        assert_public_config_safe(&self.public_config)
    }
}

pub fn assert_public_config_safe(value: &Value) -> Result<(), String> {
    const DENIED_EXACT: &[&str] = &["accesskey", "apikey", "privatekey", "credential"];
    match value {
        Value::Object(values) => {
            for (key, value) in values {
                let normalized: String = key
                    .chars()
                    .filter(|c| c.is_ascii_alphanumeric())
                    .flat_map(char::to_lowercase)
                    .collect();
                if DENIED_EXACT.contains(&normalized.as_str())
                    || normalized.ends_with("password")
                    || normalized.ends_with("token")
                    || normalized.ends_with("secret")
                    || normalized.ends_with("credentials")
                {
                    return Err(format!(
                        "public_config field {key:?} may contain credential material"
                    ));
                }
                assert_public_config_safe(value)?;
            }
        }
        Value::Array(values) => {
            for value in values {
                assert_public_config_safe(value)?;
            }
        }
        _ => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn public_config_rejects_secret_fields_recursively() {
        assert!(assert_public_config_safe(&json!({"region": "us-east-1"})).is_ok());
        assert!(assert_public_config_safe(&json!({
            "secret_name": "billing/api",
            "token_url": "https://issuer.example/token"
        }))
        .is_ok());
        assert!(assert_public_config_safe(&json!({"auth": {"client-secret": "nope"}})).is_err());
        assert!(assert_public_config_safe(&json!({"refreshToken": "nope"})).is_err());
    }
}
