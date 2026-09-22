//! Truthful status of the source: connection phase, current generation,
//! outage bounds, and the custody the Workload API actually provides.

use chrono::{DateTime, Utc};
use opensesame_domain::{CredentialStatus, Custody, IdentitySourceKind};

/// Where the source's connection loop is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourcePhase {
    /// Not yet connected, or reconnecting after a failure.
    Connecting,
    /// A stream is open and the last snapshot was applied.
    Streaming,
    /// The stream broke; the current generation is retained only until
    /// `retain_until`.
    Outage,
    /// No generation is usable (withdrawn, expired, or never issued).
    Withdrawn,
    /// The source was stopped.
    Stopped,
}

/// A point-in-time view. Never carries key material, a socket path, or a
/// certificate subject.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceStatus {
    /// Connection phase.
    pub phase: SourcePhase,
    /// The configured (and only selectable) SPIFFE ID.
    pub spiffe_id: String,
    /// Always [`Custody::WorkloadApiDelivered`]: the private key was handed to
    /// this process by the Workload API. It is not hardware-bound and not
    /// non-exportable.
    pub custody: Custody,
    /// Always [`IdentitySourceKind::SpiffeWorkloadApi`].
    pub kind: IdentitySourceKind,
    /// Current generation number, when one is active.
    pub generation: Option<u64>,
    /// Current generation's `not_after`.
    pub not_after: Option<DateTime<Utc>>,
    /// When the current generation was activated.
    pub updated_at: Option<DateTime<Utc>>,
    /// When the stream broke, during an outage.
    pub outage_since: Option<DateTime<Utc>>,
    /// When the current generation will be withdrawn unless a snapshot
    /// arrives first: `min(not_after, outage_since + max_stale)`.
    pub retain_until: Option<DateTime<Utc>>,
    /// Last non-secret error code.
    pub last_error: Option<String>,
    /// Successful stream openings.
    pub connections: u32,
    /// Snapshots applied.
    pub snapshots: u64,
    /// Withdrawals issued.
    pub withdrawals: u64,
}

impl SourceStatus {
    /// The initial status for a configured but not yet connected source.
    #[must_use]
    pub fn initial(spiffe_id: &str) -> Self {
        Self {
            phase: SourcePhase::Connecting,
            spiffe_id: spiffe_id.to_owned(),
            custody: Custody::WorkloadApiDelivered,
            kind: IdentitySourceKind::SpiffeWorkloadApi,
            generation: None,
            not_after: None,
            updated_at: None,
            outage_since: None,
            retain_until: None,
            last_error: None,
            connections: 0,
            snapshots: 0,
            withdrawals: 0,
        }
    }

    /// The credential dimension of the shared status model.
    #[must_use]
    pub fn credential_status(&self, now: DateTime<Utc>) -> CredentialStatus {
        match (self.phase, self.generation, self.not_after) {
            (SourcePhase::Withdrawn | SourcePhase::Stopped, Some(generation), _) => {
                CredentialStatus::Expired { generation }
            }
            (_, Some(generation), Some(not_after)) if now > not_after => {
                CredentialStatus::Expired { generation }
            }
            (_, Some(generation), Some(not_after)) => CredentialStatus::Configured {
                custody: Custody::WorkloadApiDelivered,
                generation,
                not_after,
                kind: IdentitySourceKind::SpiffeWorkloadApi,
            },
            _ => CredentialStatus::Unconfigured,
        }
    }
}

#[cfg(test)]
mod tests {
    use chrono::{Duration, Utc};
    use opensesame_domain::{CredentialStatus, Custody};

    use super::{SourcePhase, SourceStatus};

    #[test]
    fn custody_is_always_workload_api_delivered() {
        let s = SourceStatus::initial("spiffe://td.test/a");
        assert_eq!(s.custody, Custody::WorkloadApiDelivered);
        assert_eq!(
            s.credential_status(Utc::now()),
            CredentialStatus::Unconfigured
        );
    }

    #[test]
    fn credential_status_tracks_generation_and_expiry() {
        let now = Utc::now();
        let mut s = SourceStatus::initial("spiffe://td.test/a");
        s.phase = SourcePhase::Streaming;
        s.generation = Some(3);
        s.not_after = Some(now + Duration::minutes(5));
        assert!(matches!(
            s.credential_status(now),
            CredentialStatus::Configured {
                custody: Custody::WorkloadApiDelivered,
                generation: 3,
                ..
            }
        ));
        assert_eq!(
            s.credential_status(now + Duration::minutes(6)),
            CredentialStatus::Expired { generation: 3 }
        );
        s.phase = SourcePhase::Withdrawn;
        assert_eq!(
            s.credential_status(now),
            CredentialStatus::Expired { generation: 3 }
        );
    }
}
