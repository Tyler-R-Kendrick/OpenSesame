//! OpenFGA remote PDP adapter — HTTP client against a live OpenFGA server.
//!
//! When `OPENSESAME_OPENFGA_URL` is unset, callers may fall back to the in-process PEP.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum OpenFgaError {
    #[error("openfga http: {0}")]
    Http(String),
    #[error("openfga denied")]
    Denied,
    #[error("openfga unavailable: {0}")]
    Unavailable(String),
    #[error("openfga config: {0}")]
    Config(String),
}

pub type Result<T> = std::result::Result<T, OpenFgaError>;

#[derive(Clone, Debug)]
pub struct OpenFgaClient {
    base: String,
    store_id: String,
    http: reqwest::Client,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TupleKey {
    pub user: String,
    pub relation: String,
    pub object: String,
}

#[async_trait]
pub trait RemotePdp: Send + Sync {
    async fn check(&self, tuple: &TupleKey) -> Result<bool>;
}

impl OpenFgaClient {
    pub fn from_env() -> Result<Option<Self>> {
        let base = match std::env::var("OPENSESAME_OPENFGA_URL") {
            Ok(u) if !u.trim().is_empty() => u.trim_end_matches('/').to_string(),
            _ => return Ok(None),
        };
        let store_id = std::env::var("OPENSESAME_OPENFGA_STORE_ID").map_err(|_| {
            OpenFgaError::Config("OPENSESAME_OPENFGA_STORE_ID required when URL is set".into())
        })?;
        Ok(Some(Self::new(base, store_id)))
    }

    pub fn new(base: impl Into<String>, store_id: impl Into<String>) -> Self {
        Self {
            base: base.into().trim_end_matches('/').to_string(),
            store_id: store_id.into(),
            http: reqwest::Client::new(),
        }
    }

    pub async fn health(&self) -> Result<()> {
        let url = format!("{}/healthz", self.base);
        let resp = self
            .http
            .get(&url)
            .send()
            .await
            .map_err(|e| OpenFgaError::Unavailable(e.to_string()))?;
        if resp.status().is_success() {
            Ok(())
        } else {
            Err(OpenFgaError::Unavailable(format!(
                "status {}",
                resp.status()
            )))
        }
    }

    pub async fn create_store(&self, name: &str) -> Result<String> {
        let url = format!("{}/stores", self.base);
        let resp = self
            .http
            .post(&url)
            .json(&json!({"name": name}))
            .send()
            .await
            .map_err(|e| OpenFgaError::Http(e.to_string()))?;
        let status = resp.status();
        let body: Value = resp
            .json()
            .await
            .map_err(|e| OpenFgaError::Http(e.to_string()))?;
        if !status.is_success() {
            return Err(OpenFgaError::Http(format!("{status}: {body}")));
        }
        body.get("id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .ok_or_else(|| OpenFgaError::Http("missing store id".into()))
    }

    pub async fn write_authorization_model(&self, model: Value) -> Result<String> {
        let url = format!(
            "{}/stores/{}/authorization-models",
            self.base, self.store_id
        );
        let resp = self
            .http
            .post(&url)
            .json(&model)
            .send()
            .await
            .map_err(|e| OpenFgaError::Http(e.to_string()))?;
        let status = resp.status();
        let body: Value = resp
            .json()
            .await
            .map_err(|e| OpenFgaError::Http(e.to_string()))?;
        if !status.is_success() {
            return Err(OpenFgaError::Http(format!("{status}: {body}")));
        }
        Ok(body
            .get("authorization_model_id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string())
    }

    pub async fn write_tuples(&self, writes: &[TupleKey]) -> Result<()> {
        let url = format!("{}/stores/{}/write", self.base, self.store_id);
        let writes: Vec<Value> = writes
            .iter()
            .map(|t| {
                json!({
                    "user": t.user,
                    "relation": t.relation,
                    "object": t.object,
                })
            })
            .collect();
        let resp = self
            .http
            .post(&url)
            .json(&json!({"writes": {"tuple_keys": writes}}))
            .send()
            .await
            .map_err(|e| OpenFgaError::Http(e.to_string()))?;
        if !resp.status().is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(OpenFgaError::Http(body));
        }
        Ok(())
    }

    pub async fn check_tuple(&self, tuple: &TupleKey) -> Result<bool> {
        let url = format!("{}/stores/{}/check", self.base, self.store_id);
        let resp = self
            .http
            .post(&url)
            .json(&json!({
                "tuple_key": {
                    "user": tuple.user,
                    "relation": tuple.relation,
                    "object": tuple.object,
                }
            }))
            .send()
            .await
            .map_err(|e| OpenFgaError::Unavailable(e.to_string()))?;
        let status = resp.status();
        let body: Value = resp
            .json()
            .await
            .map_err(|e| OpenFgaError::Http(e.to_string()))?;
        if !status.is_success() {
            return Err(OpenFgaError::Http(format!("{status}: {body}")));
        }
        Ok(body
            .get("allowed")
            .and_then(|v| v.as_bool())
            .unwrap_or(false))
    }

    /// Minimal OpenSesame connection model for live drills.
    pub fn connection_model() -> Value {
        json!({
            "schema_version": "1.1",
            "type_definitions": [
                {
                    "type": "user",
                },
                {
                    "type": "connection",
                    "relations": {
                        "user": {
                            "this": {}
                        }
                    },
                    "metadata": {
                        "relations": {
                            "user": {
                                "directly_related_user_types": [{"type": "user"}]
                            }
                        }
                    }
                }
            ]
        })
    }
}

#[async_trait]
impl RemotePdp for OpenFgaClient {
    async fn check(&self, tuple: &TupleKey) -> Result<bool> {
        self.check_tuple(tuple).await
    }
}

/// Bootstrap helper used by live integration scripts/tests.
pub async fn bootstrap_demo_store(base: &str) -> Result<(OpenFgaClient, String)> {
    let bootstrap = OpenFgaClient::new(base, "pending");
    bootstrap.health().await?;
    let store_id = bootstrap.create_store("opensesame-demo").await?;
    let client = OpenFgaClient::new(base, &store_id);
    client
        .write_authorization_model(OpenFgaClient::connection_model())
        .await?;
    client
        .write_tuples(&[TupleKey {
            user: "user:demo".into(),
            relation: "user".into(),
            object: "connection:demo-conn".into(),
        }])
        .await?;
    Ok((client, store_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn from_env_absent() {
        std::env::remove_var("OPENSESAME_OPENFGA_URL");
        assert!(OpenFgaClient::from_env().unwrap().is_none());
    }

    #[test]
    fn model_is_valid_json() {
        let m = OpenFgaClient::connection_model();
        assert_eq!(m["schema_version"], "1.1");
    }

    #[tokio::test]
    #[ignore = "requires live OpenFGA on OPENSESAME_OPENFGA_URL"]
    async fn live_openfga_check_demo_conn() {
        let base = std::env::var("OPENSESAME_OPENFGA_URL").expect("OPENSESAME_OPENFGA_URL");
        let (client, _sid) = bootstrap_demo_store(&base).await.expect("bootstrap");
        let allowed = client
            .check_tuple(&TupleKey {
                user: "user:demo".into(),
                relation: "user".into(),
                object: "connection:demo-conn".into(),
            })
            .await
            .unwrap();
        assert!(allowed);
        let denied = client
            .check_tuple(&TupleKey {
                user: "user:attacker".into(),
                relation: "user".into(),
                object: "connection:demo-conn".into(),
            })
            .await
            .unwrap();
        assert!(!denied);
    }
}
