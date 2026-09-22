//! The enforcement probe: the only way `EnforcementStatus::Verified` is ever
//! written.
//!
//! A successful authenticated connection proves the target *accepted* a
//! certificate. It says nothing about whether the target refuses a caller
//! without one, so the probe runs both halves and records them separately.
//! The target is one of three fixed words — never a host, URL, port, or
//! address from the request body — so an unprivileged diagnostic can not be
//! turned into an egress oracle or a port scanner (AT-EVIDENCE-PROBE), and
//! the route it asks for is always the harmless `/health/live`.
//!
//! Where the probe dials comes from the deployment plane: the Host's own
//! `OPENSESAME_TLS_LISTEN` for `host-tls`, `OPENSESAME_WORKER_PROBE_ADDR` for
//! `worker`, `OPENSESAME_MAPPING_PROBE_ADDR` for `identity-mapping`. The
//! client identity it presents is `OPENSESAME_PROBE_TLS_*` and nothing else.

use std::net::SocketAddr;
use std::time::Duration;

use chrono::{Duration as ChronoDuration, Utc};
use opensesame_domain::transport::{EnforcementStatus, TransportError};
use opensesame_transport_security::env::{self as tls_env, Lookup, ServerExpectation};
use opensesame_transport_security::{reqwest_builder, ClientProfile, ServerNamePolicy, TrustBundle};

use super::runtime::TransportRuntime;

/// Deployment prefix for the probe's own client identity.
pub const PROBE_TLS_PREFIX: &str = "OPENSESAME_PROBE_TLS";
/// How long a verification stays fresh before it must be re-run.
pub const FRESH_FOR: ChronoDuration = ChronoDuration::minutes(15);
/// The one route a probe ever requests.
pub const PROBE_PATH: &str = "/health/live";

/// The fixed allowlist. Parsing is the whole of the input validation: there
/// is no branch that takes a caller-supplied destination.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProbeTarget {
    HostTls,
    Worker,
    IdentityMapping,
}

impl ProbeTarget {
    /// Exactly `host-tls`, `worker`, or `identity-mapping`.
    #[must_use]
    pub fn parse(word: &str) -> Option<Self> {
        match word {
            "host-tls" => Some(Self::HostTls),
            "worker" => Some(Self::Worker),
            "identity-mapping" => Some(Self::IdentityMapping),
            _ => None,
        }
    }

    #[must_use]
    pub const fn label(self) -> &'static str {
        match self {
            Self::HostTls => "host-tls",
            Self::Worker => "worker",
            Self::IdentityMapping => "identity-mapping",
        }
    }

    /// The deployment variable that names this target's address. `host-tls`
    /// has none: it is the Host's own configured listener.
    #[must_use]
    pub const fn address_var(self) -> Option<&'static str> {
        match self {
            Self::HostTls => None,
            Self::Worker => Some("OPENSESAME_WORKER_PROBE_ADDR"),
            Self::IdentityMapping => Some("OPENSESAME_MAPPING_PROBE_ADDR"),
        }
    }
}

/// Everything one probe run needs. Built from configuration only.
pub struct ProbePlan {
    pub target: ProbeTarget,
    pub addr: SocketAddr,
    pub profile: ClientProfile,
    pub authority: String,
}

fn process_env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.trim().is_empty())
}

/// Resolve the plan for `target`.
///
/// # Errors
///
/// `EnforcementUnsupported` when this deployment configured no address or no
/// probe identity for the target; otherwise the loader's own error.
pub fn plan(runtime: &TransportRuntime, target: ProbeTarget) -> Result<ProbePlan, TransportError> {
    plan_from(runtime, target, &process_env)
}

