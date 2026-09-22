//! Operator-administered peer trust (LIFE-TRUST).
//!
//! A trust profile names the anchors used to verify a *peer*. It is never
//! derived from anything a peer presented: a CSR, a certificate extension, a
//! connector manifest or a URL in a chain cannot add an anchor here. The only
//! way in is this module's compare-and-set write, reached from the
//! configurator-gated route in [`super::routes`].
//!
//! Four rules the tests hold to:
//!
//! 1. **Every anchor is validated before anything is stored.** A set whose
//!    anchors do not all build (`TrustBundle::from_pem` refuses a non-CA, an
//!    out-of-window anchor, or a PEM webpki cannot use) is refused whole.
//! 2. **Removal is guarded.** A profile still named by an *enabled* binding
//!    cannot be removed or disabled; `force: true` does it and publishes
//!    `transport.trust.forced_removal` on the security feed, so the audit
//!    exists before the peers start failing.
//! 3. **Rollover overlap is explicitly bounded.** A profile may carry
//!    `retiring_anchors_pem` until `overlap_until` (at most
//!    [`MAX_OVERLAP_SECONDS`] out). [`reconcile`] drops them once that
//!    instant passes and re-activates; there is no open-ended "old root
//!    still works".
//! 4. **No authority substitution.** If the candidate built from the named
//!    profiles fails to activate, the write is refused and the previous
//!    generation keeps serving unchanged. Nothing falls back to a different
//!    anchor set, a base profile, or an empty bundle (`MalformedConfiguration`
//!    is the answer, never a quieter authority).
//!
//! Deployment-plane profiles (`P_TRUST_FILE`) are the base map. A stored
//! profile may not take one of their names — shadowing a file-configured
//! anchor set from a route would be exactly the privilege escalation this
//! module exists to prevent.

use std::collections::BTreeMap;

use chrono::{DateTime, Utc};
use opensesame_domain::transport::{
    ServiceBindingSet, TransportError, TrustProfileKind, TrustProfileRef,
};
use opensesame_security_events::{NoticeState, SecurityNotice, Severity};
use opensesame_transport_security::TrustBundle;
use serde::{Deserialize, Serialize};

use crate::app_state::AppState;
use crate::transport_lifecycle::activation;

/// The `host_kv` key holding the stored profiles (JSON [`TrustProfileSet`]).
pub const KV_TRUST_PROFILES: &str = "transport.trust_profiles";
/// Largest trust document accepted from the store or a `PUT`.
pub const MAX_TRUST_BYTES: usize = 64 * 1024;
/// Most profiles one deployment may store.
pub const MAX_PROFILES: usize = 32;
/// Longest rollover overlap an operator may configure (30 days).
pub const MAX_OVERLAP_SECONDS: i64 = 30 * 24 * 3_600;
/// Published when a profile is removed while a binding still names it.
pub const EVENT_FORCED_REMOVAL: &str = "transport.trust.forced_removal";
/// Published on every accepted change.
pub const EVENT_TRUST_CHANGED: &str = "transport.trust.changed";

/// One operator-registered trust profile.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct StoredTrustProfile {
    pub profile: TrustProfileRef,
    pub kind: TrustProfileKind,
    /// The anchors in force. PEM, public material only.
    pub anchors_pem: String,
    /// Anchors being retired, honoured until `overlap_until`.
    #[serde(default)]
    pub retiring_anchors_pem: Option<String>,
    /// The instant the retiring anchors stop being honoured.
    #[serde(default)]
    pub overlap_until: Option<DateTime<Utc>>,
    /// A disabled profile is kept for the record and trusted by nothing.
    pub enabled: bool,
    /// For `SpiffeTrustDomain`: the exact trust domain these anchors serve.
    #[serde(default)]
    pub trust_domain: Option<String>,
}

impl StoredTrustProfile {
    /// Build the bundle this profile contributes at `now`.
    ///
    /// # Errors
    ///
    /// `MalformedConfiguration` when an anchor is unusable, the kind and the
    /// trust domain disagree, or the overlap window is out of bounds.
    pub fn bundle(&self, now: DateTime<Utc>) -> Result<TrustBundle, TransportError> {
        self.check_shape(now)?;
        let mut pem = self.anchors_pem.clone().into_bytes();
        if self.overlap_active(now) {
            if let Some(retiring) = &self.retiring_anchors_pem {
                pem.push(b'\n');
                pem.extend_from_slice(retiring.as_bytes());
            }
        }
        TrustBundle::from_pem(self.profile.clone(), self.kind, &pem)
    }

