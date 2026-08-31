//! The breach scanner: one pass fetches the published catalogue, asks what each
//! watched domain matches, and hands the result to the shared dispatcher.
//!
//! Structurally the same loop as the expiry scanner, and deliberately so — but
//! it settles a different kind of fact. An expiry rung is monotonic: a deadline
//! only ever gets closer, so a watermark that counts up is the right record. A
//! breach finding is a predicate that can become false again, because the
//! answer to "is this provider breached" changes when the source withdraws an
//! entry and "is this domain still ours" changes when a connection is removed.
//! So this pass records state, and both transitions are events:
//! `breach.provider.disclosed` when it becomes true,
//! `breach.finding.cleared` when it stops being.
//!
//! A source that cannot be reached publishes `breach.scan.failed` rather than
//! logging quietly. An unreachable corpus and a clean corpus produce identical
//! silence otherwise, and the whole point of this subsystem is that silence
//! should mean something.

use std::collections::BTreeSet;
use std::time::Duration;

use chrono::{DateTime, Utc};
use opensesame_breach_intel::{matches, Breach, BreachEvent, BreachSource, BreachSubject};
use opensesame_domain::OrganizationId;
use opensesame_storage::StoredBreachFinding;

use crate::app_state::AppState;
use crate::breach::subjects;
use crate::lifecycle::scanner::scannable_organizations;
use crate::security;

/// Six hours between passes.
///
/// The catalogue is published, not streamed, and gains entries on the order of
/// days. A tighter loop would add no coverage and would make us an unusually
/// rude client of somebody else's free service.
const DEFAULT_TICK_SECONDS: u64 = 6 * 60 * 60;

/// Shortest interval an operator may configure, so a misconfiguration cannot
/// turn the gateway into a hot loop against a third party.
const MIN_TICK_SECONDS: u64 = 60;

fn tick_seconds() -> u64 {
    std::env::var("OPENSESAME_BREACH_TICK_SECONDS")
        .ok()
        .and_then(|raw| raw.parse::<u64>().ok())
        .filter(|seconds| *seconds >= MIN_TICK_SECONDS)
        .unwrap_or(DEFAULT_TICK_SECONDS)
}

/// Process-lifetime scanner loop, spawned beside the expiry scanner.
pub async fn run(state: AppState) {
    let mut interval = tokio::time::interval(Duration::from_secs(tick_seconds()));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        interval.tick().await;
        match pass(&state, Utc::now()).await {
            Ok(0) => {}
            Ok(published) => tracing::info!(published, "breach scan published findings"),
            Err(error) => tracing::warn!(%error, "breach scan failed"),
        }
    }
}

/// One pass over every tenant's watched domains. Returns how many events were
/// published.
///
/// The catalogue is fetched **once** per pass rather than once per tenant: it
/// is the same public document for everybody, and refetching it per tenant
/// would multiply our load on the source by the tenant count for no benefit.
///
/// # Errors
///
/// Never returns an error today — a fetch failure is published as
/// `breach.scan.failed` and reported per tenant, because a failure an operator
/// cannot see is worse than one that is merely logged. The signature stays
/// fallible to match the expiry scanner's and to leave room for a failure that
/// genuinely should abort a pass.
pub async fn pass(state: &AppState, now: DateTime<Utc>) -> anyhow::Result<usize> {
    let organizations = scannable_organizations(state).await;
    // Seed the built-in subscribers *before* the fetch that might fail. On a
    // gateway's very first pass they do not exist yet, and a fetch failure
    // would otherwise publish `breach.scan.failed` to nobody — which is the
    // exact silence this detector exists to make visible.
    for organization_id in &organizations {
        security::hooks::ensure_defaults(state, &organization_id.to_string(), now).await;
    }
    let catalogue = match crate::breach::sources::catalogue().await {
        Ok(entries) => entries,
        Err(error) => return Ok(report_source_failure(state, &organizations, &error, now).await),
    };
    tracing::debug!(entries = catalogue.len(), "breach catalogue fetched");

    let mut published = 0usize;
    for organization_id in organizations {
        match scan_organization(state, &catalogue, &organization_id, now).await {
            Ok(count) => published += count,
            Err(error) => tracing::warn!(
                %error,
                organization_id = %organization_id,
                "breach scan skipped an organization",
            ),
        }
    }
    Ok(published)
}

