//! The independent lifecycle facts about one target (LIFE-ACTIVATION).
//!
//! "The certificate was renewed" and "the listener is serving it" are
//! different statements with different witnesses, and the adversarial row in
//! the directive is exactly the failure of collapsing them: issuance,
//! delivery, installation, runtime reload and enforcement observation are
//! recorded separately here, each with its own timestamp, and a status view
//! reads whichever it needs. A renewed leaf that fails to load leaves
//! `issued` true and `loaded` false — the truthful shape.
//!
//! Facts persist in `host_kv` under `transport.facts.<target>` as a bounded
//! JSON history (the newest [`MAX_HISTORY`] entries). Nothing here can carry
//! key material: every field is an id, a number, a code or a time.

use chrono::{DateTime, Utc};
use opensesame_domain::transport::{timestamp, RuntimeStatus};
use serde::{Deserialize, Serialize};

use crate::app_state::AppState;

/// Newest entries kept per target.
pub const MAX_HISTORY: usize = 32;
/// `host_kv` key prefix.
pub const KV_PREFIX: &str = "transport.facts.";

/// One lifecycle fact. The `kind` tag is the wire name.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind", deny_unknown_fields)]
pub enum Fact {
    Issued {
        certificate_id: String,
        #[serde(with = "timestamp")]
        at: DateTime<Utc>,
    },
    Delivered {
        #[serde(with = "timestamp")]
        at: DateTime<Utc>,
    },
    Loaded {
        generation: u64,
        #[serde(with = "timestamp")]
        at: DateTime<Utc>,
    },
    ReloadFailed {
        /// A `TransportError::code`, never free text.
        code: String,
        #[serde(with = "timestamp")]
        at: DateTime<Utc>,
    },
    Active {
        generation: u64,
        #[serde(with = "timestamp")]
        at: DateTime<Utc>,
    },
    Superseded {
        by: u64,
        #[serde(with = "timestamp")]
        at: DateTime<Utc>,
    },
    Expired {
        #[serde(with = "timestamp")]
        at: DateTime<Utc>,
    },
    Revoked {
        reason: String,
        #[serde(with = "timestamp")]
        at: DateTime<Utc>,
    },
    EnforcementObserved {
        generation: u64,
        #[serde(with = "timestamp")]
        at: DateTime<Utc>,
    },
}

impl Fact {
    /// When the fact was recorded (used by the history tests and by any
    /// consumer walking the raw history).
    #[cfg(test)]
    #[must_use]
    pub const fn at(&self) -> DateTime<Utc> {
        match self {
            Self::Issued { at, .. }
            | Self::Delivered { at }
            | Self::Loaded { at, .. }
            | Self::ReloadFailed { at, .. }
            | Self::Active { at, .. }
            | Self::Superseded { at, .. }
            | Self::Expired { at }
            | Self::Revoked { at, .. }
            | Self::EnforcementObserved { at, .. } => *at,
        }
    }

    #[must_use]
    pub const fn kind(&self) -> &'static str {
        match self {
            Self::Issued { .. } => "issued",
            Self::Delivered { .. } => "delivered",
            Self::Loaded { .. } => "loaded",
            Self::ReloadFailed { .. } => "reload_failed",
            Self::Active { .. } => "active",
            Self::Superseded { .. } => "superseded",
            Self::Expired { .. } => "expired",
            Self::Revoked { .. } => "revoked",
            Self::EnforcementObserved { .. } => "enforcement_observed",
        }
    }
}

/// The persisted history for one target.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct TargetFacts {
    pub target: String,
    #[serde(default)]
    pub history: Vec<Fact>,
}

/// The latest fact of each kind, for a status view.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct FactsSummary {
    pub target: String,
    pub issued: Option<Fact>,
    pub delivered: Option<Fact>,
    pub loaded: Option<Fact>,
    pub reload_failed: Option<Fact>,
    pub active: Option<Fact>,
    pub superseded: Option<Fact>,
    pub expired: Option<Fact>,
    pub revoked: Option<Fact>,
    pub enforcement_observed: Option<Fact>,
}

impl TargetFacts {
    #[must_use]
    pub fn new(target: &str) -> Self {
        Self {
            target: target.to_owned(),
            history: Vec::new(),
        }
    }

    /// Append, keeping the newest [`MAX_HISTORY`].
    pub fn push(&mut self, fact: Fact) {
        self.history.push(fact);
        if self.history.len() > MAX_HISTORY {
            let overflow = self.history.len() - MAX_HISTORY;
            self.history.drain(..overflow);
        }
    }

    /// The newest fact of a kind.
    #[must_use]
    pub fn latest(&self, kind: &str) -> Option<&Fact> {
        self.history.iter().rev().find(|fact| fact.kind() == kind)
    }

