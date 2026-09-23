//! The stored half of [`super::trust`]: reading the profiles, the
//! compare-and-set write, the guarded removal, the refresh that keeps every
//! replica sharing the store on the stored set, and the overlap reconcile.
//!
//! Split from the types so each file stays inside the 400-line budget; the
//! rules these functions enforce are documented there.

use std::collections::BTreeSet;

use chrono::{DateTime, Utc};
use opensesame_domain::transport::{ServiceBindingSet, TransportError, TrustProfileRef};
use opensesame_security_events::{NoticeState, SecurityNotice, Severity};

use crate::app_state::AppState;
use crate::transport_lifecycle::trust::{
    TrustError, TrustProfileSet, EVENT_FORCED_REMOVAL, EVENT_TRUST_CHANGED, KV_TRUST_PROFILES,
    MAX_TRUST_BYTES,
};
use crate::transport_lifecycle::trust_activate::{
    activate, as_transport_error, prepare, TRUST_SERIAL,
};

/// Read the stored set. A stored document that no longer parses is an error,
/// never a silent empty set.
///
/// # Errors
///
/// `MalformedConfiguration` when the store is unreadable or the document is
/// not a [`TrustProfileSet`].
pub async fn load(state: &AppState) -> Result<TrustProfileSet, TransportError> {
    load_raw(state).await.map(|(_, set)| set)
}

