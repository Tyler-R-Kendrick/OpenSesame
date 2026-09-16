//! Caps, and how a child inherits them (BUD-DELEGATE).
//!
//! The rule this module exists for: **a child that says nothing about a
//! budget key is bound by its parent's limit on that key, not by no limit.**
//! Silence is not permission. [`Limits::inherit`] therefore starts from the
//! parent's whole map and lets the child replace entries only with narrower
//! ones — so omission can only ever leave authority the same or smaller.
//!
//! That is the opposite of what a "check every key the child declared" loop
//! does, which is how an unmetered dimension gets handed out: the child simply
//! declines to mention it and nothing ever compares it to anything.
//!
//! Narrowing is checked on three axes at once, because a cap is meaningless
//! without its period and its unit:
//!
//! - **unit** — must match exactly. Redenominating is not narrowing; nobody
//!   can tell whether `10 usd` under `1000 usd_cents` is smaller or larger
//!   without a rate this module has no business holding.
//! - **cap** — never above the parent's, so a single window can never spend
//!   more than the parent's own window allows (the burst bound).
//! - **rate** — cap per second never above the parent's, so a child cannot
//!   take the parent's ten-an-hour and spend ten a second (the sustained
//!   bound). A recurring child under a lifetime parent is refused outright:
//!   any refill beats a cap that never refills.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::{BudgetError, BudgetKey, Quantity, Unit, WindowSpec};

/// One cap: how much of what, per which period.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Limit {
    cap: Quantity,
    unit: Unit,
    window: WindowSpec,
}

impl Limit {
    #[must_use]
    pub const fn new(cap: Quantity, unit: Unit, window: WindowSpec) -> Self {
        Self { cap, unit, window }
    }

    #[must_use]
    pub const fn cap(&self) -> Quantity {
        self.cap
    }

    #[must_use]
    pub const fn unit(&self) -> &Unit {
        &self.unit
    }

    #[must_use]
    pub const fn window(&self) -> WindowSpec {
        self.window
    }

    /// Refuse unless `self` is no wider than `parent` on every axis.
    ///
    /// # Errors
    ///
    /// Returns [`BudgetError::UnitMismatch`] when the units differ, or
    /// [`BudgetError::WidenForbidden`] when the cap or the sustained rate
    /// exceeds the parent's.
    pub fn assert_narrows(&self, parent: &Self, key: &BudgetKey) -> Result<(), BudgetError> {
        if self.unit != parent.unit {
            return Err(BudgetError::UnitMismatch {
                key: key.to_string(),
                expected: parent.unit.to_string(),
                actual: self.unit.to_string(),
            });
        }
        if self.cap > parent.cap {
            return Err(BudgetError::WidenForbidden {
                key: key.to_string(),
                detail: format!(
                    "cap {} exceeds the parent's {}",
                    self.cap.to_decimal_string(&self.unit),
                    parent.cap.to_decimal_string(&parent.unit)
                ),
            });
        }
        self.assert_rate_narrows(parent, key)
    }

    /// The sustained-rate half of [`Limit::assert_narrows`].
    fn assert_rate_narrows(&self, parent: &Self, key: &BudgetKey) -> Result<(), BudgetError> {
        let Some(child_period) = self.window.period_seconds() else {
            // A lifetime child spends its cap once, ever. The cap check above
            // already bounded it, under either kind of parent.
            return Ok(());
        };
        let Some(parent_period) = parent.window.period_seconds() else {
            return Err(BudgetError::WidenForbidden {
                key: key.to_string(),
                detail: format!(
                    "a budget refilling every {child_period}s cannot narrow a lifetime cap"
                ),
            });
        };
        // cap_child/period_child <= cap_parent/period_parent, cross-multiplied
        // so the comparison stays in exact integers.
        let child_rate = self
            .cap
            .minor_units()
            .checked_mul(u128::from(parent_period))
            .ok_or(BudgetError::Overflow)?;
        let parent_rate = parent
            .cap
            .minor_units()
            .checked_mul(u128::from(child_period))
            .ok_or(BudgetError::Overflow)?;
        if child_rate > parent_rate {
            return Err(BudgetError::WidenForbidden {
                key: key.to_string(),
                detail: format!(
                    "{} every {child_period}s outpaces the parent's {} every {parent_period}s",
                    self.cap.to_decimal_string(&self.unit),
                    parent.cap.to_decimal_string(&parent.unit)
                ),
            });
        }
        Ok(())
    }
}