/// Tell every tenant that a corpus could not be consulted.
///
/// Per tenant rather than once globally: a subscription is a tenant's, and an
/// operator watching one organization's feed must not have to infer a coverage
/// gap from another organization's events.
async fn report_source_failure(
    state: &AppState,
    organizations: &[OrganizationId],
    error: &anyhow::Error,
    now: DateTime<Utc>,
) -> usize {
    tracing::warn!(%error, "breach catalogue could not be fetched");
    let detail = error.to_string();
    for organization_id in organizations {
        let event = BreachEvent::scan_failed(
            BreachSource::HibpBreaches,
            organization_id.to_string(),
            &detail,
            now,
        );
        security::dispatch::publish(state, &event.notice(), now).await;
    }
    organizations.len()
}

/// Evaluate every watched domain in one organization and publish what changed.
///
/// # Errors
///
/// Returns an error when the organization's connections or its open findings
/// cannot be read.
pub async fn scan_organization(
    state: &AppState,
    catalogue: &[Breach],
    organization_id: &OrganizationId,
    now: DateTime<Utc>,
) -> anyhow::Result<usize> {
    let organization = organization_id.to_string();
    // Also seeded by `pass` before the fetch, and by the expiry scanner: this
    // call is what covers the on-demand route, which reaches here directly.
    security::hooks::ensure_defaults(state, &organization, now).await;

    let watched = subjects::watched_domains(state, organization_id).await?;
    let open = state.db.list_open_breach_findings(&organization).await?;

    let mut published = 0usize;
    let mut still_matching: BTreeSet<(String, String)> = BTreeSet::new();

    for subject in &watched {
        for breach in matches(catalogue, &subject.subject_id, None) {
            still_matching.insert((subject.subject_id.clone(), breach.name.clone()));
            if publish_disclosure(state, subject, breach, now).await {
                published += 1;
            }
        }
    }

    published += clear_stale(state, &open, &still_matching, now).await;
    Ok(published)
}

/// Record one disclosure, publishing only if this call opened it.
async fn publish_disclosure(
    state: &AppState,
    subject: &BreachSubject,
    breach: &Breach,
    now: DateTime<Utc>,
) -> bool {
    let event = BreachEvent::provider_disclosed(subject.clone(), breach, now);
    let row = StoredBreachFinding {
        organization_id: subject.organization_id.clone(),
        subject_kind: subject.kind.as_str().to_string(),
        subject_id: subject.subject_id.clone(),
        source: BreachSource::HibpBreaches.as_str().to_string(),
        reference: breach.name.clone(),
        severity: event.severity.as_str().to_string(),
        occurrences: None,
        state: opensesame_storage::BREACH_FINDING_OPEN.to_string(),
        first_seen_at: now.to_rfc3339(),
        last_seen_at: now.to_rfc3339(),
        cleared_at: None,
    };
    match state.db.record_breach_finding(&row, now).await {
        Ok(true) => {
            security::dispatch::publish(state, &event.notice(), now).await;
            true
        }
        Ok(false) => false,
        Err(error) => {
            // Stand down rather than publish. Without a recorded claim the
            // next pass would publish it again, and an alert that repeats every
            // six hours forever is one an operator learns to filter out.
            tracing::warn!(
                %error,
                subject_id = %subject.subject_id,
                "breach finding could not be recorded; standing down until the next pass",
            );
            false
        }
    }
}

/// Publish a clear for every open catalogue finding this pass did not see.
///
/// Scoped to the catalogue source: a finding from the password corpus is not
/// evidence about a domain, and clearing it here because a *catalogue* pass did
/// not reproduce it would be a false all-clear about a different fact entirely.
async fn clear_stale(
    state: &AppState,
    open: &[StoredBreachFinding],
    still_matching: &BTreeSet<(String, String)>,
    now: DateTime<Utc>,
) -> usize {
    let source = BreachSource::HibpBreaches.as_str();
    let mut published = 0usize;
    for finding in open
        .iter()
        .filter(|finding| finding.source == source)
        .filter(|finding| {
            !still_matching.contains(&(finding.subject_id.clone(), finding.reference.clone()))
        })
    {
        published += usize::from(publish_clear(state, finding, now).await);
    }
    published
}

/// Clear one finding, publishing only if this call made the transition.
async fn publish_clear(
    state: &AppState,
    finding: &StoredBreachFinding,
    now: DateTime<Utc>,
) -> bool {
    let cleared = state
        .db
        .clear_breach_finding(
            &finding.organization_id,
            &finding.subject_kind,
            &finding.subject_id,
            &finding.source,
            &finding.reference,
            now,
        )
        .await;
    match cleared {
        Ok(true) => {
            let subject = cleared_subject(finding);
            let event = BreachEvent::cleared(subject, BreachSource::HibpBreaches, now);
            security::dispatch::publish(state, &event.notice(), now).await;
            true
        }
        Ok(false) => false,
        Err(error) => {
            tracing::warn!(
                %error,
                subject_id = %finding.subject_id,
                "breach finding could not be cleared",
            );
            false
        }
    }
}

