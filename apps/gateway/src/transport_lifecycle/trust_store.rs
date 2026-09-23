//! The stored half of [`super::trust`]: reading the profiles, the
//! compare-and-set write, the guarded removal, and the overlap reconcile.
//!
//! Split from the types so each file stays inside the 400-line budget; the
//! rules these functions enforce are documented there.

use std::collections::BTreeMap;

use chrono::{DateTime, Utc};
use opensesame_domain::transport::{
    ServiceBindingSet, TransportError, TrustProfileKind, TrustProfileRef,
};
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
    // Load → compare → activate → store is one critical section per
    // process, like `bindings::put_cas`: two writers with the same revision
    // cannot both pass the compare.
    let _serial = TRUST_SERIAL.lock().await;
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
    reactivate(state, &current, &proposed, now).await?;
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

/// Serializes trust writes (and the overlap reconcile) process-wide.
static TRUST_SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Build the peer-trust map for `stored` on top of the deployment plane's
/// bundles *as they serve now* and swap it into a new generation, keeping
/// the identity that is serving. Nothing else about the generation changes.
///
/// Three things this refuses to do:
///
/// - **Resurrect a withdrawn generation.** A withdrawal (a revoked or lapsed
///   source) is not undone by copying its identity into a fresh candidate.
/// - **Overwrite a concurrent rotation.** The candidate is derived from one
///   generation and activated only while that generation still serves
///   (`activate_if_current`); otherwise the write is refused.
/// - **Roll deployment-plane bundles back to boot.** A deployment-plane
///   source (the SPIFFE Workload API above all) replaces its bundles on
///   every snapshot, so the boot-time copy goes stale. Those profiles are
///   taken from the serving generation, never from the boot snapshot.
async fn reactivate(
    state: &AppState,
    previously_stored: &TrustProfileSet,
    stored: &TrustProfileSet,
    now: DateTime<Utc>,
) -> Result<(), TrustError> {
    let Some(generations) = state.transport_lifecycle.generations() else {
        // No runtime: still refuse a set whose anchors would not build.
        bundles(&state.transport_lifecycle.base_trust(), stored, now)
            .map_err(TrustError::Invalid)?;
        return Ok(());
    };
    let current = generations.current();
    if let Some(reason) = &current.withdrawn {
        return Err(TrustError::Withdrawn(reason.clone()));
    }
    let base = deployment_plane_trust(state, &current, previously_stored);
    let peer_trust = bundles(&base, stored, now).map_err(TrustError::Invalid)?;
    let candidate = opensesame_transport_security::GenerationCandidate {
        identity: current.identity.clone(),
        peer_trust,
        own_trust: None,
        identity_required: current.identity.is_some(),
    };
    match activation::activate_candidate_if_current(
        state,
        crate::transport_lifecycle::HOST_LISTENER_TARGET,
        &generations,
        current.number,
        candidate,
    )
    .await
    {
        Ok(_) => Ok(()),
        Err(TransportError::GenerationStale) => Err(TrustError::GenerationChanged),
        Err(error) => Err(TrustError::Invalid(error)),
    }
}

/// The deployment plane's bundles as the serving generation holds them.
///
/// Names come from the boot snapshot (`base_trust`) — a stored profile can
/// never add one — but each bundle is the one serving now, and a name the
/// serving generation no longer carries (a trust domain the Workload API
/// dropped) is not brought back. On a SPIFFE listener every trust domain
/// the current snapshot delivered is deployment-plane too, including ones
/// federated after boot; a name the store already owns is left to the store.
fn deployment_plane_trust(
    state: &AppState,
    current: &opensesame_transport_security::Generation,
    previously_stored: &TrustProfileSet,
) -> BTreeMap<TrustProfileRef, TrustBundle> {
    let boot = state.transport_lifecycle.base_trust();
    let spiffe = state.transport.as_ref().is_some_and(|runtime| {
        runtime.config.listener.as_ref().is_some_and(|listener| {
            matches!(
                listener.identity,
                opensesame_transport_security::env::NativeIdentitySpec::Spiffe { .. }
            )
        })
    });
    let stored_name = |profile: &TrustProfileRef| {
        previously_stored
            .profiles
            .iter()
            .any(|stored| &stored.profile == profile)
    };
    current
        .peer_trust
        .iter()
        .filter(|(profile, bundle)| {
            boot.contains_key(*profile)
                || (spiffe
                    && bundle.kind() == TrustProfileKind::SpiffeTrustDomain
                    && !stored_name(profile))
        })
        .map(|(profile, bundle)| (profile.clone(), bundle.clone()))
        .collect()
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
    let _serial = TRUST_SERIAL.lock().await;
    let stored = load(state).await?;
    reactivate(state, &stored, &stored, now)
        .await
        .map_err(|error| match error {
            TrustError::Invalid(inner) | TrustError::Withdrawn(inner) => inner,
            TrustError::GenerationChanged => TransportError::GenerationStale,
            other => TransportError::malformed(other.to_string()),
        })?;
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