/// Every cap that applies at one point in a delegation chain.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Limits {
    entries: BTreeMap<BudgetKey, Limit>,
}

impl Limits {
    #[must_use]
    pub fn new(entries: BTreeMap<BudgetKey, Limit>) -> Self {
        Self { entries }
    }

    /// Nothing metered. Only legitimate at the root of a chain, where it
    /// means "this authority carries no budget dimension at all" — never as
    /// the result of a child staying quiet.
    #[must_use]
    pub fn unmetered() -> Self {
        Self::default()
    }

    #[must_use]
    pub fn get(&self, key: &BudgetKey) -> Option<&Limit> {
        self.entries.get(key)
    }

    #[must_use]
    pub fn contains(&self, key: &BudgetKey) -> bool {
        self.entries.contains_key(key)
    }

    pub fn iter(&self) -> impl Iterator<Item = (&BudgetKey, &Limit)> {
        self.entries.iter()
    }

    pub fn keys(&self) -> impl Iterator<Item = &BudgetKey> {
        self.entries.keys()
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// The limits actually in force for a child of `parent`.
    ///
    /// Keys the child omits keep the parent's limit. Keys the child states
    /// must already exist in the parent and must narrow it. The result is
    /// never wider than `parent` on any axis, and never has fewer keys.
    ///
    /// # Errors
    ///
    /// Returns [`BudgetError::UnknownKey`] when the child names a dimension
    /// the parent does not meter, or the refusal from
    /// [`Limit::assert_narrows`] when a stated limit widens one.
    pub fn inherit(parent: &Self, child: &Self) -> Result<Self, BudgetError> {
        let mut effective = parent.entries.clone();
        for (key, proposed) in &child.entries {
            let inherited = parent
                .entries
                .get(key)
                .ok_or_else(|| BudgetError::UnknownKey(key.to_string()))?;
            proposed.assert_narrows(inherited, key)?;
            effective.insert(key.clone(), proposed.clone());
        }
        Ok(Self { entries: effective })
    }

    /// Fold [`Limits::inherit`] down a delegation chain, root first.
    ///
    /// # Errors
    ///
    /// Returns the first refusal in the chain.
    pub fn inherit_chain<'a>(
        root: &Self,
        descendants: impl IntoIterator<Item = &'a Self>,
    ) -> Result<Self, BudgetError> {
        let mut effective = root.clone();
        for child in descendants {
            effective = Self::inherit(&effective, child)?;
        }
        Ok(effective)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(raw: &str) -> BudgetKey {
        BudgetKey::parse(raw).expect("test key")
    }

    fn calls(cap: u128, window: WindowSpec) -> Limit {
        Limit::new(Quantity::from_minor_units(cap), Unit::count(), window)
    }

    fn limits(entries: Vec<(&str, Limit)>) -> Limits {
        Limits::new(
            entries
                .into_iter()
                .map(|(raw, limit)| (key(raw), limit))
                .collect(),
        )
    }

    #[test]
    fn a_silent_child_inherits_every_parent_limit() {
        let parent = limits(vec![
            ("calls", calls(100, WindowSpec::Lifetime)),
            ("usd", {
                let unit = Unit::new("usd", 6).unwrap();
                Limit::new(
                    Quantity::parse_decimal("5.00", &unit).unwrap(),
                    unit,
                    WindowSpec::Lifetime,
                )
            }),
        ]);
        let effective = Limits::inherit(&parent, &Limits::unmetered()).unwrap();
        assert_eq!(effective, parent, "omission must not drop a limit");
    }

    #[test]
    fn a_child_that_states_one_key_still_inherits_the_others() {
        let parent = limits(vec![
            ("calls", calls(100, WindowSpec::Lifetime)),
            ("tokens", calls(1_000, WindowSpec::Lifetime)),
        ]);
        let child = limits(vec![("calls", calls(10, WindowSpec::Lifetime))]);
        let effective = Limits::inherit(&parent, &child).unwrap();
        assert_eq!(effective.len(), 2);
        assert_eq!(
            effective.get(&key("calls")).unwrap().cap(),
            Quantity::from_minor_units(10)
        );
        assert_eq!(
            effective.get(&key("tokens")).unwrap().cap(),
            Quantity::from_minor_units(1_000),
            "the key the child never mentioned keeps the parent's cap"
        );
    }

    #[test]
    fn a_child_cannot_invent_a_dimension() {
        let parent = limits(vec![("calls", calls(100, WindowSpec::Lifetime))]);
        let child = limits(vec![("usd", calls(1, WindowSpec::Lifetime))]);
        assert!(matches!(
            Limits::inherit(&parent, &child),
            Err(BudgetError::UnknownKey(_))
        ));
    }

    #[test]
    fn a_child_cannot_raise_a_cap() {
        let parent = limits(vec![("calls", calls(10, WindowSpec::Lifetime))]);
        let child = limits(vec![("calls", calls(11, WindowSpec::Lifetime))]);
        assert!(matches!(
            Limits::inherit(&parent, &child),
            Err(BudgetError::WidenForbidden { .. })
        ));
    }

    #[test]
    fn a_child_cannot_outpace_the_parent_with_an_equal_cap() {
        let hourly = WindowSpec::periodic(3_600).unwrap();
        let per_minute = WindowSpec::periodic(60).unwrap();
        let parent = limits(vec![("calls", calls(10, hourly))]);
        // Same cap, sixty times the rate.
        let child = limits(vec![("calls", calls(10, per_minute))]);
        assert!(matches!(
            Limits::inherit(&parent, &child),
            Err(BudgetError::WidenForbidden { .. })
        ));
        // Same rate, and the cap is no bigger: allowed.
        let paced = limits(vec![(
            "calls",
            calls(1, WindowSpec::periodic(360).unwrap()),
        )]);
        assert!(Limits::inherit(&parent, &paced).is_ok());
    }

    #[test]
    fn a_child_cannot_turn_a_lifetime_cap_into_an_allowance() {
        let parent = limits(vec![("calls", calls(10, WindowSpec::Lifetime))]);
        let child = limits(vec![(
            "calls",
            calls(10, WindowSpec::periodic(3_600).unwrap()),
        )]);
        assert!(matches!(
            Limits::inherit(&parent, &child),
            Err(BudgetError::WidenForbidden { .. })
        ));
        // The other direction is fine: spend it once instead of hourly.
        let hourly_parent = limits(vec![(
            "calls",
            calls(10, WindowSpec::periodic(3_600).unwrap()),
        )]);
        let once = limits(vec![("calls", calls(10, WindowSpec::Lifetime))]);
        assert!(Limits::inherit(&hourly_parent, &once).is_ok());
    }

    #[test]
    fn a_child_cannot_redenominate_a_cap() {
        let parent = limits(vec![(
            "usd",
            Limit::new(
                Quantity::from_minor_units(500),
                Unit::new("usd", 2).unwrap(),
                WindowSpec::Lifetime,
            ),
        )]);
        // 500 of a finer unit is "less" numerically but not comparable.
        let child = limits(vec![(
            "usd",
            Limit::new(
                Quantity::from_minor_units(500),
                Unit::new("usd", 6).unwrap(),
                WindowSpec::Lifetime,
            ),
        )]);
        assert!(matches!(
            Limits::inherit(&parent, &child),
            Err(BudgetError::UnitMismatch { .. })
        ));
    }

    #[test]
    fn a_chain_of_quiet_children_still_ends_at_the_root_limit() {
        let root = limits(vec![("calls", calls(100, WindowSpec::Lifetime))]);
        let quiet = [Limits::unmetered(), Limits::unmetered()];
        let narrowing = limits(vec![("calls", calls(5, WindowSpec::Lifetime))]);
        let effective = Limits::inherit_chain(&root, quiet.iter()).unwrap();
        assert_eq!(effective, root);
        let effective = Limits::inherit_chain(
            &root,
            [&Limits::unmetered(), &narrowing, &Limits::unmetered()],
        )
        .unwrap();
        assert_eq!(
            effective.get(&key("calls")).unwrap().cap(),
            Quantity::from_minor_units(5)
        );
    }
}
