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

/// Operator PDP base URL: https, or loopback http. No userinfo (SSRF / credential leak).
pub fn assert_pdp_base_url(raw: &str) -> Result<()> {
    let url = url::Url::parse(raw.trim()).map_err(|e| OpenFgaError::Config(e.to_string()))?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err(OpenFgaError::Config(
            "PDP URL must not embed credentials".into(),
        ));
    }
    let loopback = match url.host() {
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        Some(url::Host::Domain(host)) => host.eq_ignore_ascii_case("localhost"),
        None => false,
    };
    match url.scheme() {
        "https" => Ok(()),
        "http" if loopback => Ok(()),
        _ => Err(OpenFgaError::Config(
            "PDP URL must be https or loopback http".into(),
        )),
    }
}

/// Interpret an OpenFGA Check HTTP body.
///
/// `allowed` is true only when the field is the JSON boolean `true`. A missing
/// field is deny (fail closed). A non-boolean value is an error, never allow.
pub fn parse_check_response(body: &Value) -> Result<bool> {
    match body.get("allowed") {
        None => Ok(false),
        Some(Value::Bool(allowed)) => Ok(*allowed),
        Some(_) => Err(OpenFgaError::Http(
            "check response `allowed` is not a boolean".into(),
        )),
    }
}

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
        assert_pdp_base_url(&base)?;
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
        assert_pdp_base_url(&self.base)?;
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
        assert_pdp_base_url(&self.base)?;
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
        assert_pdp_base_url(&self.base)?;
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
        assert_pdp_base_url(&self.base)?;
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
        assert_pdp_base_url(&self.base)?;
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
        parse_check_response(&body)
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

    #[test]
    fn check_response_is_fail_closed() {
        assert!(!parse_check_response(&json!({})).unwrap());
        assert!(!parse_check_response(&json!({"allowed": false})).unwrap());
        assert!(parse_check_response(&json!({"allowed": true})).unwrap());
        assert!(parse_check_response(&json!({"allowed": "yes"})).is_err());
    }
}

#[cfg(test)]
mod pact {
    use super::*;

    #[test]
    fn property_https_and_loopback_http_are_accepted() {
        for ok in [
            "https://fga.example",
            "http://127.0.0.1:8080",
            "http://localhost:8080",
            "http://[::1]:8080",
        ] {
            assert!(assert_pdp_base_url(ok).is_ok(), "{ok}");
        }
    }

    #[test]
    fn adversarial_cleartext_remote_and_userinfo_are_refused() {
        for bad in [
            "http://evil.example/check",
            "https://user:secret@fga.example",
            "ftp://127.0.0.1",
            "not-a-url",
        ] {
            assert!(assert_pdp_base_url(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn chaos_missing_allowed_never_becomes_allow() {
        for body in [
            json!({}),
            json!({"allowed": false}),
            json!({"allowed": "yes"}),
        ] {
            let allowed = parse_check_response(&body).unwrap_or(false);
            assert!(!allowed, "{body}");
        }
    }

    #[test]
    fn contract_http_guard_is_in_source_before_send() {
        let src = include_str!("lib.rs");
        let production = src.split("#[cfg(test)]").next().unwrap();
        for method in [
            "health",
            "create_store",
            "write_authorization_model",
            "write_tuples",
            "check_tuple",
        ] {
            let body = production
                .split(&format!("pub async fn {method}"))
                .nth(1)
                .unwrap_or_else(|| panic!("{method}"));
            let body = body.split("\n    pub async fn ").next().unwrap();
            let pin = body
                .find("assert_pdp_base_url(&self.base)")
                .unwrap_or_else(|| panic!("{method} guard"));
            let send = body
                .find(".send()")
                .unwrap_or_else(|| panic!("{method} send"));
            assert!(pin < send, "{method}");
        }
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
