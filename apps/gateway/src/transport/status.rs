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

use crate::transport_lifecycle::{activation, LifecycleState};

use super::config::{AuthMode, TransportConfig};
use super::runtime::TransportRuntime;

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
    mapping_auth: AuthMode,
    callout_auth: AuthMode,
    policy: TransportPolicy,
    managed: &CapabilityOutcome,
) -> TransportCapabilities {
    TransportCapabilities::native(
        CapabilityOutcome::Supported,
        managed.clone(),
        CapabilityOutcome::Supported,
        // This side presents a client certificate on an outbound connection
        // when either of its own service clients is in `mtls` mode.
        mapping_auth == AuthMode::Mtls || callout_auth == AuthMode::Mtls,
        policy.authenticates_client(),
    )
}

/// Assemble the view from the live runtime. Every dimension is read from the
/// thing that actually knows it: the configuration for `desired`, the
/// generation (or the Workload API source) for `credential` and `runtime`,
/// and the recorded facts for `observed` and `enforcement`.
#[must_use]
pub fn view(
    runtime: &TransportRuntime,
    facts: &TransportFacts,
    managed: &CapabilityOutcome,
    lifecycle: &LifecycleState,
) -> TransportStatusView {
    let config: &TransportConfig = &runtime.config;
    let installed = runtime.installed();
    let desired = config
        .listener
        .as_ref()
        .map_or(TransportPolicy::ExistingLocal, |l| l.policy);
    let (credential, installed_runtime) = match (config.listener.as_ref(), installed) {
        (None, _) => (CredentialStatus::Unconfigured, RuntimeStatus::NotLoaded),
        (Some(listener), None) => (
            runtime
                .spiffe_credential(Utc::now())
                .unwrap_or_else(|| credential_unloaded(&listener.identity)),
            RuntimeStatus::NotLoaded,
        ),
        (Some(listener), Some((generation, loaded_at, _))) => {
            let (_, kind) = custody_of(&listener.identity);
            // The lifecycle owns this dimension: it reports `Revoked` ahead of
            // `Expired` ahead of `Configured`, and consults the revoked-leaf
            // denylist — a locally built view has no revoked arm at all and
            // would report a revoked leaf as configured and healthy.
            let credential = activation::credential_status(&runtime.generations, kind, lifecycle);
            let installed_runtime = match &facts.reload_failure {
                Some(code) => RuntimeStatus::ReloadFailed {
                    generation,
                    code: code.clone(),
                },
                None => RuntimeStatus::Loaded {
                    generation,
                    loaded_at,
                },
            };
            (credential, installed_runtime)
        }
    };
    TransportStatusView {
        target: super::HOST_TLS_LISTENER.to_owned(),
        desired,
        credential,
        runtime: installed_runtime,
        observed: facts.observed.clone(),
        enforcement: facts
            .enforcement
            .clone()
            .unwrap_or(EnforcementStatus::Unverified),
        capabilities: capabilities(runtime.mapping_auth, runtime.callout_auth, desired, managed),
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
