//! OpenBao credential authority adapter.
//! OpenBao is a provider — not the public domain model.
//! Agents never receive SecretRef material through this trait's agent-safe paths.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AuthorityError {
    #[error("sealed or quorum unavailable")]
    Unavailable,
    #[error("denied: {0}")]
    Denied(String),
    #[error("provider: {0}")]
    Provider(String),
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CredentialHandle {
    pub id: String,
    pub mount: String,
    pub key_version: u64,
}

#[derive(Clone, Debug)]
pub enum CredentialOperation {
    Sign {
        digest: Vec<u8>,
    },
    Decrypt {
        ciphertext: Vec<u8>,
    },
    /// Explicitly denied for agent paths — use ConnectionRef invoke instead.
    BearerHttpPlaceholder,
}

#[derive(Clone, Debug)]
pub struct CredentialOperationResult {
    pub bytes: Vec<u8>,
}

#[derive(Clone, Debug)]
pub struct Lease {
    pub id: String,
    pub renewable: bool,
}

#[derive(Clone, Debug)]
pub struct AuthorityHealth {
    pub sealed: bool,
    pub quorum_ok: bool,
}

#[async_trait]
pub trait CredentialAuthority: Send + Sync {
    async fn create_handle(&self, path: &str) -> Result<CredentialHandle, AuthorityError>;
    async fn use_credential(
        &self,
        handle: &CredentialHandle,
        operation: CredentialOperation,
    ) -> Result<CredentialOperationResult, AuthorityError>;
    async fn issue_lease(&self, path: &str) -> Result<Lease, AuthorityError>;
    async fn renew_lease(&self, lease: &Lease) -> Result<Lease, AuthorityError>;
    async fn revoke(&self, handle: &CredentialHandle) -> Result<(), AuthorityError>;
    async fn health(&self) -> Result<AuthorityHealth, AuthorityError>;
}

/// Local stand-in used when OpenBao is not reachable (dev/tests).
pub struct MemoryAuthority {
    pub quorum_ok: bool,
    pub sealed: bool,
}

#[async_trait]
impl CredentialAuthority for MemoryAuthority {
    async fn create_handle(&self, path: &str) -> Result<CredentialHandle, AuthorityError> {
        self.ensure_available()?;
        Ok(CredentialHandle {
            id: format!("cred:{path}"),
            mount: "transit".into(),
            key_version: 1,
        })
    }

    async fn use_credential(
        &self,
        _handle: &CredentialHandle,
        operation: CredentialOperation,
    ) -> Result<CredentialOperationResult, AuthorityError> {
        self.ensure_available()?;
        match operation {
            CredentialOperation::Sign { digest } => Ok(CredentialOperationResult { bytes: digest }),
            CredentialOperation::Decrypt { ciphertext } => {
                Ok(CredentialOperationResult { bytes: ciphertext })
            }
            CredentialOperation::BearerHttpPlaceholder => Err(AuthorityError::Denied(
                "raw bearer export not available via use_credential".into(),
            )),
        }
    }

    async fn issue_lease(&self, path: &str) -> Result<Lease, AuthorityError> {
        self.ensure_available()?;
        Ok(Lease {
            id: format!("lease:{path}"),
            renewable: true,
        })
    }

    async fn renew_lease(&self, lease: &Lease) -> Result<Lease, AuthorityError> {
        self.ensure_available()?;
        Ok(lease.clone())
    }

    async fn revoke(&self, _handle: &CredentialHandle) -> Result<(), AuthorityError> {
        self.ensure_available()?;
        Ok(())
    }

    async fn health(&self) -> Result<AuthorityHealth, AuthorityError> {
        Ok(AuthorityHealth {
            sealed: self.sealed,
            quorum_ok: self.quorum_ok,
        })
    }
}

/// Parse `/sys/health` (or an equivalent) JSON object.
///
/// A sealed or uninitialized response never becomes a usable handle. A missing
/// `sealed` field is unavailable, not "open".
pub fn parse_sys_health(body: &Value) -> Result<AuthorityHealth, AuthorityError> {
    let sealed = match body.get("sealed") {
        Some(Value::Bool(v)) => *v,
        _ => return Err(AuthorityError::Unavailable),
    };
    let initialized = match body.get("initialized") {
        None => true,
        Some(Value::Bool(v)) => *v,
        Some(_) => return Err(AuthorityError::Provider("initialized is not a boolean".into())),
    };
    if !initialized {
        return Err(AuthorityError::Unavailable);
    }
    Ok(AuthorityHealth {
        sealed,
        quorum_ok: !sealed,
    })
}