/// [`plan`] over a lookup, so tests never touch the process environment.
///
/// # Errors
///
/// As [`plan`].
pub fn plan_from(
    runtime: &TransportRuntime,
    target: ProbeTarget,
    lookup: &Lookup<'_>,
) -> Result<ProbePlan, TransportError> {
    let addr = match target.address_var() {
        None => runtime
            .listen
            .ok_or(TransportError::EnforcementUnsupported)?,
        Some(var) => lookup(var)
            .and_then(|raw| raw.trim().parse::<SocketAddr>().ok())
            .ok_or(TransportError::EnforcementUnsupported)?,
    };
    let identity_spec = tls_env::load_identity_from(PROBE_TLS_PREFIX, lookup)?
        .ok_or(TransportError::EnforcementUnsupported)?;
    let trust_spec = tls_env::load_trust_from(PROBE_TLS_PREFIX, lookup)?
        .ok_or(TransportError::EnforcementUnsupported)?;
    let expectation = tls_env::load_server_expectation_from(PROBE_TLS_PREFIX, lookup)?
        .ok_or(TransportError::EnforcementUnsupported)?;
    let identity = match identity_spec {
        tls_env::NativeIdentitySpec::PemFiles { cert, key } => {
            std::sync::Arc::new(tls_env::read_pem_identity(&cert, &key)?)
        }
        // A probe never mints, resolves sealed custody, or opens a Workload
        // API socket of its own: it presents an already-provisioned file pair.
        _ => return Err(TransportError::EnforcementUnsupported),
    };
    let server_trust = match trust_spec {
        tls_env::NativeTrustSpec::PemFile { path, kind } => {
            let pem = std::fs::read(&path)
                .map_err(|e| TransportError::malformed(format!("probe trust bundle: {e}")))?;
            TrustBundle::from_pem(
                opensesame_domain::transport::TrustProfileRef::new("probe")?,
                kind,
                &pem,
            )?
        }
        tls_env::NativeTrustSpec::SpiffeTrustDomain { .. } => {
            return Err(TransportError::EnforcementUnsupported)
        }
    };
    let (server_name, authority) = match expectation {
        ServerExpectation::Dns(name) => (ServerNamePolicy::Dns(name.clone()), name),
        ServerExpectation::SpiffeId(id) => {
            (ServerNamePolicy::SpiffeId(id), addr.ip().to_string())
        }
    };
    Ok(ProbePlan {
        target,
        addr,
        authority,
        profile: ClientProfile {
            server_trust,
            server_name,
            identity: Some(identity),
            min_version: opensesame_domain::transport::TlsVersion::Tls13,
        },
    })
}

/// Run both halves and return what was actually observed.
///
/// # Errors
///
/// Only a configuration error: a refused connection is a *result*, not a
/// failure of the probe.
pub async fn run(plan: &ProbePlan, generation: u64) -> Result<EnforcementStatus, TransportError> {
    let accepted = request(plan, true).await;
    let without = request(plan, false).await;
    let at = Utc::now();
    Ok(EnforcementStatus::Verified {
        at,
        target: plan.target.label().to_owned(),
        generation,
        accepted_with_certificate: accepted,
        rejected_without_certificate: !without,
        fresh_until: at + FRESH_FOR,
    })
}

/// One half. Egress is fenced exactly as the mapping client's is: no proxy,
/// no redirects, a single pinned address, short timeouts, and one harmless
/// route.
async fn request(plan: &ProbePlan, with_certificate: bool) -> bool {
    let mut profile = plan.profile.clone();
    if !with_certificate {
        profile.identity = None;
    }
    let base = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(2))
        .timeout(Duration::from_secs(5))
        .resolve_to_addrs(&plan.authority, &[plan.addr]);
    let Ok(builder) = reqwest_builder(&profile, base) else {
        return false;
    };
    let Ok(client) = builder.build() else {
        return false;
    };
    let port = plan.addr.port();
    let url = format!("https://{}:{port}{PROBE_PATH}", plan.authority);
    match client.get(url).send().await {
        Ok(response) => response.status().is_success(),
        Err(_) => false,
    }
}