/// Rebuild the subject a stored finding was recorded against.
///
/// The label is the breach reference rather than the provider list: by the time
/// something is being cleared the connection may be gone, and naming the
/// withdrawn breach is what makes the resolution readable.
fn cleared_subject(finding: &StoredBreachFinding) -> BreachSubject {
    let kind = opensesame_breach_intel::BreachSubjectKind::parse(&finding.subject_kind)
        .unwrap_or(opensesame_breach_intel::BreachSubjectKind::Domain);
    let subject = BreachSubject::new(
        kind,
        finding.subject_id.clone(),
        finding.organization_id.clone(),
    );
    if finding.reference.is_empty() {
        subject
    } else {
        subject.labelled(finding.reference.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use opensesame_breach_intel::BreachSubjectKind;

    fn now() -> DateTime<Utc> {
        "2026-08-30T00:00:00Z".parse().unwrap()
    }

    fn finding(subject_id: &str, reference: &str, source: BreachSource) -> StoredBreachFinding {
        StoredBreachFinding {
            organization_id: "org-1".into(),
            subject_kind: "domain".into(),
            subject_id: subject_id.into(),
            source: source.as_str().into(),
            reference: reference.into(),
            severity: "error".into(),
            occurrences: None,
            state: opensesame_storage::BREACH_FINDING_OPEN.into(),
            first_seen_at: now().to_rfc3339(),
            last_seen_at: now().to_rfc3339(),
            cleared_at: None,
        }
    }

    #[test]
    fn the_tick_defaults_to_six_hours_and_refuses_a_hot_loop() {
        assert_eq!(DEFAULT_TICK_SECONDS, 21_600);
        assert_eq!(MIN_TICK_SECONDS, 60);
    }

    #[test]
    fn a_cleared_subject_is_named_by_the_breach_that_was_withdrawn() {
        let subject = cleared_subject(&finding("adobe.com", "Adobe", BreachSource::HibpBreaches));
        assert_eq!(subject.kind, BreachSubjectKind::Domain);
        assert_eq!(subject.subject_id, "adobe.com");
        assert_eq!(subject.label.as_deref(), Some("Adobe"));
    }

    #[test]
    fn a_finding_with_no_reference_clears_without_a_label() {
        let subject = cleared_subject(&finding("Dev/token", "", BreachSource::HibpPasswords));
        assert_eq!(subject.label, None);
    }

    #[test]
    fn an_unrecognised_subject_kind_falls_back_to_domain_rather_than_dropping() {
        let mut odd = finding("adobe.com", "Adobe", BreachSource::HibpBreaches);
        odd.subject_kind = "planet".into();
        assert_eq!(cleared_subject(&odd).kind, BreachSubjectKind::Domain);
    }

    #[test]
    fn a_clear_resolves_the_alert_the_disclosure_opened() {
        let subject = BreachSubject::new(BreachSubjectKind::Domain, "adobe.com", "org-1");
        let breach = Breach {
            name: "Adobe".into(),
            domain: "adobe.com".into(),
            is_verified: true,
            data_classes: vec!["Passwords".into()],
            ..Breach::default()
        };
        let opened = BreachEvent::provider_disclosed(subject.clone(), &breach, now()).notice();
        let closed = BreachEvent::cleared(subject, BreachSource::HibpBreaches, now()).notice();
        assert_eq!(opened.alert_key(), closed.alert_key());
        assert!(closed.state.is_resolved());
    }

    #[test]
    fn a_password_finding_is_never_cleared_by_a_catalogue_pass() {
        // A catalogue pass produces no `still_matching` entry for a password
        // finding, so the source filter is the only thing protecting it.
        let open = [
            finding("Dev/token", "", BreachSource::HibpPasswords),
            finding("adobe.com", "Adobe", BreachSource::HibpBreaches),
        ];
        let catalogue_source = BreachSource::HibpBreaches.as_str();
        let candidates: Vec<&StoredBreachFinding> = open
            .iter()
            .filter(|found| found.source == catalogue_source)
            .collect();
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].subject_id, "adobe.com");
    }
}
