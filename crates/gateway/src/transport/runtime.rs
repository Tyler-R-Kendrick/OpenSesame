//! The Host's transport runtime: the generations a listener serves, the live
//! service-binding set, and the facts the operator status route reports.
//!
//! Building it is the whole of EXPLICIT-ENFORCEMENT for the Host. A
//! deployment that configured nothing gets `None` and every service purpose
//! stays unreachable. A deployment that configured a listener gets a runtime
//! or an error — there is no third outcome where a required profile quietly
//! serves plaintext. Identity material is resolved through exactly three
//! sources (PEM files, a managed certificate reference, the SPIFFE Workload
//! API) and a source that cannot produce a *usable* identity fails the
//! build rather than downgrading the policy.

use std::net::SocketAddr;
use std::sync::{Arc, RwLock};
use std::time::Duration;

use opensesame_domain::transport::{
    ServiceBindingSet, TransportError, TransportPolicy, TrustProfileKind, TrustProfileRef,
};
use opensesame_ingress_evidence::{
    originating_peer_layer, BindingSetAdmission, IngressLimits, OriginatingPeerLayer,
};
use opensesame_spiffe_source::sink::TransportGenerationsSink;
use opensesame_spiffe_source::{SourcePhase, SpiffeSource, SpiffeSourceConfig, SpiffeSourceHandle};
use opensesame_storage::Db;
use opensesame_transport_security::env::{NativeIdentitySpec, NativeTrustSpec};
use opensesame_transport_security::{
    env as tls_env, GenerationCandidate, TlsIdentity, TransportGenerations, TrustBundle,
};

use super::bindings::{self, BindingsSource};
use super::config::{AuthMode, ListenerConfig, TransportConfig};
use super::status::{SharedFacts, TransportFacts};
use super::ManagedIdentityResolver;

/// How long the build waits for the Workload API to deliver the first SVID
/// before refusing to start. A `spiffe` identity that never arrives is a
/// startup failure, not a reason to serve without one.
pub const SPIFFE_FIRST_SVID_TIMEOUT: Duration = Duration::from_secs(30);

/// Everything the Host's secure listener, service admission and operator
/// routes read.
pub struct TransportRuntime {
    /// Atomically swapped credential/trust generations.
    pub generations: Arc<TransportGenerations>,
    /// The live service-binding set, shared with the ingress admission.
    pub bindings: Arc<RwLock<ServiceBindingSet>>,
    /// Where the live set came from (env file, store, or the empty default).
    pub bindings_source: BindingsSource,
    /// The secure listener's policy (`ExistingLocal` when none is configured).
    pub policy: TransportPolicy,
    /// The secure listener's address, when one is configured.
    pub listen: Option<SocketAddr>,
    /// The listener id stamped into every `ListenerProvenance`.
    pub listener_id: String,
    /// The trust profile peers of this listener are bound under.
    pub client_trust_profile: TrustProfileRef,
    /// Observed authentication and probe results.
    pub status: SharedFacts,
    pub mapping_auth: AuthMode,
    pub callout_auth: AuthMode,
    /// The configuration this runtime was built from.
    pub config: TransportConfig,
    /// Present only on the `trusted_ingress` profile.
    pub ingress_layer: Option<OriginatingPeerLayer>,
    /// Kept alive for the process lifetime when the identity is a SPIFFE SVID.
    pub spiffe: Option<SpiffeSourceHandle>,
}

impl std::fmt::Debug for TransportRuntime {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TransportRuntime")
            .field("policy", &self.policy)
            .field("listener_id", &self.listener_id)
            .field("bindings_source", &self.bindings_source)
            .field("generation", &self.generations.current().number)
            .finish_non_exhaustive()
    }
}

