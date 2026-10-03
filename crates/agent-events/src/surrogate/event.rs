//! A refused surrogate after its fields have been vetted — the only shape the
//! feed is ever built from.

use chrono::{DateTime, Utc};
use opensesame_security_events::SecurityNotice;
use serde_json::Value;

use super::{
    notice_of, payload, vet_detail, vet_identifier, SurrogateFence, SurrogateNoticeError,
    SurrogateRefusalReport, LOCAL_ORGANIZATION, SURROGATE_PROXY_SUBJECT_KIND,
    SURROGATE_RUN_SUBJECT_KIND, UNATTRIBUTED_SUBJECT,
};

/// One surrogate tripwire, ready to publish.
///
/// Its fields are private and it has no public constructor but
/// [`Self::from_report`], so there is no way to build one around a field that
/// skipped its fence. Everything it holds has passed one, which is why its
/// derived `Debug` is safe to print.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SurrogateEvent {
    pub(super) fence: SurrogateFence,
    pub(super) organization_id: String,
    pub(super) run_id: Option<String>,
    pub(super) provider_id: Option<String>,
    pub(super) detail: Option<String>,
    /// Names of fields the report carried that failed their fence, in the
    /// order `run_id`, `provider_id`, `detail`.
    pub(super) withheld: Vec<&'static str>,
    pub(super) occurred_at: DateTime<Utc>,
}

impl SurrogateEvent {
    /// Vet a report into an event.
    ///
    /// The run, the provider and the detail are each withheld — dropped and
    /// named in `withheld` — when they fail their fence. The notice is still
    /// built: a tripwire an attacker could mute by choosing an ugly host name
    /// is not a tripwire.
    ///
    /// # Errors
    ///
    /// - [`SurrogateNoticeError::UnknownCode`] when `code` is not exactly one
    ///   of the frozen `surrogate.*` names.
    /// - [`SurrogateNoticeError::InvalidOrganization`] when the organization is
    ///   given and fails the identifier fence. It is the caller's own
    ///   configuration, so a bad one is a bug to surface, not a field to drop.
    pub fn from_report(report: &SurrogateRefusalReport<'_>) -> Result<Self, SurrogateNoticeError> {
        let fence = SurrogateFence::parse(report.code)?;
        let organization_id = match report.organization_id {
            Some(raw) => vet_identifier(raw).ok_or(SurrogateNoticeError::InvalidOrganization)?,
            None => LOCAL_ORGANIZATION.to_string(),
        };
        let mut withheld = Vec::new();
        let mut vetted =
            |name: &'static str, raw: Option<&str>, check: fn(&str) -> Option<String>| {
                let kept = raw.and_then(check);
                if raw.is_some() && kept.is_none() {
                    withheld.push(name);
                }
                kept
            };
        let run_id = vetted("run_id", report.run_id, vet_identifier);
        let provider_id = vetted("provider_id", report.provider_id, vet_identifier);
        let detail = vetted("detail", report.detail, vet_detail);
        Ok(Self {
            fence,
            organization_id,
            run_id,
            provider_id,
            detail,
            withheld,
            occurred_at: report.occurred_at,
        })
    }

    #[must_use]
    pub const fn fence(&self) -> SurrogateFence {
        self.fence
    }

    /// The frozen event name this event publishes under.
    #[must_use]
    pub const fn event_type(&self) -> &'static str {
        self.fence.event_type()
    }

    /// The fields a report carried that failed their fence.
    #[must_use]
    pub fn withheld(&self) -> &[&'static str] {
        &self.withheld
    }

    /// What the notice is about: the run when the ledger knew it, otherwise the
    /// broker itself.
    #[must_use]
    pub fn subject(&self) -> (&'static str, String) {
        match &self.run_id {
            Some(run_id) => (SURROGATE_RUN_SUBJECT_KIND, run_id.clone()),
            None => (
                SURROGATE_PROXY_SUBJECT_KIND,
                UNATTRIBUTED_SUBJECT.to_string(),
            ),
        }
    }

    /// The value-blind payload a subscriber receives.
    #[must_use]
    pub fn payload(&self) -> Value {
        let (kind, id) = self.subject();
        payload(self, kind, &id)
    }

    /// The normalized envelope the notifier, the alerter and every sink read —
    /// this family's entire integration with ADR 0080's feed.
    #[must_use]
    pub fn notice(&self) -> SecurityNotice {
        notice_of(self)
    }
}
