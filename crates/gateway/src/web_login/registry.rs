//! The web-login runs this process has started, tracked (ADR 0159).
//!
//! A run takes minutes — every step waits on the owner's browser, and a whole
//! run may last 15 minutes — so it cannot run inside the lifecycle scanner's
//! pass, where one tenant's run would hold every other tenant's certificate
//! renewal behind it. The scanner *starts* a run here and moves on; the run
//! reports its own outcome on the same feed when it ends.
//!
//! The registry is a `JoinSet` of tasks and the bounds that keep them
//! honest:
//!
//! - **a global bound and a per-organization bound** on runs *executing*. A
//!   run beyond either waits its turn as a queued task; it holds nothing while
//!   it waits (no lease, no job, no browser step), so a queue that is lost is
//!   a queue of nothing. The organization's slot is taken before the global
//!   one, so a tenant waiting on its own bound never holds a slot another
//!   tenant could use;
//! - **one task per target.** A second start for the same organization and
//!   origin while one is queued or running is refused here. Across processes
//!   the same is done by the policy lease, which the run claims when it
//!   *starts executing* — so the lease's clock measures the run, not the wait;
//! - **a bound on how many may be queued at all**, so a flood of due policies
//!   is refused instead of remembered.
//!
//! A slot is released by a guard's `Drop`, so a run that panics, or is
//! aborted with its task, frees it. What such a run leaves behind in the store
//! is the reaper's ([`super::reaper`]).

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::{Arc, Mutex, PoisonError};

use tokio::sync::Semaphore;
use tokio::task::JoinSet;

/// Bounds on the runs a process executes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct RunLimits {
    /// Most runs executing at once, across organizations.
    pub global: usize,
    /// Most runs executing at once for one organization.
    pub per_org: usize,
    /// Most runs queued or executing at once; beyond it a start is refused.
    pub pending: usize,
}

impl Default for RunLimits {
    fn default() -> Self {
        Self {
            global: 8,
            per_org: 2,
            pending: 512,
        }
    }
}

impl RunLimits {
    /// The defaults, overridden by `OPENSESAME_WEB_LOGIN_MAX_RUNS`,
    /// `OPENSESAME_WEB_LOGIN_MAX_RUNS_PER_ORG` and
    /// `OPENSESAME_WEB_LOGIN_MAX_PENDING_RUNS`. A value that is not a positive
    /// integer is ignored — a bound of zero would be a switch that turns
    /// rotation off without saying so.
    pub(crate) fn from_env() -> Self {
        let default = Self::default();
        Self {
            global: env_bound("OPENSESAME_WEB_LOGIN_MAX_RUNS", default.global),
            per_org: env_bound("OPENSESAME_WEB_LOGIN_MAX_RUNS_PER_ORG", default.per_org),
            pending: env_bound("OPENSESAME_WEB_LOGIN_MAX_PENDING_RUNS", default.pending),
        }
    }
}

fn env_bound(name: &str, default: usize) -> usize {
    match std::env::var(name)
        .ok()
        .map(|raw| raw.trim().parse::<usize>())
    {
        None => default,
        Some(Ok(bound)) if bound >= 1 => bound,
        Some(_) => {
            tracing::warn!(
                variable = name,
                default,
                "ignoring a bound that is not a positive integer"
            );
            default
        }
    }
}

/// Why a start was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Refused {
    /// This organization and origin already has a run queued or executing.
    InFlight,
    /// The pending bound is reached.
    Full,
}

/// Removes a run's key when its task ends, however it ends.
struct KeyGuard {
    keys: Arc<Mutex<HashSet<String>>>,
    key: String,
}

impl Drop for KeyGuard {
    fn drop(&mut self) {
        self.keys
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&self.key);
    }
}

