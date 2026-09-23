//! Operator-administered peer trust (LIFE-TRUST).
//!
//! A trust profile names the anchors used to verify a *peer*. It is never
//! derived from anything a peer presented: a CSR, a certificate extension, a
//! connector manifest or a URL in a chain cannot add an anchor here. The only
//! way in is this module's compare-and-set write, reached from the
//! deployment-operator route in [`super::routes`].
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
use opensesame_domain::transport::{TransportError, TrustProfileKind, TrustProfileRef};
use opensesame_transport_security::TrustBundle;
use serde::{Deserialize, Serialize};

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
    /// Every profile name the activated set stored, so a later activation
    /// never mistakes a removed stored profile for a deployment-plane one.
    pub names: std::collections::BTreeSet<TrustProfileRef>,
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
    /// The serving generation is withdrawn (a revoked or lapsed source).
    /// A trust write does not bring it back; the source's next good
    /// snapshot, or an operator re-activation of a live identity, does.
    #[error("the serving transport generation is withdrawn ({})", .0.code())]
    Withdrawn(TransportError),
    /// The serving generation changed while the write was being built (a
    /// rotation, a withdrawal). Nothing was activated or stored; re-read and
    /// retry.
    #[error("the serving transport generation changed during the write; retry")]
    GenerationChanged,
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
            Self::Withdrawn(_) => "generation_withdrawn",
            Self::GenerationChanged => "generation_stale",
            Self::Storage(_) => "storage_error",
        }
    }

    #[must_use]
    pub const fn http_status(&self) -> u16 {
        match self {
            Self::StaleRevision { .. } | Self::Withdrawn(_) | Self::GenerationChanged => 409,
            Self::StillReferenced { .. } | Self::Invalid(_) => 400,
            Self::Storage(_) => 500,
        }
    }
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

pub use crate::transport_lifecycle::trust_store::{load, put_cas, reconcile, refresh};
