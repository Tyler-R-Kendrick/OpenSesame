//! Bounded memory, fuel, and deadline — as a lattice, not as settings.
//!
//! [`ResourceBudget::CEILING`] is the platform's word on what a sandboxed
//! run may ever consume. A grant may ask for less; nothing can ask for
//! more, because the only way to obtain a budget is
//! [`ResourceBudget::narrowed_to`], which takes the componentwise minimum
//! with the ceiling. The type has no public constructor and no `Default`,
//! so a caller cannot assemble one field by field and hand it to the
//! runtime.
//!
//! Zero is not a legal request. A grant asking for zero fuel is asking for
//! a run that cannot execute one instruction; that is a malformed grant,
//! not a very small budget, and it is refused rather than silently floored.

use std::collections::BTreeMap;
use std::time::Duration;

use crate::error::SandboxError;

/// Grant-budget keys this crate understands. Anything else in a grant's
/// budget map belongs to some other subsystem and is ignored here.
pub mod keys {
    /// Instruction budget, in Wasmtime fuel units.
    pub const FUEL: &str = "sandbox.fuel";
    /// Wall-clock deadline, in milliseconds.
    pub const DEADLINE_MS: &str = "sandbox.deadline_ms";
    /// Linear-memory cap, in bytes.
    pub const MEMORY_BYTES: &str = "sandbox.memory_bytes";
    /// Cap on bytes the guest may emit as its result.
    pub const EMIT_BYTES: &str = "sandbox.emit_bytes";
}

/// What a single run may consume.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ResourceBudget {
    fuel: u64,
    deadline: Duration,
    max_memory_bytes: usize,
    max_emit_bytes: usize,
    max_broker_response_bytes: usize,
}

impl ResourceBudget {
    /// The platform ceiling. Every other budget is this one, narrowed.
    ///
    /// Fuel and the deadline are not two spellings of one limit, and
    /// neither is derived from the other. Fuel bounds **work done**: it is
    /// machine-independent, so the same guest costs the same fuel on a
    /// laptop and on a server. The deadline bounds **wall-clock time**,
    /// including time spent waiting inside a brokered call, where the guest
    /// is not executing and burns no fuel at all.
    ///
    /// That is why both exist. A compute-bound runaway is stopped by fuel; a
    /// guest that holds a slot open by calling a slow destination in a loop
    /// is stopped only by the clock. Which of the two binds first depends on
    /// the guest and on the hardware, and calibrating one against the other
    /// would mean baking a particular machine's instruction rate into a
    /// policy constant.
    ///
    /// Five billion fuel units is on the order of a second of compute on
    /// contemporary hardware — enough for real work, far short of unbounded.
    pub const CEILING: Self = Self {
        fuel: 5_000_000_000,
        deadline: Duration::from_secs(5),
        max_memory_bytes: 64 * 1024 * 1024,
        max_emit_bytes: 1024 * 1024,
        max_broker_response_bytes: 4 * 1024 * 1024,
    };

    /// Instruction budget in fuel units.
    #[must_use]
    pub const fn fuel(self) -> u64 {
        self.fuel
    }

    /// Wall-clock deadline for one run.
    #[must_use]
    pub const fn deadline(self) -> Duration {
        self.deadline
    }

    /// Linear-memory cap in bytes.
    #[must_use]
    pub const fn max_memory_bytes(self) -> usize {
        self.max_memory_bytes
    }

    /// Cap on the run's emitted result.
    #[must_use]
    pub const fn max_emit_bytes(self) -> usize {
        self.max_emit_bytes
    }

    /// Cap on bytes a brokered call may hand back into guest memory.
    #[must_use]
    pub const fn max_broker_response_bytes(self) -> usize {
        self.max_broker_response_bytes
    }

    /// Read a grant's budget map and narrow the ceiling by it.
    ///
    /// Absent keys leave the ceiling in place; present keys must be
    /// positive, and only ever pull a dimension down.
    ///
    /// # Errors
    ///
    /// Returns [`SandboxError::Profile`] when a requested dimension is zero
    /// or negative.
    pub fn from_grant_budgets(budgets: &BTreeMap<String, i64>) -> Result<Self, SandboxError> {
        let ceiling = Self::CEILING;
        let fuel = read_positive(budgets, keys::FUEL)?;
        let deadline_ms = read_positive(budgets, keys::DEADLINE_MS)?;
        let memory = read_positive(budgets, keys::MEMORY_BYTES)?;
        let emit = read_positive(budgets, keys::EMIT_BYTES)?;
        Ok(Self {
            fuel: min_or(ceiling.fuel, fuel),
            deadline: match deadline_ms {
                Some(ms) => ceiling.deadline.min(Duration::from_millis(ms)),
                None => ceiling.deadline,
            },
            max_memory_bytes: min_usize_or(ceiling.max_memory_bytes, memory),
            max_emit_bytes: min_usize_or(ceiling.max_emit_bytes, emit),
            max_broker_response_bytes: ceiling.max_broker_response_bytes,
        })
    }