    #[must_use]
    pub fn summary(&self) -> FactsSummary {
        FactsSummary {
            target: self.target.clone(),
            issued: self.latest("issued").cloned(),
            delivered: self.latest("delivered").cloned(),
            loaded: self.latest("loaded").cloned(),
            reload_failed: self.latest("reload_failed").cloned(),
            active: self.latest("active").cloned(),
            superseded: self.latest("superseded").cloned(),
            expired: self.latest("expired").cloned(),
            revoked: self.latest("revoked").cloned(),
            enforcement_observed: self.latest("enforcement_observed").cloned(),
        }
    }

    /// The runtime dimension, read from the loaded/reload-failed facts.
    ///
    /// A reload failure *after* the last successful load reports
    /// `ReloadFailed` with the generation that kept serving; a load with no
    /// later failure reports `Loaded`.
    #[must_use]
    pub fn runtime_status(&self) -> RuntimeStatus {
        let loaded = self.latest("loaded");
        let failed = self.latest("reload_failed");
        match (loaded, failed) {
            (None, _) => RuntimeStatus::NotLoaded,
            (
                Some(Fact::Loaded { generation, at }),
                Some(Fact::ReloadFailed {
                    code,
                    at: failed_at,
                }),
            ) if failed_at > at => RuntimeStatus::ReloadFailed {
                generation: *generation,
                code: code.clone(),
            },
            (Some(Fact::Loaded { generation, at }), _) => RuntimeStatus::Loaded {
                generation: *generation,
                loaded_at: *at,
            },
            (Some(_), _) => RuntimeStatus::NotLoaded,
        }
    }
}

fn kv_key(target: &str) -> String {
    format!("{KV_PREFIX}{target}")
}

/// Load a target's facts (empty when none were recorded).
///
/// # Errors
///
/// Returns an error when the store cannot be read or the stored document no
/// longer parses — a corrupt fact history is reported, never silently reset.
pub async fn load(state: &AppState, target: &str) -> anyhow::Result<TargetFacts> {
    match state.db.get_host_kv(&kv_key(target)).await? {
        Some(raw) => Ok(serde_json::from_str(&raw)?),
        None => Ok(TargetFacts::new(target)),
    }
}

/// Append one fact to a target's history.
///
/// # Errors
///
/// As [`load`], plus the store write.
pub async fn record(state: &AppState, target: &str, fact: Fact) -> anyhow::Result<TargetFacts> {
    let mut facts = load(state, target).await?;
    facts.push(fact);
    state
        .db
        .set_host_kv(&kv_key(target), &serde_json::to_string(&facts)?)
        .await?;
    Ok(facts)
}

/// Record, logging rather than failing: the lifecycle actions that call this
/// have already done the thing the fact describes, and a store hiccup must
/// not be reported as the action failing.
pub async fn note(state: &AppState, target: &str, fact: Fact) {
    if let Err(error) = record(state, target, fact).await {
        tracing::warn!(%error, target, "transport lifecycle fact could not be recorded");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(seconds: i64) -> DateTime<Utc> {
        DateTime::<Utc>::from_timestamp(1_800_000_000 + seconds, 0).unwrap()
    }

    #[test]
    fn history_is_bounded_to_the_newest_entries() {
        let mut facts = TargetFacts::new("t");
        for i in 0..(MAX_HISTORY as i64 + 10) {
            facts.push(Fact::Delivered { at: at(i) });
        }
        assert_eq!(facts.history.len(), MAX_HISTORY);
        assert_eq!(facts.history[0].at(), at(10));
    }

    #[test]
    fn a_reload_failure_after_a_load_reports_the_generation_that_kept_serving() {
        let mut facts = TargetFacts::new("t");
        facts.push(Fact::Loaded {
            generation: 3,
            at: at(0),
        });
        facts.push(Fact::ReloadFailed {
            code: "key_pair_mismatch".into(),
            at: at(5),
        });
        assert_eq!(
            facts.runtime_status(),
            RuntimeStatus::ReloadFailed {
                generation: 3,
                code: "key_pair_mismatch".into()
            }
        );
        facts.push(Fact::Loaded {
            generation: 4,
            at: at(9),
        });
        assert!(matches!(
            facts.runtime_status(),
            RuntimeStatus::Loaded { generation: 4, .. }
        ));
        assert_eq!(
            TargetFacts::new("x").runtime_status(),
            RuntimeStatus::NotLoaded
        );
    }

    #[test]
    fn facts_round_trip_and_reject_unknown_fields() {
        let mut facts = TargetFacts::new("host-tls");
        facts.push(Fact::Revoked {
            reason: "key_compromise".into(),
            at: at(1),
        });
        let json = serde_json::to_string(&facts).unwrap();
        assert_eq!(serde_json::from_str::<TargetFacts>(&json).unwrap(), facts);
        assert!(serde_json::from_str::<Fact>(
            r#"{"kind":"loaded","generation":1,"at":"2026-01-01T00:00:00Z","key":"x"}"#
        )
        .is_err());
        let debug = format!("{facts:?}");
        for forbidden in ["PRIVATE KEY", "key_pem", "private_key"] {
            assert!(!debug.contains(forbidden));
        }
    }
}
