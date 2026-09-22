//! The Host's transport status: five independent dimensions, never one
//! collapsed lifecycle.
//!
//! `desired` is what the deployment plane asked for, `credential` is what
//! material the runtime actually holds and under whose custody, `runtime` is
//! which generation is installed, `observed` is a peer that really
//! authenticated, and `enforcement` is a *probe* result — a positive and a
//! negative half, bound to the generation that produced it. A successful
//! authenticated connection is recorded as `observed`; it never sets
//! `enforcement`, because accepting a certificate is not the same fact as
//! refusing a caller without one.
//!
//! Nothing here carries a path, a distinguished name, a socket, a key, or a
//! tenant topology: [`opensesame_domain::transport::PeerEvidenceView`] is the
//! widest thing a status body ever contains.

use std::sync::{Arc, RwLock};

use chrono::Utc;
use opensesame_domain::transport::{
    CapabilityOutcome, CredentialStatus, Custody, EnforcementStatus, IdentitySourceKind,
    ObservedAuthentication, RuntimeStatus, TransportCapabilities, TransportPolicy,
    TransportStatusView, VerifiedPeer,
};
use opensesame_transport_security::env::NativeIdentitySpec;

use super::config::TransportConfig;
use super::managed::UNWIRED_REASON;

/// The mutable half of the status: what has been observed at runtime.
#[derive(Clone, Debug, Default)]
pub struct TransportFacts {
    pub observed: Option<ObservedAuthentication>,
    pub enforcement: Option<EnforcementStatus>,
    /// Set when a generation activation failed; cleared by the next success.
    pub reload_failure: Option<String>,
}

/// Shared handle to [`TransportFacts`].
pub type SharedFacts = Arc<RwLock<TransportFacts>>;

/// Record a peer that really authenticated against this Host listener.
pub fn record_observation(facts: &SharedFacts, target: &str, peer: &VerifiedPeer) {
    let observation = ObservedAuthentication {
        at: Utc::now(),
        observer: "host-gateway".to_owned(),
        target: target.to_owned(),
        generation: peer.credential_generation(),
        peer: peer.view(),
    };
    if let Ok(mut guard) = facts.write() {
        guard.observed = Some(observation);
    }
}

/// Record the outcome of a [`super::probe`] run.
pub fn record_enforcement(facts: &SharedFacts, status: EnforcementStatus) {
    if let Ok(mut guard) = facts.write() {
        guard.enforcement = Some(status);
    }
}

/// The custody an identity source actually provides. Truthful, never
/// aspirational: PEM files on disk are exportable, the Workload API hands
/// this process the key, and a managed certificate's key is sealed to the
/// Host.
#[must_use]
pub const fn custody_of(spec: &NativeIdentitySpec) -> (Custody, IdentitySourceKind) {
    match spec {
        NativeIdentitySpec::PemFiles { .. } => {
            (Custody::NativeFileExportable, IdentitySourceKind::PemFiles)
        }
        NativeIdentitySpec::ManagedCertificate { .. } => (
            Custody::HostSealedExportableToHost,
            IdentitySourceKind::ManagedCertificate,
        ),
        NativeIdentitySpec::Spiffe { .. } => (
            Custody::WorkloadApiDelivered,
            IdentitySourceKind::SpiffeWorkloadApi,
        ),
    }
}

/// What this Host can do. `server_enforces_certificate` is a *configuration*
/// fact (the listener policy requires a client certificate at the
/// handshake); whether it was ever demonstrated is `enforcement`.
#[must_use]
pub fn capabilities(
    config: &TransportConfig,
    managed: &CapabilityOutcome,
) -> TransportCapabilities {
    let policy = config.listener.as_ref().map(|l| l.policy);
    TransportCapabilities::native(
        CapabilityOutcome::Supported,
        managed.clone(),
        CapabilityOutcome::Supported,
        config.mapping_auth == super::config::AuthMode::Mtls,
        policy.is_some_and(TransportPolicy::authenticates_client),
    )
}

/// Assemble the view. `generation` is the runtime's current generation and
/// `holds_identity` says whether that generation actually carries one.
#[must_use]
pub fn view(
    config: &TransportConfig,
    facts: &TransportFacts,
    installed: Option<(u64, chrono::DateTime<Utc>, Option<chrono::DateTime<Utc>>)>,
    managed: &CapabilityOutcome,
) -> TransportStatusView {
    let desired = config
        .listener
        .as_ref()
        .map_or(TransportPolicy::ExistingLocal, |l| l.policy);
    let (credential, runtime) = match (config.listener.as_ref(), installed) {
        (None, _) => (CredentialStatus::Unconfigured, RuntimeStatus::NotLoaded),
        (Some(listener), None) => (
            credential_unloaded(&listener.identity),
            RuntimeStatus::NotLoaded,
        ),
        (Some(listener), Some((generation, loaded_at, not_after))) => {
            let (custody, kind) = custody_of(&listener.identity);
            let credential = match not_after {
                Some(not_after) if not_after > Utc::now() => CredentialStatus::Configured {
                    custody,
                    generation,
                    not_after,
                    kind,
                },
                Some(_) => CredentialStatus::Expired { generation },
                None => CredentialStatus::Unconfigured,
            };
            let runtime = match &facts.reload_failure {
                Some(code) => RuntimeStatus::ReloadFailed {
                    generation,
                    code: code.clone(),
                },
                None => RuntimeStatus::Loaded {
                    generation,
                    loaded_at,
                },
            };
            (credential, runtime)
        }
    };
    TransportStatusView {
        target: super::HOST_TLS_LISTENER.to_owned(),
        desired,
        credential,
        runtime,
        observed: facts.observed.clone(),
        enforcement: facts
            .enforcement
            .clone()
            .unwrap_or(EnforcementStatus::Unverified),
        capabilities: capabilities(config, managed),
    }
    .reconciled(Utc::now())
}

/// A configured but not yet installed identity. A `managed` source with no
/// custody bridge is reported as needing external provisioning rather than
/// as "no certificate": the operator registered one, this Host cannot reach
/// it.
fn credential_unloaded(spec: &NativeIdentitySpec) -> CredentialStatus {
    match spec {
        NativeIdentitySpec::ManagedCertificate { .. } => {
            CredentialStatus::ExternalProvisioningRequired
        }
        NativeIdentitySpec::PemFiles { .. } | NativeIdentitySpec::Spiffe { .. } => {
            CredentialStatus::Unconfigured
        }
    }
}

/// The capability outcome reported for managed custody when no bridge is
/// wired. Kept beside the status so the two never drift.
#[must_use]
pub fn unwired_managed() -> CapabilityOutcome {
    CapabilityOutcome::unsupported(UNWIRED_REASON)
}
