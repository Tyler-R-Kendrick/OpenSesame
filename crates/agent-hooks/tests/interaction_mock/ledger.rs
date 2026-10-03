//! The rows the Identity API keeps, for the faults that need more than one
//! subject: the authorization-request create de-duplicates on the digest of
//! what it was asked (approver, requester, details, binding message) and
//! answers `200` with the live row it already holds, an interaction is
//! refused while one is live for its subject, and cancelling a request
//! revokes the interaction fronting it.

#![allow(dead_code)]

use serde_json::Value;

use super::handlers::Mock;
use super::REF;

/// One authorization request, and the interaction fronting it, if any.
pub(super) struct Row {
    pub(super) id: String,
    /// What the create route de-duplicates on.
    key: String,
    details: Value,
    cancelled: bool,
    interaction: Option<Front>,
}

struct Front {
    reference: String,
    digest: String,
    revoked: bool,
    consumed: bool,
}

/// Where an interaction stands, as a consume sees it.
pub(super) enum Standing {
    Unknown,
    Revoked,
    Approved,
    Open,
}

impl Row {
    /// Pending: neither withdrawn nor settled.
    fn live(&self) -> bool {
        !self.cancelled
            && self
                .interaction
                .as_ref()
                .is_none_or(|front| !front.consumed)
    }
}

/// The row an authorization-request create lands on, and whether it was
/// de-duplicated onto one that already existed.
pub(super) fn raise(mock: &Mock, body: &Value) -> (String, bool) {
    let details = body["authorizationDetails"].clone();
    let key = format!("{details}\0{}", body["bindingMessage"]);
    let mut rows = mock.rows.lock().unwrap();
    if let Some(row) = rows.iter().find(|row| row.live() && row.key == key) {
        return (row.id.clone(), true);
    }
    let id = format!("areq_{}", rows.len() + 1);
    rows.push(Row {
        id: id.clone(),
        key,
        details,
        cancelled: false,
        interaction: None,
    });
    mock.seen.lock().unwrap().auth_requests.push(body.clone());
    (id, false)
}

/// The reference of the interaction raised for `subject_id`, or `None` when
/// one is already live for it (`409 interaction_already_live`).
pub(super) fn front(mock: &Mock, subject_id: &str) -> Option<String> {
    let mut rows = mock.rows.lock().unwrap();
    let (n, row) = rows
        .iter_mut()
        .enumerate()
        .find(|(_, row)| row.id == subject_id)?;
    if row.interaction.as_ref().is_some_and(|f| !f.revoked) {
        return None;
    }
    let reference = REF.replace("tag-1", &format!("tag-{}", n + 1));
    row.interaction = Some(Front {
        reference: reference.clone(),
        digest: String::new(),
        revoked: false,
        consumed: false,
    });
    Some(reference)
}

pub(super) fn set_digest(mock: &Mock, reference: &str, digest: &str) {
    let mut rows = mock.rows.lock().unwrap();
    for front in rows.iter_mut().filter_map(|row| row.interaction.as_mut()) {
        if front.reference == reference {
            digest.clone_into(&mut front.digest);
        }
    }
}

/// The details and the digest the interaction `reference` was raised with.
pub(super) fn raised_with(mock: &Mock, reference: &str) -> Option<(Value, String)> {
    let rows = mock.rows.lock().unwrap();
    rows.iter().find_map(|row| {
        let front = row.interaction.as_ref()?;
        (front.reference == reference).then(|| (row.details.clone(), front.digest.clone()))
    })
}

pub(super) fn standing(mock: &Mock, reference: &str) -> Standing {
    let approved = mock.seen.lock().unwrap().approved.clone();
    let rows = mock.rows.lock().unwrap();
    for row in rows.iter() {
        let Some(front) = &row.interaction else {
            continue;
        };
        if front.reference != reference {
            continue;
        }
        return if front.revoked || row.cancelled {
            Standing::Revoked
        } else if approved.contains(&row.id) || front.consumed {
            Standing::Approved
        } else {
            Standing::Open
        };
    }
    Standing::Unknown
}

pub(super) fn consumed(mock: &Mock, reference: &str) {
    let mut rows = mock.rows.lock().unwrap();
    for front in rows.iter_mut().filter_map(|row| row.interaction.as_mut()) {
        if front.reference == reference {
            front.consumed = true;
        }
    }
}

pub(super) fn revoke(mock: &Mock, reference: &str) {
    let mut rows = mock.rows.lock().unwrap();
    for front in rows.iter_mut().filter_map(|row| row.interaction.as_mut()) {
        if front.reference == reference {
            front.revoked = true;
        }
    }
}

/// Cancel a request; the interaction fronting it is revoked with it.
pub(super) fn cancel(mock: &Mock, subject_id: &str) {
    let mut rows = mock.rows.lock().unwrap();
    for row in rows.iter_mut().filter(|row| row.id == subject_id) {
        row.cancelled = true;
        if let Some(front) = row.interaction.as_mut() {
            front.revoked = true;
        }
    }
}
