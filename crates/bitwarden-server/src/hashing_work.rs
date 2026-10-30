//! One bounded admission for account lookup, budget reservation and hash work.

use std::sync::Arc;

use tokio::sync::OwnedSemaphorePermit;
use zeroize::Zeroizing;

use crate::error::{ApiError, ApiResult};
use crate::hashing::Verdict;
use crate::BitwardenServer;

struct Permits {
    _admitted: OwnedSemaphorePermit,
    _working: OwnedSemaphorePermit,
}

/// An admitted request and its active hash slot. Blocking work retains its
/// own reference, so cancelling the HTTP request cannot release a running hash.
pub(crate) struct HashAdmission(Arc<Permits>);

async fn blocking<T: Send + 'static>(
    admission: &HashAdmission,
    work: impl FnOnce() -> T + Send + 'static,
) -> ApiResult<T> {
    let held = Arc::clone(&admission.0);
    tokio::task::spawn_blocking(move || {
        let _held = held;
        work()
    })
    .await
    .map_err(|error| ApiError::internal(&error.into()))
}

impl BitwardenServer {
    /// Acquire once, before public account lookup or any durable reservation.
    /// A full queue has the same response for known and invented identities.
    pub(crate) async fn hash_slot(&self) -> ApiResult<HashAdmission> {
        let admitted = Arc::clone(&self.hash_admission)
            .try_acquire_owned()
            .map_err(|_| ApiError::too_many_requests())?;
        let working = Arc::clone(&self.hash_permits)
            .acquire_owned()
            .await
            .map_err(|error| ApiError::internal(&error.into()))?;
        Ok(HashAdmission(Arc::new(Permits {
            _admitted: admitted,
            _working: working,
        })))
    }

    pub(crate) async fn hash_secret(&self, secret: &str) -> ApiResult<String> {
        let admission = self.hash_slot().await?;
        self.hash_secret_admitted(&admission, secret).await
    }

    async fn hash_secret_admitted(
        &self,
        admission: &HashAdmission,
        secret: &str,
    ) -> ApiResult<String> {
        let hashes = self.hashes.clone();
        let secret = Zeroizing::new(secret.to_owned());
        blocking(admission, move || hashes.hash(secret.as_bytes()))
            .await?
            .map_err(|error| ApiError::internal(&error.into()))
    }

    async fn verify_admitted(
        &self,
        admission: &HashAdmission,
        stored: String,
        secret: &str,
    ) -> ApiResult<Verdict> {
        let hashes = self.hashes.clone();
        let secret = Zeroizing::new(secret.to_owned());
        blocking(admission, move || hashes.verify(&stored, secret.as_bytes())).await
    }

    /// Check only after the caller has reserved the credential's durable budget.
    pub(crate) async fn check_secret_admitted(
        &self,
        admission: &HashAdmission,
        user_id: &str,
        stored: &str,
        secret: &str,
    ) -> ApiResult<bool> {
        match self
            .verify_admitted(admission, stored.to_owned(), secret)
            .await?
        {
            Verdict::Mismatch => Ok(false),
            Verdict::Match { rehash } => {
                if let Some(rehash) = rehash {
                    // Never undo a password change that won during verification.
                    self.db
                        .bitwarden_set_password_hash(user_id, stored, &rehash)
                        .await?;
                }
                Ok(true)
            }
        }
    }

    pub(crate) async fn check_secret_only_admitted(
        &self,
        admission: &HashAdmission,
        stored: &str,
        secret: &str,
    ) -> ApiResult<bool> {
        Ok(matches!(
            self.verify_admitted(admission, stored.to_owned(), secret)
                .await?,
            Verdict::Match { .. }
        ))
    }

    /// Unknown and exhausted public accounts still do ordinary decoy work.
    /// Reuses the caller's admission even when initializing the decoy hash.
    pub(crate) async fn decoy_check_admitted(
        &self,
        admission: &HashAdmission,
        secret: &str,
    ) -> ApiResult<()> {
        let decoy = self
            .decoy_hash
            .get_or_try_init(|| self.hash_secret_admitted(admission, "opensesame-decoy"))
            .await?
            .clone();
        let _ = self.verify_admitted(admission, decoy, secret).await?;
        Ok(())
    }
}

#[cfg(test)]
#[path = "hashing_work_tests.rs"]
mod tests;
