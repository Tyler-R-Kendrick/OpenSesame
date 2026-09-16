//! Bridge to [`crate::GrantConstraints::budgets`].
//!
//! Grants already carry budgets as a plain `BTreeMap<String, i64>` of counts,
//! and [`crate::Grant::validate_attenuation`] compares them by walking the
//! **child's** keys. That loop cannot see an omission: a child that simply
//! does not mention `invocations` is compared to nothing, and downstream a
//! missing key reads as "this dimension was not metered" — so the way to get
//! an unmetered delegation is to say less, not more.
//!
//! [`effective_grant_budgets`] is the answer to that question in the shape the
//! existing map already has: the effective budget for a child is its parent's
//! map with the child's narrower entries applied over it. Feed it a child that
//! mentions nothing and every parent limit is still there.

use std::collections::BTreeMap;

use super::{BudgetError, BudgetKey, Limit, Limits, Quantity, Unit, WindowSpec};

/// Read a grant's budget map as [`Limits`] over `window`.
///
/// # Errors
///
/// Returns [`BudgetError::InvalidKey`] for an unusable key and
/// [`BudgetError::InvalidLimit`] for a negative count — a negative cap is not
/// a small budget, it is a malformed one.
pub fn limits_from_grant_budgets(
    budgets: &BTreeMap<String, i64>,
    window: WindowSpec,
) -> Result<Limits, BudgetError> {
    let mut entries = BTreeMap::new();
    for (raw, count) in budgets {
        let key = BudgetKey::parse(raw)?;
        let cap = u128::try_from(*count).map_err(|_| BudgetError::InvalidLimit {
            key: raw.clone(),
            detail: format!("{count} is negative"),
        })?;
        entries.insert(
            key,
            Limit::new(Quantity::from_minor_units(cap), Unit::count(), window),
        );
    }
    Ok(Limits::new(entries))
}

/// The budgets in force for a child grant, given its parent's.
///
/// Keys the child omits keep the parent's count; keys it states must exist in
/// the parent and must not be larger.
///
/// # Errors
///
/// Returns [`BudgetError::UnknownKey`] when the child invents a dimension,
/// [`BudgetError::WidenForbidden`] when it raises one, or the conversion
/// refusals from [`limits_from_grant_budgets`].
pub fn effective_grant_budgets(
    parent: &BTreeMap<String, i64>,
    child: &BTreeMap<String, i64>,
) -> Result<BTreeMap<String, i64>, BudgetError> {
    let effective = Limits::inherit(
        &limits_from_grant_budgets(parent, WindowSpec::Lifetime)?,
        &limits_from_grant_budgets(child, WindowSpec::Lifetime)?,
    )?;
    let mut budgets = BTreeMap::new();
    for (key, limit) in effective.iter() {
        let count =
            i64::try_from(limit.cap().minor_units()).map_err(|_| BudgetError::InvalidLimit {
                key: key.to_string(),
                detail: "cap does not fit a grant's i64 count".to_string(),
            })?;
        budgets.insert(key.to_string(), count);
    }
    Ok(budgets)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn map(pairs: &[(&str, i64)]) -> BTreeMap<String, i64> {
        pairs
            .iter()
            .map(|(key, value)| ((*key).to_string(), *value))
            .collect()
    }

    #[test]
    fn a_child_that_mentions_nothing_still_carries_the_parents_budgets() {
        let parent = map(&[("invocations", 100), ("usd", 5)]);
        let effective = effective_grant_budgets(&parent, &BTreeMap::new()).unwrap();
        assert_eq!(effective, parent);
    }

    #[test]
    fn a_child_that_mentions_one_key_inherits_the_rest() {
        let parent = map(&[("invocations", 100), ("usd", 5)]);
        let child = map(&[("invocations", 10)]);
        let effective = effective_grant_budgets(&parent, &child).unwrap();
        assert_eq!(effective, map(&[("invocations", 10), ("usd", 5)]));
    }

    #[test]
    fn a_child_cannot_raise_or_invent_a_budget() {
        let parent = map(&[("invocations", 10)]);
        assert!(matches!(
            effective_grant_budgets(&parent, &map(&[("invocations", 11)])),
            Err(BudgetError::WidenForbidden { .. })
        ));
        assert!(matches!(
            effective_grant_budgets(&parent, &map(&[("egress_bytes", 1)])),
            Err(BudgetError::UnknownKey(_))
        ));
    }

    #[test]
    fn a_negative_count_is_malformed_not_small() {
        assert!(matches!(
            limits_from_grant_budgets(&map(&[("invocations", -1)]), WindowSpec::Lifetime),
            Err(BudgetError::InvalidLimit { .. })
        ));
    }

    #[test]
    fn inheritance_is_idempotent_down_a_chain() {
        let parent = map(&[("invocations", 100)]);
        let once = effective_grant_budgets(&parent, &BTreeMap::new()).unwrap();
        let twice = effective_grant_budgets(&once, &BTreeMap::new()).unwrap();
        assert_eq!(once, twice);
        assert_eq!(twice, parent);
    }
}