impl TransportRuntime {
    /// Build from the process environment and the Host store.
    ///
    /// `Ok(None)` when nothing about transport is configured — the
    /// unconfigured optional feature, which is not an error (§ charter
    /// EXPLICIT-ENFORCEMENT). Otherwise the runtime, or the configuration's
    /// own error.
    ///
    /// # Errors
    ///
    /// Any [`TransportError`] from reading the environment, loading identity
    /// or trust material, or parsing the bindings document.
    pub async fn build(
        config: TransportConfig,
        db: &Db,
        resolver: &dyn ManagedIdentityResolver,
    ) -> Result<Option<Arc<Self>>, TransportError> {
        if config.listener.is_none()
            && config.service_bindings_file.is_none()
            && config.mapping_auth != AuthMode::Mtls
            && config.callout_auth != AuthMode::Mtls
        {
            return Ok(None);
        }
        let loaded = bindings::load(db, config.service_bindings_file.as_deref()).await?;
        let bindings = Arc::new(RwLock::new(loaded.set));
        let listener = config.listener.clone();
        let (generations, spiffe) = match listener.as_ref() {
            Some(listener) => build_generations(listener, resolver).await?,
            None => (empty_generations()?, None),
        };
        let client_trust_profile = listener.as_ref().map_or_else(
            || TrustProfileRef::new(super::config::DEFAULT_CLIENT_TRUST_PROFILE),
            |l| Ok(l.client_trust_profile.clone()),
        )?;
        let ingress_layer = match listener.as_ref() {
            Some(l) if l.policy == TransportPolicy::TrustedIngress => {
                Some(build_ingress_layer(l, &bindings)?)
            }
            _ => None,
        };
        Ok(Some(Arc::new(Self {
            generations,
            bindings,
            bindings_source: loaded.source,
            policy: listener
                .as_ref()
                .map_or(TransportPolicy::ExistingLocal, |l| l.policy),
            listen: listener.as_ref().map(|l| l.listen),
            listener_id: super::HOST_TLS_LISTENER.to_owned(),
            client_trust_profile,
            status: Arc::new(RwLock::new(TransportFacts::default())),
            mapping_auth: config.mapping_auth,
            callout_auth: config.callout_auth,
            config,
            ingress_layer,
            spiffe,
        })))
    }

    /// The current generation number.
    #[must_use]
    pub fn generation(&self) -> u64 {
        self.generations.current().number
    }

    /// `(generation, activated_at, identity not_after)` for the status view.
    #[must_use]
    pub fn installed(
        &self,
    ) -> Option<(
        u64,
        chrono::DateTime<chrono::Utc>,
        Option<chrono::DateTime<chrono::Utc>>,
    )> {
        let current = self.generations.current();
        current.identity.as_ref().map(|identity| {
            (
                current.number,
                current.activated_at,
                Some(identity.not_after()),
            )
        })
    }

    /// The Workload API source's own truthful credential status, when the
    /// identity comes from one. Custody there is `workload_api_delivered`:
    /// the key was handed to this process, and the source — not this
    /// struct — is what knows whether it is still live.
    #[must_use]
    pub fn spiffe_credential(
        &self,
        now: chrono::DateTime<chrono::Utc>,
    ) -> Option<opensesame_domain::transport::CredentialStatus> {
        self.spiffe
            .as_ref()
            .map(|handle| handle.current().credential_status(now))
    }

    /// The per-listener revoked-leaf hook: a thumbprint any binding denies is
    /// refused at the handshake and again on every request of an already-open
    /// connection (AT-TLS-REVOKEDLIVE).
    #[must_use]
    pub fn deny_thumbprint_hook(&self) -> opensesame_transport_security::DenyThumbprint {
        let bindings = Arc::clone(&self.bindings);
        Arc::new(move |thumbprint: &str| {
            bindings
                .read()
                .is_ok_and(|set| super::bindings::denies_thumbprint(&set, thumbprint))
        })
    }

    /// A snapshot of the live binding set.
    #[must_use]
    pub fn binding_set(&self) -> ServiceBindingSet {
        self.bindings
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }
}

/// A generation with no identity and no trust: the Host has bindings or an
/// mTLS client mode but no secure listener of its own.
fn empty_generations() -> Result<Arc<TransportGenerations>, TransportError> {
    let generation = GenerationCandidate::default().into_generation(1, chrono::Utc::now())?;
    Ok(TransportGenerations::new(generation))
}

async fn build_generations(
    listener: &ListenerConfig,
    resolver: &dyn ManagedIdentityResolver,
) -> Result<(Arc<TransportGenerations>, Option<SpiffeSourceHandle>), TransportError> {
    if let NativeIdentitySpec::Spiffe { .. } = &listener.identity {
        return start_spiffe(listener).await.map(|(g, h)| (g, Some(h)));
    }
    let identity = resolve_identity(&listener.identity, resolver).await?;
    let mut candidate = GenerationCandidate {
        identity: Some(identity),
        identity_required: true,
        ..GenerationCandidate::default()
    };
    if let Some(spec) = &listener.client_trust {
        let bundle = load_trust(&listener.client_trust_profile, spec, listener)?;
        candidate
            .peer_trust
            .insert(listener.client_trust_profile.clone(), bundle);
    }
    let generation = candidate.into_generation(1, chrono::Utc::now())?;
    Ok((TransportGenerations::new(generation), None))
}

