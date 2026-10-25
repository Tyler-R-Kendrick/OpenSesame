//! Independent local authorization for credential operations. The extension
//! can request a grant, but only the no-Origin operator channel approves it.
//! No bearer or value is retained; grants live only in memory for 90 seconds.

use super::{caller::Caller, pairing::digest_hex, Field};
use chrono::{DateTime, Duration, Utc};
use serde::Serialize;
use std::sync::Mutex;

const TTL_SECS: i64 = 90;
const PER_CALLER: usize = 8;
const MAX_REQUESTS: usize = 128;

#[derive(Clone, Serialize)]
pub(super) struct Request {
    pub(super) id: String,
    extension_origin: String,
    #[serde(skip)]
    token_digest: String,
    origin: String,
    /// None authorizes names only, never a credential value.
    reference: Option<String>,
    field: Option<Field>,
    expires_at: DateTime<Utc>,
    approved: bool,
}

#[derive(Default)]
pub(super) struct Approvals(Mutex<Vec<Request>>);

impl Approvals {
    fn lock(&self) -> std::sync::MutexGuard<'_, Vec<Request>> {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Spend a one-use field grant, or enqueue the exact operation. A names
    /// grant may be read again during its short lifetime so popup refresh and
    /// the subsequent fill gesture can both choose from the same site.
    pub(super) fn admit(
        &self,
        caller: &Caller,
        origin: &str,
        value: Option<(&str, Field)>,
        now: DateTime<Utc>,
    ) -> bool {
        self.admit_with_budget(caller, origin, value, now, || Ok(()))
            .unwrap_or(false)
    }

    /// Check the release budget before spending an approved grant, under the
    /// same lock. A 429 must leave the person's authorization available.
    pub(super) fn admit_with_budget(
        &self,
        caller: &Caller,
        origin: &str,
        value: Option<(&str, Field)>,
        now: DateTime<Utc>,
        budget: impl FnOnce() -> Result<(), u64>,
    ) -> Result<bool, u64> {
        let digest = digest_hex(&caller.token);
        let mut requests = self.lock();
        requests.retain(|request| request.expires_at > now);
        if let Some(index) = requests.iter().position(|request| {
            request.extension_origin == caller.origin
                && request.token_digest == digest
                && request.origin == origin
                && request.reference.as_deref() == value.map(|(reference, _)| reference)
                && request.field == value.map(|(_, field)| field)
        }) {
            if !requests[index].approved {
                return Ok(false);
            }
            budget()?;
            if value.is_some() {
                requests.remove(index);
            }
            return Ok(true);
        }
        let count = requests
            .iter()
            .filter(|request| {
                request.extension_origin == caller.origin && request.token_digest == digest
            })
            .count();
        if requests.len() < MAX_REQUESTS && count < PER_CALLER {
            requests.push(Request {
                id: uuid::Uuid::new_v4().to_string(),
                extension_origin: caller.origin.clone(),
                token_digest: digest,
                origin: origin.to_string(),
                reference: value.map(|(reference, _)| reference.to_string()),
                field: value.map(|(_, field)| field),
                expires_at: now + Duration::seconds(TTL_SECS),
                approved: false,
            });
        }
        Ok(false)
    }

    pub(super) fn list(&self, now: DateTime<Utc>) -> Vec<Request> {
        let mut requests = self.lock();
        requests.retain(|request| request.expires_at > now);
        requests.clone()
    }

    pub(super) fn approve(&self, id: &str, now: DateTime<Utc>) -> Option<Request> {
        let mut requests = self.lock();
        requests.retain(|request| request.expires_at > now);
        let request = requests.iter_mut().find(|request| request.id == id)?;
        request.approved = true;
        Some(request.clone())
    }

    /// Pairing revocation/replacement ends every operation authorized under
    /// that caller lifecycle, even if the same bearer is paired again later.
    pub(super) fn revoke_origin(&self, origin: &str) {
        self.lock()
            .retain(|request| request.extension_origin != origin);
    }
}

#[cfg(test)]
#[path = "approval_tests.rs"]
mod tests;
