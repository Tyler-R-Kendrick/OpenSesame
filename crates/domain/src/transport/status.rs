//! Status views: independent dimensions, never one collapsed lifecycle.
//!
//! `desired` (configuration), `credential` (availability and custody),
//! `runtime` (installed generation), `observed` (a real authenticated peer),
//! and `enforcement` (a positive-and-negative probe bound to a generation)
//! are separate facts. A view is a DTO: deserializing one proves nothing.

use super::capability::TransportCapabilities;
use super::error::TransportError;
use super::evidence::PeerEvidenceView;
use super::policy::{Custody, IdentitySourceKind, TransportPolicy};
use super::{timestamp, validate_id};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum CredentialStatus {
    Unconfigured,
    Configured {
        custody: Custody,
        generation: u64,
        #[serde(with = "timestamp")]
        not_after: DateTime<Utc>,
        kind: IdentitySourceKind,
    },
    Expired {
        generation: u64,
    },
    Revoked {
        generation: u64,
    },
    ExternalProvisioningRequired,
    UnsupportedInBrowser,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum RuntimeStatus {
    NotLoaded,
    Loaded {
        generation: u64,
        #[serde(with = "timestamp")]
        loaded_at: DateTime<Utc>,
    },
    ReloadFailed {
        generation: u64,
        /// A [`TransportError::code`], never free text.
        code: String,
    },
}

impl RuntimeStatus {
    /// The generation the runtime currently serves, if any.
    #[must_use]
    pub const fn generation(&self) -> Option<u64> {
        match self {
            Self::NotLoaded => None,
            Self::Loaded { generation, .. } | Self::ReloadFailed { generation, .. } => {
                Some(*generation)
            }
        }
    }
}

/// A real peer authenticated by a named observer against a named target.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct ObservedAuthentication {
    #[serde(with = "timestamp")]
    pub at: DateTime<Utc>,
    pub observer: String,
    pub target: String,
    pub generation: u64,
    pub peer: PeerEvidenceView,
}

/// Whether the target was *shown* to require a certificate. `Verified` records
/// both halves of the probe; only both together mean enforcement.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum EnforcementStatus {
    Unverified,
    Verified {
        #[serde(with = "timestamp")]
        at: DateTime<Utc>,
        target: String,
        generation: u64,
        accepted_with_certificate: bool,
        rejected_without_certificate: bool,
        #[serde(with = "timestamp")]
        fresh_until: DateTime<Utc>,
    },
    Stale {
        #[serde(with = "timestamp")]
        verified_at: DateTime<Utc>,
        generation: u64,
        current_generation: u64,
    },
}

impl EnforcementStatus {
    /// True only for a fresh `Verified` whose probe both accepted a
    /// certificate and rejected its absence.
    #[must_use]
    pub const fn enforces(&self) -> bool {
        matches!(
            self,
            Self::Verified {
                accepted_with_certificate: true,
                rejected_without_certificate: true,
                ..
            }
        )
    }

    /// Re-evaluate against the current generation and clock: a `Verified`
    /// taken under another generation, or past `fresh_until`, becomes
    /// `Stale` rather than certifying the new configuration
    /// (AT-EVIDENCE-STALE).
    #[must_use]
    pub fn reconcile(self, current_generation: u64, now: DateTime<Utc>) -> Self {
        match self {
            Self::Verified {
                at,
                generation,
                fresh_until,
                ..
            } if generation != current_generation || now >= fresh_until => Self::Stale {
                verified_at: at,
                generation,
                current_generation,
            },
            other => other,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct TransportStatusView {
    pub target: String,
    pub desired: TransportPolicy,
    pub credential: CredentialStatus,
    pub runtime: RuntimeStatus,
    #[serde(default)]
    pub observed: Option<ObservedAuthentication>,
    pub enforcement: EnforcementStatus,
    pub capabilities: TransportCapabilities,
}

impl TransportStatusView {
    /// Structural validity: ids well-formed, capabilities honest, and the
    /// observation (if any) names this target.
    ///
    /// # Errors
    ///
    /// `MalformedConfiguration`.
    pub fn validate(&self) -> Result<(), TransportError> {
        validate_id("status.target", &self.target)?;
        self.capabilities.validate()?;
        if let Some(observed) = &self.observed {
            validate_id("status.observed.observer", &observed.observer)?;
            if observed.target != self.target {
                return Err(TransportError::malformed(
                    "status.observed.target: observation is about another target",
                ));
            }
        }
        if let EnforcementStatus::Verified { target, .. } = &self.enforcement {
            if target != &self.target {
                return Err(TransportError::malformed(
                    "status.enforcement.target: probe is about another target",
                ));
            }
        }
        if let RuntimeStatus::ReloadFailed { code, .. } = &self.runtime {
            if !TransportError::ALL_CODES.contains(&code.as_str()) {
                return Err(TransportError::malformed(
                    "status.runtime.code: not a transport error code",
                ));
            }
        }
        Ok(())
    }

    /// Apply [`EnforcementStatus::reconcile`] against the runtime generation
    /// (an unloaded runtime makes every verification stale).
    #[must_use]
    pub fn reconciled(mut self, now: DateTime<Utc>) -> Self {
        let current = self.runtime.generation().unwrap_or(0);
        self.enforcement = self.enforcement.reconcile(current, now);
        self
    }
}
