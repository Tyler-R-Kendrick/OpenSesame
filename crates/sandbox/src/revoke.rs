//! SBOX-REVOKE — revocation that reaches a run already in flight.
//!
//! Revoking authority is only half an answer if a guest is already
//! executing. This module gives revocation two effects, and both matter:
//!
//! 1. **The boundary closes.** Every brokered call re-checks the fence
//!    before it does anything, so a revoked run cannot fetch, sign, acquire
//!    a token, or emit a result — not even one it had already computed.
//! 2. **The run stops.** The engine's epoch is advanced, which traps the
//!    guest wherever it is, including inside a loop that makes no calls and
//!    would otherwise burn its whole fuel budget first.
//!
//! The fence is a generation counter, not a boolean, so it also covers the
//! subtler case: a profile minted against generation *n* is stale the moment
//! anything in the tenant's authority changes, even if the specific grant
//! behind it was not the thing revoked. That is the same
//! `invalidation_generation` an `opensesame_domain::ValidatedGrantChain`
//! records, so the sandbox fences on exactly what the policy layer fences
//! on rather than inventing a second notion of "still valid".
//!
//! # This is not a second invalidation model
//!
//! ADR 0121 decides *whether authority is still good*, durably, per node,
//! and it rejects a generation counter for that job on purpose — a counter
//! cannot say "revoke this intermediate and leave its siblings alone".
//! Nothing here tries to. This module answers a different and much smaller
//! question: **is the run in front of me still allowed to continue?**
//!
//! The division of labour:
//!
//! - the durable fence decides, and its answer is what
//!   `ValidatedGrantChain::try_validate` carries into a profile;
//! - [`RevocationLedger::revoke`] is a *liveness broadcast* over runs that
//!   have already started, and it is deliberately coarse. A bump invalidates
//!   every in-flight run under it, including runs whose own authority was
//!   untouched. That is the conservative direction: the cost of a bump is a
//!   run that must be restarted, and the cost of the alternative is a guest
//!   still executing under authority somebody withdrew.
//! - [`RevocationFence::kill`] is the per-run stop, which is how "this one,
//!   not its siblings" is expressed here without a per-node counter.
//!
//! So a bump may be over-broad but is never permissive, and a caller that
//! wants precision kills the run rather than moving the ledger.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use crate::error::SandboxError;

/// The tenant-wide revocation counter a fence is checked against.
///
/// Cheap to clone (it is an `Arc` inside) and safe to share across threads:
/// the killing thread and the running guest touch the same cell.
#[derive(Clone, Debug, Default)]
pub struct RevocationLedger {
    generation: Arc<AtomicU64>,
}

impl RevocationLedger {
    /// A ledger starting at `generation`.
    #[must_use]
    pub fn at(generation: u64) -> Self {
        Self {
            generation: Arc::new(AtomicU64::new(generation)),
        }
    }

