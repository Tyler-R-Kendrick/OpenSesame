//! Host `TaskBus` / NATS configuration (operator plane).
//!
//! Precedence: process env (`OPENSESAME_TASKBUS` / `NATS_URL`) wins over durable
//! `host_kv` so Compose keeps working. Pages never dials NATS — only Host does.
//!
//! The *transport* is resolved the same way and separately: `OPENSESAME_NATS_*`
//! (deployment plane, the only place a path/seed/credential may be named) wins
//! over the stored public policy in `host_kv` (`taskbus.transport`), which
//! holds references only. Everything an operator can read back — the view, the
//! stored row — is [`NatsTransportView`] / `NatsTransportPublic`: booleans,
//! profile names, a server name. No locator is expressible there (ADR 0130 §8).
//!
//! Provisioning is separate from runtime use: [`provision`] is the one-time
//! operator action that may create the stream and the durable consumers, with
//! its own credential (`OPENSESAME_NATS_PROVISION_*`). Every runtime
//! constructor — boot, apply, ping, the backup wake consumer — connects with
//! `provision: false` on a secure profile and fails closed (`not_provisioned`)
//! rather than creating anything.

use opensesame_storage::Db;
use opensesame_task_bus::{
    NatsRole, NatsTransportPublic, NatsTransportSource, NatsTransportSpec, NatsTransportView,
    TaskBus, TaskBusBackend, UnavailableTaskBus,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

pub const KV_BACKEND: &str = "taskbus.backend";
pub const KV_NATS_URL: &str = "taskbus.nats_url";
/// Stored *public* transport policy (`NatsTransportPublic` JSON). References
/// only — the type cannot express a path, a seed or a token.
pub const KV_TRANSPORT: &str = "taskbus.transport";

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
    /// Transport policy as an operator may see it: never a locator.
    pub transport: NatsTransportView,
}

#[derive(Clone, Debug)]
pub struct ResolvedTaskBus {
    pub backend: TaskBusBackend,
    pub nats_url: Option<String>,
    pub source: TaskBusSource,
    /// Resolved client transport (env over stored over plaintext loopback).
    pub transport: NatsTransportSpec,
}

impl ResolvedTaskBus {
    /// A TLS profile: the legacy plaintext loopback fallbacks do not apply.
    #[must_use]
    pub fn is_secure(&self) -> bool {
        matches!(self.backend, TaskBusBackend::Nats) && self.transport.is_secure()
    }
}

/// Strip userinfo from a NATS URL so operator GETs cannot leak embedded creds.
#[must_use]
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

/// # Errors
///
/// When the URL is not `nats://`/`tls://`, is empty, or embeds credentials.
pub fn validate_nats_url(url: &str) -> Result<(), String> {
    opensesame_task_bus::validate_nats_url(url)
}

/// Resolve the client transport: deployment env, else stored public policy,
/// else the plaintext loopback profile.
async fn resolve_transport(db: &Db) -> anyhow::Result<NatsTransportSpec> {
    if let Some(spec) = NatsTransportSpec::from_env().map_err(|e| anyhow::anyhow!("{e}"))? {
        return Ok(spec);
    }
    let Some(stored) = db.get_host_kv(KV_TRANSPORT).await? else {
        return Ok(NatsTransportSpec::plaintext());
    };
    let public: NatsTransportPublic = serde_json::from_str(&stored)
        .map_err(|e| anyhow::anyhow!("stored taskbus transport is invalid: {e}"))?;
    Ok(NatsTransportSpec::from_public(
        public,
        NatsTransportSource::Stored,
    ))
}

/// Resolve effective `TaskBus` settings (env overrides stored).
///
/// # Errors
///
/// A malformed stored URL, transport policy, or `OPENSESAME_*` variable. An
/// invalid persisted setting is an error, never a silent permissive default.
pub async fn resolve(db: &Db) -> anyhow::Result<ResolvedTaskBus> {
    let transport = resolve_transport(db).await?;
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
            transport,
        });
    }

    let stored_backend = db.get_host_kv(KV_BACKEND).await?;
    let stored_url = db.get_host_kv(KV_NATS_URL).await?;
    if stored_backend.is_none() && stored_url.is_none() {
        return Ok(ResolvedTaskBus {
            backend: TaskBusBackend::Memory,
            nats_url: None,
            source: TaskBusSource::Default,
            transport,
        });
    }

    let backend = match stored_backend.as_deref().map_or("memory", str::trim) {
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
            transport,
        });
    }
    Ok(ResolvedTaskBus {
        backend: TaskBusBackend::Memory,
        nats_url: stored_url.filter(|u| !u.trim().is_empty()),
        source: TaskBusSource::Stored,
        transport,
    })
}