/// [`load`], plus the exact stored document the conditional write compares
/// against (`None` when nothing is stored).
async fn load_raw(state: &AppState) -> Result<(Option<String>, TrustProfileSet), TransportError> {
    let Some(raw) = state
        .db
        .get_host_kv(KV_TRUST_PROFILES)
        .await
        .map_err(|e| TransportError::malformed(format!("trust store: {e}")))?
    else {
        return Ok((None, TrustProfileSet::empty()));
    };
    if raw.len() > MAX_TRUST_BYTES {
        return Err(TransportError::malformed(
            "trust: stored document exceeds the size bound",
        ));
    }
    let set = serde_json::from_str(&raw)
        .map_err(|e| TransportError::malformed(format!("trust store: {e}")))?;
    Ok((Some(raw), set))
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
/// Order matters and is the point: validate → size-check the document →
/// build every bundle and the candidate → store, conditional on the exact
/// stored document the compare read → only then activate. A refusal before
/// the store leaves both the store and the serving generation as they were.
/// An activation that fails after the store rolls the stored profiles back
/// under a newer revision (so a replica that already adopted the write
/// follows the rollback forward rather than being asked to move backwards),
/// and the running set is never ahead of the stored one.
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
    let _serial = TRUST_SERIAL.lock().await;
    let now = Utc::now();
    proposed.validate(now).map_err(TrustError::Invalid)?;
    let (raw, current) = load_raw(state).await.map_err(TrustError::Invalid)?;
    if proposed.revision != current.revision {
        adopt_quietly(state, &current, now).await;
        return Err(TrustError::StaleRevision {
            current: current.revision,
        });
    }
    let forced = guard_removals(state, &current, &proposed, force).await?;
    proposed.revision = next_revision(current.revision)?;
    let json = serialize_bounded(&proposed)?;
    let prepared = prepare(state, &known_names(state, &current), &proposed, now)?;
    let written = state
        .db
        .compare_and_set_host_kv(KV_TRUST_PROFILES, raw.as_deref(), &json)
        .await
        .map_err(|e| TrustError::Storage(e.to_string()))?;
    if !written {
        // Another process wrote between the read and the write.
        let now_stored = load(state).await.map_err(TrustError::Invalid)?;
        adopt_quietly(state, &now_stored, now).await;
        return Err(TrustError::StaleRevision {
            current: now_stored.revision,
        });
    }
    if let Err(error) = activate(state, prepared).await {
        roll_back(state, &json, &current, proposed.revision).await;
        return Err(error);
    }
    record_epoch(state, &proposed, now);
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

fn next_revision(revision: u32) -> Result<u32, TrustError> {
    revision
        .checked_add(1)
        .ok_or_else(|| TrustError::Invalid(TransportError::malformed("trust: revision overflow")))
}

fn serialize_bounded(set: &TrustProfileSet) -> Result<String, TrustError> {
    let json = serde_json::to_string(set).map_err(|e| TrustError::Storage(e.to_string()))?;
    if json.len() > MAX_TRUST_BYTES {
        return Err(TrustError::Invalid(TransportError::malformed(format!(
            "trust: document exceeds {MAX_TRUST_BYTES} bytes"
        ))));
    }
    Ok(json)
}

/// Refuse (or, with `force`, collect for audit) every removed profile an
/// enabled binding still names.
async fn guard_removals(
    state: &AppState,
    current: &TrustProfileSet,
    proposed: &TrustProfileSet,
    force: bool,
) -> Result<Vec<(TrustProfileRef, String)>, TrustError> {
    let bindings = live_bindings(state).await;
    let mut forced = Vec::new();
    for profile in removed_or_disabled(current, proposed) {
        if let Some(binding) = referenced_by(&bindings, &profile) {
            if !force {
                return Err(TrustError::StillReferenced {
                    profile: profile.name.clone(),
                    binding,
                });
            }
            forced.push((profile, binding));
        }
    }
    Ok(forced)
}

/// Store `previous`'s profiles again, one revision past the write whose
/// activation failed, and only if that write is still what is stored.
async fn roll_back(state: &AppState, written: &str, previous: &TrustProfileSet, failed: u32) {
    let restored = TrustProfileSet {
        revision: failed.saturating_add(1),
        profiles: previous.profiles.clone(),
    };
    let Ok(json) = serde_json::to_string(&restored) else {
        tracing::error!("trust rollback could not be serialized");
        return;
    };
    match state
        .db
        .compare_and_set_host_kv(KV_TRUST_PROFILES, Some(written), &json)
        .await
    {
        Ok(true) => state.transport_lifecycle.with_trust_epoch(|epoch| {
            // The serving set already is `previous`; nothing to re-activate.
            epoch.revision = restored.revision;
        }),
        Ok(false) => {
            tracing::warn!("trust rollback lost to a newer stored write; refresh adopts it");
        }
        Err(error) => tracing::error!(%error, "trust rollback could not be stored"),
    }
}

fn record_epoch(state: &AppState, activated: &TrustProfileSet, now: DateTime<Utc>) {
    state.transport_lifecycle.with_trust_epoch(|epoch| {
        epoch.revision = activated.revision;
        epoch.next_overlap_expiry = activated.next_overlap_expiry(now);
        epoch.names = activated
            .profiles
            .iter()
            .map(|p| p.profile.clone())
            .collect();
    });
}

/// Names the store owns: `stored`'s and whatever this process last activated.
fn known_names(state: &AppState, stored: &TrustProfileSet) -> BTreeSet<TrustProfileRef> {
    let mut names = state
        .transport_lifecycle
        .with_trust_epoch(|epoch| epoch.names.clone());
    names.extend(stored.profiles.iter().map(|p| p.profile.clone()));
    names
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

/// Bring this process's serving trust up to the store: activate the stored
/// set when its revision is ahead of the one last activated here, or narrow
/// the anchors again once a bounded rollover overlap has lapsed. Never moves
/// backwards: a stored revision behind the activated one is ignored.
/// Returns whether anything was activated.
///
/// # Errors
///
/// The store's or the activation's refusal; the serving set is then
/// untouched and the next pass tries again.
pub async fn refresh(state: &AppState, now: DateTime<Utc>) -> Result<bool, TransportError> {
    let _serial = TRUST_SERIAL.lock().await;
    let stored = load(state).await?;
    adopt(state, &stored, now).await
}

async fn adopt(
    state: &AppState,
    stored: &TrustProfileSet,
    now: DateTime<Utc>,
) -> Result<bool, TransportError> {
    let (active, due) = state.transport_lifecycle.with_trust_epoch(|epoch| {
        (
            epoch.revision,
            epoch.next_overlap_expiry.is_some_and(|at| now >= at),
        )
    });
    if stored.revision < active || (stored.revision == active && !due) {
        return Ok(false);
    }
    let prepared =
        prepare(state, &known_names(state, stored), stored, now).map_err(as_transport_error)?;
    activate(state, prepared)
        .await
        .map_err(as_transport_error)?;
    record_epoch(state, stored, now);
    Ok(true)
}

/// [`adopt`] from inside a refused write, so a replica that was behind
/// catches up on the spot; a failure is left to the refresh loop.
async fn adopt_quietly(state: &AppState, stored: &TrustProfileSet, now: DateTime<Utc>) {
    if let Err(error) = adopt(state, stored, now).await {
        tracing::warn!(code = error.code(), "stored trust could not be adopted yet");
    }
}

/// Narrow the anchors again once a bounded rollover overlap has lapsed, and
/// adopt a newer stored set. Called from the renewal loop's tick; a no-op
/// when nothing is overlapping and the store is not ahead.
///
/// # Errors
///
/// As [`refresh`].
pub async fn reconcile(state: &AppState, now: DateTime<Utc>) -> Result<(), TransportError> {
    refresh(state, now).await.map(|_| ())
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
