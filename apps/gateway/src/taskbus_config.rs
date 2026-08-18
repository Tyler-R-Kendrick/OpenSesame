//! Host TaskBus / NATS configuration (operator plane).
//!
//! Precedence: process env (`OPENSESAME_TASKBUS` / `NATS_URL`) wins over durable
//! `host_kv` so Compose keeps working. Pages never dials NATS — only Host does.

use opensesame_storage::Db;
use opensesame_task_bus::{TaskBus, TaskBusBackend};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

pub const KV_BACKEND: &str = "taskbus.backend";
pub const KV_NATS_URL: &str = "taskbus.nats_url";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TaskBusSource {
    Env,
    Stored,
    Default,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TaskBusConfigView {
    pub backend: String,
    pub nats_url: Option<String>,
    pub source: TaskBusSource,
    pub status: String,
    pub last_error: Option<String>,
}

#[derive(Clone, Debug)]
pub struct ResolvedTaskBus {
    pub backend: TaskBusBackend,
    pub nats_url: Option<String>,
    pub source: TaskBusSource,
}

/// Strip userinfo from a NATS URL so operator GETs cannot leak embedded creds.
pub fn redact_nats_url(raw: &str) -> String {
    let Some(scheme_end) = raw.find("://") else {
        return raw.to_string();
    };
    let rest = &raw[scheme_end + 3..];
    let Some(at) = rest.find('@') else {
        return raw.to_string();
    };
    format!("{}://***@{}", &raw[..scheme_end], &rest[at + 1..])
}
pub fn validate_nats_url(url: &str) -> Result<(), String> {
    opensesame_task_bus::validate_nats_url(url)
}

/// Resolve effective TaskBus settings (env overrides stored).
pub async fn resolve(db: &Db) -> anyhow::Result<ResolvedTaskBus> {
    let env_backend = std::env::var("OPENSESAME_TASKBUS")
        .ok()
        .map(|v| v.trim().to_ascii_lowercase())
        .filter(|v| !v.is_empty());
    let env_url = std::env::var("NATS_URL")
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());

    if env_backend.is_some() || env_url.is_some() {
        let backend = TaskBusBackend::from_env()?;
        return Ok(ResolvedTaskBus {
            backend,
            nats_url: env_url,
            source: TaskBusSource::Env,
        });
    }

    let stored_backend = db.get_host_kv(KV_BACKEND).await?;
    let stored_url = db.get_host_kv(KV_NATS_URL).await?;
    if stored_backend.is_none() && stored_url.is_none() {
        return Ok(ResolvedTaskBus {
            backend: TaskBusBackend::Memory,
            nats_url: None,
            source: TaskBusSource::Default,
        });
    }

    let backend = match stored_backend.as_deref().map(str::trim).unwrap_or("memory") {
        "nats" | "jetstream" => TaskBusBackend::Nats,
        _ => TaskBusBackend::Memory,
    };
    if matches!(backend, TaskBusBackend::Nats) {
        let url = stored_url
            .as_deref()
            .map(str::trim)
            .filter(|u| !u.is_empty())
            .ok_or_else(|| anyhow::anyhow!("stored nats backend missing nats_url"))?;
        validate_nats_url(url).map_err(anyhow::Error::msg)?;
        return Ok(ResolvedTaskBus {
            backend,
            nats_url: Some(url.to_string()),
            source: TaskBusSource::Stored,
        });
    }
    Ok(ResolvedTaskBus {
        backend: TaskBusBackend::Memory,
        nats_url: stored_url.filter(|u| !u.trim().is_empty()),
        source: TaskBusSource::Stored,
    })
}

pub async fn persist(
    db: &Db,
    backend: TaskBusBackend,
    nats_url: Option<&str>,
) -> anyhow::Result<()> {
    match backend {
        TaskBusBackend::Memory => {
            db.set_host_kv(KV_BACKEND, "memory").await?;
            db.delete_host_kv(KV_NATS_URL).await?;
        }
        TaskBusBackend::Nats => {
            let url = nats_url
                .map(str::trim)
                .filter(|u| !u.is_empty())
                .ok_or_else(|| anyhow::anyhow!("nats_url required"))?;
            validate_nats_url(url).map_err(anyhow::Error::msg)?;
            db.set_host_kv(KV_BACKEND, "nats").await?;
            db.set_host_kv(KV_NATS_URL, url).await?;
        }
    }
    Ok(())
}

pub async fn build_bus(resolved: &ResolvedTaskBus) -> anyhow::Result<Arc<dyn TaskBus>> {
    opensesame_task_bus::create(resolved.backend, resolved.nats_url.as_deref()).await
}

pub fn backend_label(backend: TaskBusBackend) -> &'static str {
    match backend {
        TaskBusBackend::Memory => "memory",
        TaskBusBackend::Nats => "nats",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_http_nats_urls() {
        assert!(validate_nats_url("http://127.0.0.1:4222").is_err());
        assert!(validate_nats_url("nats://127.0.0.1:4222").is_ok());
        assert!(validate_nats_url("tls://box.tailnet.ts.net:4222").is_ok());
    }

    #[test]
    fn redacts_userinfo_from_nats_urls() {
        assert_eq!(
            redact_nats_url("nats://user:s3cret@127.0.0.1:4222"),
            "nats://***@127.0.0.1:4222"
        );
        assert_eq!(
            redact_nats_url("nats://127.0.0.1:4222"),
            "nats://127.0.0.1:4222"
        );
    }

    #[tokio::test]
    async fn env_overrides_stored_backend() {
        let _guard = crate::app_state::test_env::lock();
        let prev_taskbus = std::env::var_os("OPENSESAME_TASKBUS");
        let prev_nats = std::env::var_os("NATS_URL");
        std::env::remove_var("OPENSESAME_TASKBUS");
        std::env::remove_var("NATS_URL");

        let db = opensesame_storage::Db::connect_memory().await.unwrap();
        persist(&db, TaskBusBackend::Nats, Some("nats://stored.example:4222"))
            .await
            .unwrap();

        std::env::set_var("OPENSESAME_TASKBUS", "memory");
        let resolved = resolve(&db).await.unwrap();
        assert!(matches!(resolved.source, TaskBusSource::Env));
        assert!(matches!(resolved.backend, TaskBusBackend::Memory));

        match prev_taskbus {
            Some(v) => std::env::set_var("OPENSESAME_TASKBUS", v),
            None => std::env::remove_var("OPENSESAME_TASKBUS"),
        }
        match prev_nats {
            Some(v) => std::env::set_var("NATS_URL", v),
            None => std::env::remove_var("NATS_URL"),
        }
    }
}
