//! The stored half of [`super::trust`]: reading the profiles, the
//! compare-and-set write, the guarded removal, and the overlap reconcile.
//!
//! Split from the types so each file stays inside the 400-line budget; the
//! rules these functions enforce are documented there.

use std::collections::BTreeMap;

use chrono::{DateTime, Utc};
use opensesame_domain::transport::{ServiceBindingSet, TransportError, TrustProfileRef};
use opensesame_security_events::{NoticeState, SecurityNotice, Severity};
use opensesame_transport_security::TrustBundle;

use crate::app_state::AppState;
use crate::transport_lifecycle::activation;
use crate::transport_lifecycle::trust::{
    bundles, TrustError, TrustProfileSet, EVENT_FORCED_REMOVAL, EVENT_TRUST_CHANGED,
    KV_TRUST_PROFILES, MAX_TRUST_BYTES,
};

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
    proposed.revision = current.revision.checked_add(1).ok_or_else(|| {
        TrustError::Invalid(TransportError::malformed("trust: revision overflow"))
    })?;
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
        publish(
            state,
            EVENT_FORCED_REMOVAL,
            Severity::Critical,
            actor,
            &profile,
            format!("trust profile {profile} removed while binding {binding} still names it"),
        )
        .await;
    }
    publish(
        state,
        EVENT_TRUST_CHANGED,
        Severity::Warning,
        actor,
        &TrustProfileRef { name: "set".into() },
        format!(
            "transport trust profiles replaced at revision {}",
            proposed.revision
        ),
    )
    .await;
    Ok(proposed)
}

fn removed_or_disabled(
    current: &TrustProfileSet,
    proposed: &TrustProfileSet,
) -> Vec<TrustProfileRef> {
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
