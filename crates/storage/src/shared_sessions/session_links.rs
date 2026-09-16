//! How a grant's link and an admission's seat are spelled in columns
//! (ADR 0079 §2, §7).
//!
//! Two pairs of columns that each carry one domain value, kept together
//! because both have the same failure mode: a row where the discriminant and
//! the id disagree. The table's CHECK constraints make those rows unwritable;
//! these readers make them unreadable too, so a database edited by hand or
//! restored from an older shape is refused rather than reinterpreted.
//!
//! Neither reader guesses. Both directions of a guess are wrong in a way that
//! matters, and which one is worse depends on the column — so the answer is
//! to refuse, which is wrong in no direction at all.

use anyhow::{bail, Context};
use opensesame_domain::{Admission, GrantLink, SessionGrantId};

/// How a grant's link is spelled in the `link` column.
pub(crate) fn link_str(link: GrantLink) -> &'static str {
    match link {
        GrantLink::LifecycleBound => "lifecycle_bound",
        GrantLink::Referenced { .. } => "referenced",
    }
}

/// Rebuild a link from the two columns that carry it.
///
/// The table's CHECK keeps them consistent — a source id exists exactly when
/// the link is `referenced` — and a row that arrived without one is refused
/// here rather than read as a lifecycle-bound grant. Reading it as bound would
/// be the dangerous direction: closing the session would then revoke reach the
/// session never minted.
pub(crate) fn link_from(raw: &str, source_grant_id: Option<String>) -> anyhow::Result<GrantLink> {
    match raw {
        "lifecycle_bound" => {
            if source_grant_id.is_some() {
                bail!("a lifecycle-bound grant named a source");
            }
            Ok(GrantLink::LifecycleBound)
        }
        "referenced" => {
            let source = source_grant_id.context("a referenced grant with no source")?;
            Ok(GrantLink::Referenced {
                source_grant_id: SessionGrantId::parse(&source).context("source grant id")?,
            })
        }
        other => bail!("unknown session grant link '{other}'"),
    }
}

/// Rebuild the seat an admission gave, from the two columns that carry it.
///
/// An admission with no mode is refused rather than guessed at. Guessing would
/// have to pick one, and both guesses are wrong in a way that matters: reading
/// an observer as a participant seats somebody who may then be granted reach,
/// and reading a participant as an observer silently strips a grant that
/// exists.
pub(crate) fn admission_from(
    mode: Option<&str>,
    grant_id: Option<String>,
) -> anyhow::Result<Admission> {
    match (mode, grant_id) {
        (Some("observer"), None) => Ok(Admission::Observer),
        (Some("participant"), Some(minted)) => Ok(Admission::Participant {
            grant_id: SessionGrantId::parse(&minted).context("admitted grant id")?,
        }),
        (Some("participant"), None) => bail!("a participant admission with no grant"),
        (Some("observer"), Some(_)) => bail!("an observer admission carrying a grant"),
        (mode, _) => bail!("an admitted request with an unusable mode {mode:?}"),
    }
}