    /// Whether the retiring anchors are still honoured at `now`.
    #[must_use]
    pub fn overlap_active(&self, now: DateTime<Utc>) -> bool {
        self.retiring_anchors_pem.is_some() && self.overlap_until.is_some_and(|until| now < until)
    }

    fn check_shape(&self, now: DateTime<Utc>) -> Result<(), TransportError> {
        self.profile.validate()?;
        if self.anchors_pem.len() > MAX_TRUST_BYTES {
            return Err(TransportError::malformed(format!(
                "trust profile {}: anchors exceed {MAX_TRUST_BYTES} bytes",
                self.profile
            )));
        }
        match (self.kind, &self.trust_domain) {
            (TrustProfileKind::SpiffeTrustDomain, Some(domain)) if !domain.is_empty() => {}
            (TrustProfileKind::SpiffeTrustDomain, _) => {
                return Err(TransportError::malformed(format!(
                    "trust profile {}: a spiffe_trust_domain profile must name its trust domain",
                    self.profile
                )))
            }
            (_, Some(_)) => {
                return Err(TransportError::malformed(format!(
                    "trust profile {}: only a spiffe_trust_domain profile carries a trust domain",
                    self.profile
                )))
            }
            (_, None) => {}
        }
        match (&self.retiring_anchors_pem, self.overlap_until) {
            (None, None) => Ok(()),
            (Some(_), Some(until)) => {
                if until <= now {
                    // Already past: the write is accepted but the anchors are
                    // not honoured. Refusing here would make a slow operator
                    // unable to store anything.
                    return Ok(());
                }
                if (until - now).num_seconds() > MAX_OVERLAP_SECONDS {
                    return Err(TransportError::malformed(format!(
                        "trust profile {}: rollover overlap exceeds {MAX_OVERLAP_SECONDS} seconds",
                        self.profile
                    )));
                }
                Ok(())
            }
            _ => Err(TransportError::malformed(format!(
                "trust profile {}: retiring_anchors_pem and overlap_until go together",
                self.profile
            ))),
        }
    }
}

/// The stored set, with the revision a `PUT` compares against.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct TrustProfileSet {
    pub revision: u32,
    pub profiles: Vec<StoredTrustProfile>,
}

impl TrustProfileSet {
    #[must_use]
    pub const fn empty() -> Self {
        Self {
            revision: 0,
            profiles: Vec::new(),
        }
    }

    /// Shape checks that do not need the anchors to parse.
    ///
    /// # Errors
    ///
    /// `MalformedConfiguration` for a duplicate name or an oversized set.
    pub fn validate(&self, now: DateTime<Utc>) -> Result<(), TransportError> {
        if self.profiles.len() > MAX_PROFILES {
            return Err(TransportError::malformed(format!(
                "trust: at most {MAX_PROFILES} profiles"
            )));
        }
        let mut seen = std::collections::BTreeSet::new();
        for profile in &self.profiles {
            profile.check_shape(now)?;
            if !seen.insert(profile.profile.clone()) {
                return Err(TransportError::malformed(format!(
                    "trust: profile {} is listed twice",
                    profile.profile
                )));
            }
        }
        Ok(())
    }

    /// The earliest overlap deadline still in the future.
    #[must_use]
    pub fn next_overlap_expiry(&self, now: DateTime<Utc>) -> Option<DateTime<Utc>> {
        self.profiles
            .iter()
            .filter(|p| p.overlap_active(now))
            .filter_map(|p| p.overlap_until)
            .min()
    }
}

/// What the last activation was built from, so [`reconcile`] can tell when a
/// bounded overlap has lapsed and the anchors must be narrowed again.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ActivatedEpoch {
    pub revision: u32,
    pub next_overlap_expiry: Option<DateTime<Utc>>,
}

/// Why a trust write was refused.
#[derive(Debug, thiserror::Error)]
pub enum TrustError {
    #[error("stale revision (current {current})")]
    StaleRevision { current: u32 },
    #[error("trust profile {profile} is still named by enabled binding {binding}")]
    StillReferenced { profile: String, binding: String },
    #[error(transparent)]
    Invalid(TransportError),
    #[error("trust store: {0}")]
    Storage(String),
}

