//! CRL freshness for the configured revocation profile (LIFE-REVOCATION).
//!
//! A `P_CRL_FILE` is parsed on load and its `nextUpdate` recorded. A CRL past
//! that instant makes the transport status `degraded`: the entries it holds
//! are still handed to the verifier — they are better than none — but the
//! staleness is a reported fact, never a silent pass. A CRL with no
//! `nextUpdate` at all counts as stale from the moment it is read.

use chrono::{DateTime, Utc};
use opensesame_domain::transport::TransportError;
use serde::{Deserialize, Serialize};

use crate::app_state::AppState;

/// What was read from a configured CRL file.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct CrlFreshness {
    pub crls: usize,
    pub loaded_at: DateTime<Utc>,
    pub this_update: DateTime<Utc>,
    /// `nextUpdate`; the CRL is stale past it. Absent when the CRL carries
    /// none, which is treated as stale from the start.
    pub crl_fresh_until: Option<DateTime<Utc>>,
}

impl CrlFreshness {
    /// Stale at `now`: the status is `degraded`, never healthy.
    #[must_use]
    pub fn is_stale(&self, now: DateTime<Utc>) -> bool {
        self.crl_fresh_until.is_none_or(|until| now >= until)
    }
}

fn to_chrono(value: time::OffsetDateTime) -> Result<DateTime<Utc>, TransportError> {
    DateTime::<Utc>::from_timestamp(value.unix_timestamp(), 0)
        .ok_or_else(|| TransportError::malformed("crl: timestamp out of range"))
}

/// Parse every `X509 CRL` block in `pem` and report the earliest
/// `nextUpdate` across them.
///
/// # Errors
///
/// `MalformedConfiguration` when no CRL block parses.
pub fn crl_freshness(pem: &[u8], now: DateTime<Utc>) -> Result<CrlFreshness, TransportError> {
    let mut count = 0usize;
    let mut this_update: Option<DateTime<Utc>> = None;
    let mut next_update: Option<DateTime<Utc>> = None;
    let mut saw_missing_next = false;
    for block in x509_parser::pem::Pem::iter_from_buffer(pem) {
        let block = block.map_err(|e| TransportError::malformed(format!("crl pem: {e}")))?;
        if block.label != "X509 CRL" {
            continue;
        }
        let facts = opensesame_pki_core::revocation::parse_crl(&block.contents)
            .map_err(|e| TransportError::malformed(format!("crl: {e}")))?;
        count += 1;
        let this = to_chrono(facts.this_update)?;
        this_update = Some(this_update.map_or(this, |t| t.max(this)));
        match facts.next_update {
            Some(next) => {
                let next = to_chrono(next)?;
                next_update = Some(next_update.map_or(next, |n| n.min(next)));
            }
            None => saw_missing_next = true,
        }
    }
    if count == 0 {
        return Err(TransportError::malformed("crl file holds no X509 CRL block"));
    }
    Ok(CrlFreshness {
        crls: count,
        loaded_at: now,
        this_update: this_update.unwrap_or(now),
        crl_fresh_until: if saw_missing_next { None } else { next_update },
    })
}

/// Read a CRL file, record its freshness on the lifecycle state, and return
/// the PEM for `TrustBundle::with_crls`. A stale CRL is returned *and*
/// logged; it is the status view's job to say `degraded`.
///
/// # Errors
///
/// `MalformedConfiguration` when the file is unreadable or parses to no CRL.
pub fn load_crl_file(
    state: &AppState,
    path: &std::path::Path,
    now: DateTime<Utc>,
) -> Result<Vec<u8>, TransportError> {
    let pem = std::fs::read(path).map_err(|e| TransportError::malformed(format!("crl file: {e}")))?;
    let freshness = crl_freshness(&pem, now)?;
    if freshness.is_stale(now) {
        tracing::warn!(
            fresh_until = ?freshness.crl_fresh_until,
            "configured CRL is past its nextUpdate; transport status is degraded"
        );
    }
    state.transport_lifecycle.set_crl(Some(freshness));
    Ok(pem)
}

/// The revocation dimension for a status view.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct RevocationStatus {
    pub denied_leaves: usize,
    pub crl: Option<CrlFreshness>,
    /// `healthy` with a fresh CRL or none configured, `degraded` with a
    /// stale one.
    pub outcome: &'static str,
}

#[must_use]
pub fn status(state: &AppState, now: DateTime<Utc>) -> RevocationStatus {
    let crl = state.transport_lifecycle.crl();
    let outcome = match &crl {
        Some(freshness) if freshness.is_stale(now) => "degraded",
        _ => "healthy",
    };
    RevocationStatus {
        denied_leaves: state.transport_lifecycle.denied_count(),
        crl,
        outcome,
    }
}