/// PEM now, managed through the custody bridge. A `managed` reference the
/// bridge cannot resolve is an error here so a configured listener never
/// falls back to no identity at all.
async fn resolve_identity(
    spec: &NativeIdentitySpec,
    resolver: &dyn ManagedIdentityResolver,
) -> Result<Arc<TlsIdentity>, TransportError> {
    match spec {
        NativeIdentitySpec::PemFiles { cert, key } => {
            tls_env::read_pem_identity(cert, key).map(Arc::new)
        }
        NativeIdentitySpec::ManagedCertificate { certificate_id } => {
            resolver.resolve(certificate_id).await
        }
        NativeIdentitySpec::Spiffe { .. } => Err(TransportError::SourceUnsupported),
    }
}

fn load_trust(
    profile: &TrustProfileRef,
    spec: &NativeTrustSpec,
    listener: &ListenerConfig,
) -> Result<TrustBundle, TransportError> {
    match spec {
        NativeTrustSpec::PemFile { path, kind } => {
            let pem = std::fs::read(path)
                .map_err(|e| TransportError::malformed(format!("client trust bundle: {e}")))?;
            let bundle = TrustBundle::from_pem(profile.clone(), *kind, &pem)?;
            match &listener.crl_file {
                Some(crl) => {
                    let crl_pem = std::fs::read(crl)
                        .map_err(|e| TransportError::malformed(format!("crl file: {e}")))?;
                    bundle.with_crls(&crl_pem)
                }
                None => Ok(bundle),
            }
        }
        // The Workload API delivers the domain's bundle; a file cannot stand
        // in for it, and pretending otherwise would trust the wrong anchors.
        NativeTrustSpec::SpiffeTrustDomain { .. } => Err(TransportError::SourceUnsupported),
    }
}

/// Start the Workload API source and wait for the first SVID. The listener
/// is bound only after a real generation exists.
async fn start_spiffe(
    listener: &ListenerConfig,
) -> Result<(Arc<TransportGenerations>, SpiffeSourceHandle), TransportError> {
    let config = SpiffeSourceConfig::from_native_spec(&listener.identity)
        .map_err(|e| e.to_transport_error())?
        .ok_or(TransportError::SourceUnsupported)?;
    let generations = empty_generations()?;
    let sink = Arc::new(TransportGenerationsSink::new(Arc::clone(&generations)));
    let handle = SpiffeSource::start(config, sink);
    let ready = handle
        .wait_for(SPIFFE_FIRST_SVID_TIMEOUT, |status| {
            status.generation.is_some() || status.phase == SourcePhase::Withdrawn
        })
        .await;
    match ready {
        Ok(status) if status.generation.is_some() => Ok((generations, handle)),
        Ok(_) | Err(_) => Err(TransportError::IdentityMissing),
    }
}

/// The trusted-ingress layer: originating-client evidence is verified against
/// its own bundle, and only for a socket peer the binding set names as an
/// ingress. The bundle is never the one that verified the ingress itself.
fn build_ingress_layer(
    listener: &ListenerConfig,
    bindings: &Arc<RwLock<ServiceBindingSet>>,
) -> Result<OriginatingPeerLayer, TransportError> {
    let path = listener
        .ingress_originating_trust_file
        .as_ref()
        .ok_or_else(|| {
            TransportError::malformed(
                "OPENSESAME_INGRESS_ORIGINATING_TRUST_FILE is required for trusted_ingress",
            )
        })?;
    let pem = std::fs::read(path)
        .map_err(|e| TransportError::malformed(format!("originating trust bundle: {e}")))?;
    let trust = Arc::new(TrustBundle::from_pem(
        TrustProfileRef::new("originating-clients")?,
        TrustProfileKind::PrivateRoot,
        &pem,
    )?);
    let admission = Arc::new(BindingSetAdmission::new(Arc::clone(bindings)));
    Ok(originating_peer_layer(
        admission,
        trust,
        IngressLimits::DEFAULT,
    ))
}