    /// The generation right now.
    #[must_use]
    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }

    /// Record a revocation; returns the new generation.
    ///
    /// Any fence minted before this call is now stale, which is the whole
    /// mechanism: revocation does not have to find the runs it invalidates.
    /// The new generation is worth keeping: it is what a caller records so a
    /// later profile can be minted against it.
    #[must_use = "the new generation is what a later profile must be minted against"]
    pub fn revoke(&self) -> u64 {
        self.generation.fetch_add(1, Ordering::SeqCst) + 1
    }

    /// Mint a fence pinned to the current generation.
    #[must_use]
    pub fn fence(&self) -> RevocationFence {
        RevocationFence {
            ledger: self.clone(),
            minted_at: self.generation(),
            killed: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Mint a fence pinned to a specific generation — the one a profile was
    /// derived at.
    ///
    /// A profile minted against an older generation produces a fence that is
    /// already stale, so a stale profile cannot start a run.
    #[must_use]
    pub fn fence_at(&self, generation: u64) -> RevocationFence {
        RevocationFence {
            ledger: self.clone(),
            minted_at: generation,
            killed: Arc::new(AtomicBool::new(false)),
        }
    }
}

/// One run's view of revocation.
#[derive(Clone, Debug)]
pub struct RevocationFence {
    ledger: RevocationLedger,
    minted_at: u64,
    killed: Arc<AtomicBool>,
}

impl RevocationFence {
    /// The generation this fence was minted against.
    #[must_use]
    pub const fn minted_at(&self) -> u64 {
        self.minted_at
    }

    /// Whether the authority behind this run is still current.
    #[must_use]
    pub fn is_live(&self) -> bool {
        !self.killed.load(Ordering::SeqCst) && self.ledger.generation() == self.minted_at
    }

    /// Refuse if the authority is gone.
    ///
    /// # Errors
    ///
    /// Returns [`SandboxError::Revoked`] naming both generations, so an
    /// operator reading a receipt can see how far behind the run was.
    pub fn check(&self) -> Result<(), SandboxError> {
        if self.is_live() {
            return Ok(());
        }
        Err(SandboxError::Revoked {
            expected: self.minted_at,
            observed: self.observed_generation(),
        })
    }

    /// Kill just this run, without touching the tenant's ledger.
    ///
    /// Used for a per-run stop — an operator killing one agent — where
    /// bumping the tenant generation would invalidate every other run too.
    pub fn kill(&self) {
        self.killed.store(true, Ordering::SeqCst);
    }

    /// Whether this specific run was killed (as opposed to aged out by a
    /// ledger bump).
    #[must_use]
    pub fn was_killed(&self) -> bool {
        self.killed.load(Ordering::SeqCst)
    }

    /// The ledger this fence watches.
    #[must_use]
    pub fn ledger(&self) -> &RevocationLedger {
        &self.ledger
    }

    fn observed_generation(&self) -> u64 {
        if self.killed.load(Ordering::SeqCst) {
            // A direct kill is reported as "one past", so the message reads
            // as a revocation rather than as an impossible equal-generation
            // failure.
            self.minted_at.saturating_add(1)
        } else {
            self.ledger.generation()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{RevocationFence, RevocationLedger};
    use crate::error::SandboxError;

    #[test]
    fn a_fence_is_live_until_the_ledger_moves_under_it() {
        let ledger = RevocationLedger::at(3);
        let fence = ledger.fence();
        assert_eq!(fence.minted_at(), 3);
        assert!(fence.is_live());
        assert!(fence.check().is_ok());

        assert_eq!(ledger.revoke(), 4);
        assert!(!fence.is_live());
        assert_eq!(
            fence.check(),
            Err(SandboxError::Revoked {
                expected: 3,
                observed: 4
            })
        );
    }

    #[test]
    fn a_profile_minted_at_an_older_generation_is_stale_before_it_starts() {
        let ledger = RevocationLedger::at(9);
        // The profile was derived at generation 7; two revocations happened
        // since, and nothing had to go find this run to invalidate it.
        let stale = ledger.fence_at(7);
        assert!(!stale.is_live());
        assert!(matches!(stale.check(), Err(SandboxError::Revoked { .. })));
    }

    #[test]
    fn killing_one_run_does_not_invalidate_its_siblings() {
        let ledger = RevocationLedger::at(0);
        let mine = ledger.fence();
        let sibling = ledger.fence();
        mine.kill();
        assert!(!mine.is_live());
        assert!(mine.was_killed());
        assert!(sibling.is_live(), "a sibling run must be unaffected");
        assert_eq!(ledger.generation(), 0, "a per-run kill is not a revocation");
    }

    #[test]
    fn a_clone_of_a_fence_sees_the_kill_that_reached_the_original() {
        // The runtime hands clones to import closures; a kill has to reach
        // every one of them or the boundary stays open after revocation.
        let ledger = RevocationLedger::at(0);
        let fence = ledger.fence();
        let handed_to_an_import: RevocationFence = fence.clone();
        fence.kill();
        assert!(!handed_to_an_import.is_live());
    }

    #[test]
    fn revocation_from_another_thread_is_visible_to_the_fence() {
        let ledger = RevocationLedger::at(0);
        let fence = ledger.fence();
        let far_away = ledger.clone();
        let handle = std::thread::spawn(move || far_away.revoke());
        let generation = handle.join().expect("revoking thread joins");
        assert_eq!(generation, 1);
        assert!(!fence.is_live());
    }
}