    /// Narrow this budget by another: every dimension takes the smaller.
    ///
    /// Used to fold a chain — the run gets the tightest constraint any hop
    /// imposed, so a permissive leaf under a strict root stays strict.
    #[must_use]
    pub fn narrowed_to(self, other: Self) -> Self {
        Self {
            fuel: self.fuel.min(other.fuel),
            deadline: self.deadline.min(other.deadline),
            max_memory_bytes: self.max_memory_bytes.min(other.max_memory_bytes),
            max_emit_bytes: self.max_emit_bytes.min(other.max_emit_bytes),
            max_broker_response_bytes: self
                .max_broker_response_bytes
                .min(other.max_broker_response_bytes),
        }
    }

    /// Clamp the deadline to the time actually left on the authority.
    ///
    /// A run may not outlive the grant that authorized it, so the shorter of
    /// the two always wins.
    #[must_use]
    pub fn clamped_to_remaining(self, remaining: Duration) -> Self {
        Self {
            deadline: self.deadline.min(remaining),
            ..self
        }
    }

    /// Whether this budget could run anything at all.
    #[must_use]
    pub fn is_runnable(self) -> bool {
        self.fuel > 0 && !self.deadline.is_zero() && self.max_memory_bytes > 0
    }
}

fn read_positive(
    budgets: &BTreeMap<String, i64>,
    key: &'static str,
) -> Result<Option<u64>, SandboxError> {
    match budgets.get(key) {
        None => Ok(None),
        Some(&value) if value > 0 => u64::try_from(value)
            .map(Some)
            .map_err(|_| SandboxError::Profile(format!("budget `{key}` is not representable"))),
        Some(value) => Err(SandboxError::Profile(format!(
            "budget `{key}` must be positive, got {value}"
        ))),
    }
}

fn min_or(ceiling: u64, requested: Option<u64>) -> u64 {
    match requested {
        Some(value) => ceiling.min(value),
        None => ceiling,
    }
}

fn min_usize_or(ceiling: usize, requested: Option<u64>) -> usize {
    match requested.and_then(|value| usize::try_from(value).ok()) {
        Some(value) => ceiling.min(value),
        None => ceiling,
    }
}

#[cfg(test)]
mod tests {
    use super::{keys, ResourceBudget};
    use std::collections::BTreeMap;
    use std::time::Duration;

    fn budgets(pairs: &[(&str, i64)]) -> BTreeMap<String, i64> {
        pairs.iter().map(|(k, v)| ((*k).to_owned(), *v)).collect()
    }

    #[test]
    fn a_grant_can_only_narrow_the_ceiling_never_raise_it() {
        let greedy = budgets(&[
            (keys::FUEL, 9_000_000_000),
            (keys::DEADLINE_MS, 600_000),
            (keys::MEMORY_BYTES, 8 * 1024 * 1024 * 1024),
            (keys::EMIT_BYTES, 1024 * 1024 * 1024),
        ]);
        let budget = ResourceBudget::from_grant_budgets(&greedy).expect("greedy budget clamps");
        assert_eq!(budget, ResourceBudget::CEILING);
    }

    #[test]
    fn a_modest_request_is_honored_dimension_by_dimension() {
        let modest = budgets(&[(keys::FUEL, 1_000), (keys::DEADLINE_MS, 250)]);
        let budget = ResourceBudget::from_grant_budgets(&modest).expect("modest budget");
        assert_eq!(budget.fuel(), 1_000);
        assert_eq!(budget.deadline(), Duration::from_millis(250));
        // Untouched dimensions stay at the ceiling.
        assert_eq!(
            budget.max_memory_bytes(),
            ResourceBudget::CEILING.max_memory_bytes()
        );
    }

    #[test]
    fn zero_and_negative_requests_are_malformed_not_tiny() {
        for value in [0, -1, i64::MIN] {
            let asked = budgets(&[(keys::FUEL, value)]);
            assert!(
                ResourceBudget::from_grant_budgets(&asked).is_err(),
                "fuel {value} must be refused"
            );
        }
    }

    #[test]
    fn narrowing_takes_the_tighter_of_every_dimension() {
        let strict = ResourceBudget::from_grant_budgets(&budgets(&[
            (keys::FUEL, 500),
            (keys::MEMORY_BYTES, 65_536),
        ]))
        .expect("strict");
        let loose = ResourceBudget::from_grant_budgets(&budgets(&[
            (keys::FUEL, 5_000),
            (keys::DEADLINE_MS, 100),
        ]))
        .expect("loose");
        let folded = loose.narrowed_to(strict);
        assert_eq!(folded.fuel(), 500);
        assert_eq!(folded.max_memory_bytes(), 65_536);
        assert_eq!(folded.deadline(), Duration::from_millis(100));
        // Folding is commutative, which is what makes chain order irrelevant.
        assert_eq!(folded, strict.narrowed_to(loose));
    }

    #[test]
    fn a_run_never_outlives_the_authority_behind_it() {
        let budget = ResourceBudget::CEILING.clamped_to_remaining(Duration::from_millis(40));
        assert_eq!(budget.deadline(), Duration::from_millis(40));
        assert!(budget.is_runnable());
        assert!(!ResourceBudget::CEILING
            .clamped_to_remaining(Duration::ZERO)
            .is_runnable());
    }
}