impl TrustError {
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            Self::StaleRevision { .. } => "stale_revision",
            Self::StillReferenced { .. } => "trust_still_referenced",
            Self::Invalid(inner) => inner.code(),
            Self::Storage(_) => "storage_error",
        }
    }

    #[must_use]
    pub const fn http_status(&self) -> u16 {
        match self {
            Self::StaleRevision { .. } => 409,
            Self::StillReferenced { .. } | Self::Invalid(_) => 400,
            Self::Storage(_) => 500,
        }
    }
}

/// Read the stored set. A stored document that no longer parses is an error,
/// never a silent empty set.
///
/// # Errors
///
/// `MalformedConfiguration` when the store is unreadable or the document is
/// not a [`TrustProfileSet`].
pub async fn load(state: &AppState) -> Result<TrustProfileSet, TransportError> {
    let Some(raw) = state
        .db
        .get_host_kv(KV_TRUST_PROFILES)
        .await
        .map_err(|e| TransportError::malformed(format!("trust store: {e}")))?
    else {
        return Ok(TrustProfileSet::empty());
    };
    if raw.len() > MAX_TRUST_BYTES {
        return Err(TransportError::malformed(
            "trust: stored document exceeds the size bound",
        ));
    }
    serde_json::from_str(&raw).map_err(|e| TransportError::malformed(format!("trust store: {e}")))
}

/// Every peer-trust bundle in force at `now`: the deployment plane's, then
/// the stored profiles beside them.
///
/// # Errors
///
/// `MalformedConfiguration` when a stored profile shadows a deployment-plane
/// name or an anchor does not build.
pub fn bundles(
    base: &BTreeMap<TrustProfileRef, TrustBundle>,
    stored: &TrustProfileSet,
    now: DateTime<Utc>,
) -> Result<BTreeMap<TrustProfileRef, TrustBundle>, TransportError> {
    let mut out = base.clone();
    for profile in &stored.profiles {
        if !profile.enabled {
            continue;
        }
        if base.contains_key(&profile.profile) {
            return Err(TransportError::malformed(format!(
                "trust profile {} is configured by the deployment plane and cannot be replaced from a route",
                profile.profile
            )));
        }
        out.insert(profile.profile.clone(), profile.bundle(now)?);
    }
    Ok(out)
}

/// The first enabled binding naming `profile`, if any.
fn referenced_by(set: &ServiceBindingSet, profile: &TrustProfileRef) -> Option<String> {
    set.bindings
        .iter()
        .find(|binding| binding.enabled && !binding.revoked && binding.trust_profile == *profile)
        .map(|binding| binding.id.clone())
}

/// Compare-and-set replacement of the stored trust profiles.
///
/// Order matters and is the point: validate → build every bundle → activate
/// the new generation → only then store. An activation failure leaves both
/// the store and the serving generation exactly as they were.
///
/// # Errors
///
/// [`TrustError`].
pub async fn put_cas(
    state: &AppState,
    mut proposed: TrustProfileSet,
    actor: &str,
    force: bool,
) -> Result<TrustProfileSet, TrustError> {
    let now = Utc::now();
    proposed.validate(now).map_err(TrustError::Invalid)?;
    let current = load(state).await.map_err(TrustError::Invalid)?;
    if proposed.revision != current.revision {
        return Err(TrustError::StaleRevision {
            current: current.revision,
        });
    }
    let removed = removed_or_disabled(&current, &proposed);
    let bindings = live_bindings(state).await;
    let mut forced = Vec::new();
    for profile in &removed {
        if let Some(binding) = referenced_by(&bindings, profile) {
            if !force {
                return Err(TrustError::StillReferenced {
                    profile: profile.name.clone(),
                    binding,
                });
            }
            forced.push((profile.clone(), binding));
        }
    }
    let base = state.transport_lifecycle.base_trust();
    let peer_trust = bundles(&base, &proposed, now).map_err(TrustError::Invalid)?;
    reactivate(state, peer_trust)
        .await
        .map_err(TrustError::Invalid)?;
    proposed.revision = current
        .revision
        .checked_add(1)
        .ok_or_else(|| TrustError::Invalid(TransportError::malformed("trust: revision overflow")))?;
    let json = serde_json::to_string(&proposed).map_err(|e| TrustError::Storage(e.to_string()))?;
    if json.len() > MAX_TRUST_BYTES {
        return Err(TrustError::Invalid(TransportError::malformed(format!(
            "trust: document exceeds {MAX_TRUST_BYTES} bytes"
        ))));
    }
    state
        .db
        .set_host_kv(KV_TRUST_PROFILES, &json)
        .await
        .map_err(|e| TrustError::Storage(e.to_string()))?;
    state.transport_lifecycle.with_trust_epoch(|epoch| {
        epoch.revision = proposed.revision;
        epoch.next_overlap_expiry = proposed.next_overlap_expiry(now);
    });
    for (profile, binding) in forced {
        publish(state, EVENT_FORCED_REMOVAL, Severity::Critical, actor, &profile,
            format!("trust profile {profile} removed while binding {binding} still names it"),
        ).await;
    }
    publish(state, EVENT_TRUST_CHANGED, Severity::Warning, actor,
        &TrustProfileRef { name: "set".into() },
        format!("transport trust profiles replaced at revision {}", proposed.revision),
    ).await;
    Ok(proposed)
}