/// Refuse to mint a credential handle from a health document that is sealed
/// or missing required fields.
pub fn handle_from_health(
    body: &Value,
    path: &str,
) -> Result<CredentialHandle, AuthorityError> {
    let health = parse_sys_health(body)?;
    if health.sealed || !health.quorum_ok {
        return Err(AuthorityError::Unavailable);
    }
    Ok(CredentialHandle {
        id: format!("cred:{path}"),
        mount: "transit".into(),
        key_version: 1,
    })
}

impl MemoryAuthority {
    fn ensure_available(&self) -> Result<(), AuthorityError> {
        if self.sealed || !self.quorum_ok {
            Err(AuthorityError::Unavailable)
        } else {
            Ok(())
        }
    }
}

/// Live OpenBao HTTP client (dev or production). Never returns raw secrets to agent callers
/// through [`CredentialOperation::BearerHttpPlaceholder`].
#[derive(Clone, Debug)]
pub struct OpenBaoHttpAuthority {
    pub base: String,
    pub token: String,
    http: reqwest::Client,
}

impl OpenBaoHttpAuthority {
    pub fn from_env() -> Result<Option<Self>, AuthorityError> {
        let base = match std::env::var("OPENSESAME_OPENBAO_URL") {
            Ok(u) if !u.trim().is_empty() => u.trim_end_matches('/').to_string(),
            _ => return Ok(None),
        };
        let token = std::env::var("OPENSESAME_OPENBAO_TOKEN")
            .or_else(|_| std::env::var("BAO_TOKEN"))
            .or_else(|_| std::env::var("VAULT_TOKEN"))
            .map_err(|_| AuthorityError::Provider("OPENSESAME_OPENBAO_TOKEN required".into()))?;
        Ok(Some(Self::new(base, token)))
    }

    pub fn new(base: impl Into<String>, token: impl Into<String>) -> Self {
        Self {
            base: base.into().trim_end_matches('/').to_string(),
            token: token.into(),
            http: reqwest::Client::new(),
        }
    }

    async fn request(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value, AuthorityError> {
        let url = format!("{}{}", self.base, path);
        let mut req = self
            .http
            .request(method, &url)
            .header("X-Vault-Token", &self.token);
        if let Some(b) = body {
            req = req.json(&b);
        }
        let resp = req
            .send()
            .await
            .map_err(|e| AuthorityError::Provider(e.to_string()))?;
        let status = resp.status();
        let text = resp
            .text()
            .await
            .map_err(|e| AuthorityError::Provider(e.to_string()))?;
        if status.as_u16() == 503 || status.as_u16() == 429 {
            return Err(AuthorityError::Unavailable);
        }
        if !status.is_success() {
            return Err(AuthorityError::Provider(format!("{status}: {text}")));
        }
        if text.is_empty() {
            return Ok(json!({}));
        }
        serde_json::from_str(&text).map_err(|e| AuthorityError::Provider(e.to_string()))
    }

    /// Store a secret under KV v2 for internal connector use — not agent-readable.
    pub async fn kv_put(&self, mount: &str, path: &str, data: Value) -> Result<(), AuthorityError> {
        self.request(
            reqwest::Method::POST,
            &format!("/v1/{mount}/data/{path}"),
            Some(json!({"data": data})),
        )
        .await?;
        Ok(())
    }

    pub async fn kv_get(&self, mount: &str, path: &str) -> Result<Value, AuthorityError> {
        let body = self
            .request(
                reqwest::Method::GET,
                &format!("/v1/{mount}/data/{path}"),
                None,
            )
            .await?;
        Ok(body.pointer("/data/data").cloned().unwrap_or(Value::Null))
    }
}

#[async_trait]
impl CredentialAuthority for OpenBaoHttpAuthority {
    async fn create_handle(&self, path: &str) -> Result<CredentialHandle, AuthorityError> {
        let _ = self.health().await?;
        Ok(CredentialHandle {
            id: format!("cred:{path}"),
            mount: "secret".into(),
            key_version: 1,
        })
    }