/// The tracked runs of one process. Owned by `AppState`.
pub(crate) struct RunRegistry {
    limits: RunLimits,
    global: Arc<Semaphore>,
    keys: Arc<Mutex<HashSet<String>>>,
    tasks: Mutex<JoinSet<()>>,
    orgs: Mutex<HashMap<String, Arc<Semaphore>>>,
}

impl RunRegistry {
    pub(crate) fn new(limits: RunLimits) -> Self {
        Self {
            limits,
            global: Arc::new(Semaphore::new(limits.global)),
            keys: Arc::default(),
            tasks: Mutex::new(JoinSet::new()),
            orgs: Mutex::default(),
        }
    }

    pub(crate) fn from_env() -> Self {
        Self::new(RunLimits::from_env())
    }

    /// The default bounds, without reading the environment: a process a test
    /// stands up beside another one.
    #[cfg(test)]
    pub(crate) fn default_for_tests() -> Self {
        Self::new(RunLimits::default())
    }

    /// Start `work` as a tracked task for `key` in `organization`.
    ///
    /// The task waits for its organization's slot and then a global one before
    /// `work` begins, and gives both back when it ends.
    ///
    /// # Errors
    ///
    /// [`Refused::InFlight`] for a key already queued or executing;
    /// [`Refused::Full`] when the pending bound is reached.
    pub(crate) fn spawn<F>(&self, organization: &str, key: String, work: F) -> Result<(), Refused>
    where
        F: Future<Output = ()> + Send + 'static,
    {
        let mut tasks = self.tasks.lock().unwrap_or_else(PoisonError::into_inner);
        reap(&mut tasks);
        let guard = {
            let mut keys = self.keys.lock().unwrap_or_else(PoisonError::into_inner);
            if keys.contains(&key) {
                return Err(Refused::InFlight);
            }
            if keys.len() >= self.limits.pending {
                return Err(Refused::Full);
            }
            keys.insert(key.clone());
            KeyGuard {
                keys: Arc::clone(&self.keys),
                key,
            }
        };
        let org_slots = Arc::clone(
            self.orgs
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .entry(organization.to_owned())
                .or_insert_with(|| Arc::new(Semaphore::new(self.limits.per_org))),
        );
        let global = Arc::clone(&self.global);
        tasks.spawn(async move {
            let _guard = guard;
            let Ok(_org) = org_slots.acquire_owned().await else {
                return;
            };
            let Ok(_global) = global.acquire_owned().await else {
                return;
            };
            work.await;
        });
        Ok(())
    }

    /// Collect finished tasks, logging any that panicked. A task's result is
    /// held until somebody asks; the reaper asks on every pass.
    pub(crate) fn reap(&self) {
        reap(&mut self.tasks.lock().unwrap_or_else(PoisonError::into_inner));
    }

    /// Runs queued or executing.
    #[cfg(test)]
    pub(crate) fn pending(&self) -> usize {
        self.keys
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .len()
    }

    /// Runs executing right now.
    #[cfg(test)]
    pub(crate) fn running(&self) -> usize {
        self.limits.global - self.global.available_permits().min(self.limits.global)
    }

    /// Whether `key` is queued or executing.
    #[cfg(test)]
    pub(crate) fn contains(&self, key: &str) -> bool {
        self.keys
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .contains(key)
    }

    /// Stop every task where it stands, as a dying process would: nothing is
    /// settled, announced or released. Slots are freed by the guards.
    #[cfg(test)]
    pub(crate) fn abort_all(&self) {
        self.tasks
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .abort_all();
    }

    /// Wait until no run is queued or executing.
    #[cfg(test)]
    pub(crate) async fn idle(&self) {
        while self.pending() > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    }
}

fn reap(tasks: &mut JoinSet<()>) {
    while let Some(joined) = tasks.try_join_next() {
        if let Err(error) = joined {
            if error.is_panic() {
                tracing::error!("a web-login run panicked; its slot is free and the reaper will close what it left");
            }
        }
    }
}

#[cfg(test)]
#[path = "registry_tests.rs"]
mod tests;