fn removed_or_disabled(current: &TrustProfileSet, proposed: &TrustProfileSet) -> Vec<TrustProfileRef> {
    current
        .profiles
        .iter()
        .filter(|was| was.enabled)
        .filter(|was| {
            !proposed
                .profiles
                .iter()
                .any(|now| now.profile == was.profile && now.enabled)
        })
        .map(|was| was.profile.clone())
        .collect()
}

async fn live_bindings(state: &AppState) -> ServiceBindingSet {
    if let Some(live) = state.transport_lifecycle.bindings() {
        return live
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
    }
    crate::transport::bindings::load(&state.db, None)
        .await
        .map_or_else(|_| ServiceBindingSet::empty(), |loaded| loaded.set)
}

/// Swap the peer-trust map into a new generation, keeping the identity that
/// is serving. Nothing else about the generation changes.
async fn reactivate(
    state: &AppState,
    peer_trust: BTreeMap<TrustProfileRef, TrustBundle>,
) -> Result<(), TransportError> {
    let Some(generations) = state.transport_lifecycle.generations() else {
        return Ok(());
    };
    let current = generations.current();
    let candidate = opensesame_transport_security::GenerationCandidate {
        identity: current.identity.clone(),
        peer_trust,
        own_trust: None,
        identity_required: current.identity.is_some(),
    };
    activation::activate_candidate(
        state,
        crate::transport_lifecycle::HOST_LISTENER_TARGET,
        &generations,
        candidate,
    )
    .await
    .map(|_| ())
}

/// Narrow the anchors again once a bounded rollover overlap has lapsed.
/// Called from the renewal loop's tick; a no-op when nothing is overlapping.
///
/// # Errors
///
/// The store's or the activation's refusal.
pub async fn reconcile(state: &AppState, now: DateTime<Utc>) -> Result<(), TransportError> {
    let due = state
        .transport_lifecycle
        .with_trust_epoch(|epoch| epoch.next_overlap_expiry.is_some_and(|at| now >= at));
    if !due {
        return Ok(());
    }
    let stored = load(state).await?;
    let base = state.transport_lifecycle.base_trust();
    let peer_trust = bundles(&base, &stored, now)?;
    reactivate(state, peer_trust).await?;
    state.transport_lifecycle.with_trust_epoch(|epoch| {
        epoch.next_overlap_expiry = stored.next_overlap_expiry(now);
    });
    Ok(())
}

async fn publish(
    state: &AppState,
    event_type: &str,
    severity: Severity,
    actor: &str,
    profile: &TrustProfileRef,
    summary: String,
) {
    let now = Utc::now();
    let notice = SecurityNotice {
        event_type: event_type.to_owned(),
        severity,
        state: NoticeState::Firing,
        organization_id: state.connection_organization.to_string(),
        subject_kind: "trust_profile".into(),
        subject_id: profile.name.clone(),
        label: None,
        occurred_at: now,
        summary,
        detail: Some(format!("actor {actor}")),
        payload: serde_json::json!({ "actor": actor, "secrets_returned": false }),
    };
    crate::security::dispatch::publish(state, &notice, now).await;
}