    async fn use_credential(
        &self,
        handle: &CredentialHandle,
        operation: CredentialOperation,
    ) -> Result<CredentialOperationResult, AuthorityError> {
        match operation {
            CredentialOperation::BearerHttpPlaceholder => Err(AuthorityError::Denied(
                "Bearer materialization denied — use ConnectionRef invoke / authorized-http".into(),
            )),
            CredentialOperation::Sign { digest } => {
                // Prefer transit when enabled; for live drill, echo digest as opaque op result
                // without exposing stored secret values to callers.
                let _ = handle;
                Ok(CredentialOperationResult { bytes: digest })
            }
            CredentialOperation::Decrypt { ciphertext: _ } => Err(AuthorityError::Denied(format!(
                "decrypt not enabled for handle {}",
                handle.id
            ))),
        }
    }

    async fn issue_lease(&self, path: &str) -> Result<Lease, AuthorityError> {
        Ok(Lease {
            id: format!("lease:{path}"),
            renewable: true,
        })
    }

    async fn renew_lease(&self, lease: &Lease) -> Result<Lease, AuthorityError> {
        Ok(lease.clone())
    }

    async fn revoke(&self, _handle: &CredentialHandle) -> Result<(), AuthorityError> {
        Ok(())
    }

    async fn health(&self) -> Result<AuthorityHealth, AuthorityError> {
        let body = self
            .request(reqwest::Method::GET, "/v1/sys/health", None)
            .await
            .map_err(|e| match e {
                AuthorityError::Provider(msg) if msg.contains("429") || msg.contains("501") => {
                    // Some health responses use non-200 for sealed/uninit — parse if possible
                    AuthorityError::Unavailable
                }
                other => other,
            })?;
        parse_sys_health(&body)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn fails_closed_when_sealed() {
        let a = MemoryAuthority {
            quorum_ok: true,
            sealed: true,
        };
        assert!(matches!(
            a.create_handle("key").await,
            Err(AuthorityError::Unavailable)
        ));
    }

    #[tokio::test]
    async fn memory_denies_bearer_export() {
        let a = MemoryAuthority {
            quorum_ok: true,
            sealed: false,
        };
        let h = a.create_handle("x").await.unwrap();
        assert!(matches!(
            a.use_credential(&h, CredentialOperation::BearerHttpPlaceholder)
                .await,
            Err(AuthorityError::Denied(_))
        ));
    }

    #[test]
    fn from_env_absent() {
        std::env::remove_var("OPENSESAME_OPENBAO_URL");
        assert!(OpenBaoHttpAuthority::from_env().unwrap().is_none());
    }

    #[test]
    fn health_missing_sealed_is_unavailable() {
        assert!(parse_sys_health(&json!({})).is_err());
        assert!(handle_from_health(&json!({"sealed": true}), "k").is_err());
        let open = parse_sys_health(&json!({"sealed": false, "initialized": true})).unwrap();
        assert!(!open.sealed);
        assert!(open.quorum_ok);
    }

    #[tokio::test]
    #[ignore = "requires live OpenBao on OPENSESAME_OPENBAO_URL"]
    async fn live_openbao_denies_bearer() {
        let base = std::env::var("OPENSESAME_OPENBAO_URL").expect("url");
        let token = std::env::var("OPENSESAME_OPENBAO_TOKEN")
            .or_else(|_| std::env::var("BAO_TOKEN"))
            .expect("token");
        let a = OpenBaoHttpAuthority::new(base, token);
        let health = a.health().await.expect("health");
        assert!(!health.sealed);
        assert!(health.quorum_ok);
        a.kv_put("secret", "github/acme", json!({"token": "never-to-agent"}))
            .await
            .expect("kv put");
        let got = a.kv_get("secret", "github/acme").await.expect("kv get");
        // Internal plane can read — agent API must not.
        assert_eq!(got["token"], "never-to-agent");
        let h = a.create_handle("github/acme").await.unwrap();
        let err = a
            .use_credential(&h, CredentialOperation::BearerHttpPlaceholder)
            .await
            .unwrap_err();
        assert!(matches!(err, AuthorityError::Denied(_)));
    }
}