/// # Errors
///
/// A missing or invalid `nats_url` for the NATS backend.
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

/// Store a public transport policy. The type refuses locator-shaped fields,
/// so nothing a caller sends can name a file, a seed or a token.
///
/// # Errors
///
/// When the policy cannot be serialized or stored.
pub async fn persist_transport(db: &Db, public: &NatsTransportPublic) -> anyhow::Result<()> {
    db.set_host_kv(KV_TRANSPORT, &serde_json::to_string(public)?)
        .await?;
    Ok(())
}

/// Connect the *runtime* bus. Never provisions on a secure profile: the
/// stream and the durable consumers are the provisioning action's to create.
///
/// # Errors
///
/// A refused handshake, missing material, or an unprovisioned consumer.
pub async fn build_bus(resolved: &ResolvedTaskBus) -> anyhow::Result<Arc<dyn TaskBus>> {
    match resolved.backend {
        TaskBusBackend::Memory => Ok(Arc::new(opensesame_task_bus::InMemoryTaskBus::default())),
        TaskBusBackend::Nats => {
            let url = resolved
                .nats_url
                .as_deref()
                .map(str::trim)
                .filter(|u| !u.is_empty())
                .ok_or_else(|| anyhow::anyhow!("nats backend requires nats_url"))?;
            let provision = !resolved.transport.is_secure();
            opensesame_task_bus::create_with(
                url,
                resolved.transport.clone(),
                NatsRole::Host,
                provision,
            )
            .await
        }
    }
}

/// Boot-time construction. A *secure* profile that cannot connect becomes an
/// [`UnavailableTaskBus`] carrying the reason — never in-memory, never
/// plaintext (ADR 0130, EXPLICIT-ENFORCEMENT). The legacy plaintext loopback
/// profile keeps its in-memory fallback so an unconfigured dev box still boots.
pub async fn build_bus_or_unavailable(resolved: &ResolvedTaskBus) -> Arc<dyn TaskBus> {
    match build_bus(resolved).await {
        Ok(bus) => bus,
        Err(error) if resolved.is_secure() => {
            tracing::error!(
                %error,
                "secure TaskBus profile could not connect — the bus is unavailable (no fallback)"
            );
            Arc::new(UnavailableTaskBus::new(error.to_string()))
        }
        Err(error) => {
            tracing::warn!(
                %error,
                "TaskBus connect failed at boot — falling back to in-memory (plaintext profile)"
            );
            Arc::new(opensesame_task_bus::InMemoryTaskBus::default())
        }
    }
}

/// The one-time operator provisioning action: connect as the provisioner
/// (its own credential when `OPENSESAME_NATS_PROVISION_*` is set) and create
/// the stream plus both durable consumers. No runtime path may do this.
///
/// # Errors
///
/// A refused handshake, or a provisioner identity the server does not allow
/// to create streams or consumers.
pub async fn provision(resolved: &ResolvedTaskBus) -> anyhow::Result<()> {
    anyhow::ensure!(
        matches!(resolved.backend, TaskBusBackend::Nats),
        "provisioning requires the nats backend"
    );
    let url = resolved
        .nats_url
        .as_deref()
        .map(str::trim)
        .filter(|u| !u.is_empty())
        .ok_or_else(|| anyhow::anyhow!("provisioning requires a nats_url"))?;
    let spec = resolved.transport.for_provisioning();
    opensesame_task_bus::create_with(url, spec.clone(), NatsRole::Provisioner, true).await?;
    opensesame_task_bus::provision_backup_consumer(url, spec).await
}

#[must_use]
pub fn backend_label(backend: TaskBusBackend) -> &'static str {
    match backend {
        TaskBusBackend::Memory => "memory",
        TaskBusBackend::Nats => "nats",
    }
}

#[cfg(test)]
#[path = "taskbus_config_tests.rs"]
mod tests;
