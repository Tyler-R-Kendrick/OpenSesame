//! Budget vocabulary rules for a delegation.
//!
//! A budget is a meter an enforcer spends against, so what it means for a child
//! to be *silent* about one matters as much as the numbers. Silence cannot mean
//! "unmetered": a child that stops naming a key the parent metered would be
//! read as having no limit at all, which is the widest possible reading of a
//! restriction. Silence also cannot be filled in by the enforcer, because
//! enforcement reads the budget off one grant. So a hop either carries every
//! meter its parent carried, at or below the parent's value, or it is refused —
//! and whoever mints the child inherits the parent's meters up front with
//! [`inherit_budgets`].

use crate::DomainError;
use std::collections::BTreeMap;

/// Compare a child's meters against its parent's.
///
/// # Errors
///
/// Returns [`DomainError::GrantAttenuation`] when a meter is dropped, raised,
/// negative, or names a key the parent never metered.
pub fn validate_budget_attenuation(
    parent: &BTreeMap<String, i64>,
    child: &BTreeMap<String, i64>,
) -> Result<(), DomainError> {
    for (key, ceiling) in parent {
        if *ceiling < 0 {
            return Err(DomainError::GrantAttenuation(format!(
                "parent budget {key} is negative"
            )));
        }
        match child.get(key) {
            Some(value) if *value >= 0 && value <= ceiling => {}
            Some(_) => {
                return Err(DomainError::GrantAttenuation(format!(
                    "budget expanded or negative for {key}"
                )));
            }
            None => {
                return Err(DomainError::GrantAttenuation(format!(
                    "budget omitted for {key}"
                )));
            }
        }
    }
    // A meter the parent never named is a limit no enforcer knows to apply.
    for (key, value) in child {
        if *value < 0 {
            return Err(DomainError::GrantAttenuation(format!(
                "budget negative for {key}"
            )));
        }
        if !parent.contains_key(key) {
            return Err(DomainError::GrantAttenuation(format!(
                "budget key {key} is not metered by the parent"
            )));
        }
    }
    Ok(())
}

/// Every meter the parent carries, at the requested value where the caller named
/// one and at the parent's own where it did not.
///
/// A request above the parent's ceiling is left as written so attenuation
/// refuses the mint, rather than quietly handing back a grant nobody asked for.
#[must_use]
pub fn inherit_budgets(
    parent: &BTreeMap<String, i64>,
    requested: &BTreeMap<String, i64>,
) -> BTreeMap<String, i64> {
    let mut budgets = parent.clone();
    budgets.extend(requested.iter().map(|(key, value)| (key.clone(), *value)));
    budgets
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meters(pairs: &[(&str, i64)]) -> BTreeMap<String, i64> {
        pairs
            .iter()
            .map(|(key, value)| ((*key).to_string(), *value))
            .collect()
    }

    #[test]
    fn silence_does_not_erase_a_parent_meter() {
        let parent = meters(&[("calls", 10)]);
        assert!(validate_budget_attenuation(&parent, &meters(&[])).is_err());
        assert!(validate_budget_attenuation(&parent, &meters(&[("calls", 10)])).is_ok());
    }

    #[test]
    fn inheriting_fills_the_silence_the_caller_left() {
        let parent = meters(&[("calls", 10), ("bytes", 100)]);
        let inherited = inherit_budgets(&parent, &meters(&[("calls", 3)]));
        assert_eq!(inherited, meters(&[("calls", 3), ("bytes", 100)]));
        assert!(validate_budget_attenuation(&parent, &inherited).is_ok());
    }

    #[test]
    fn an_over_ceiling_request_is_left_for_attenuation_to_refuse() {
        let parent = meters(&[("calls", 10)]);
        let inherited = inherit_budgets(&parent, &meters(&[("calls", 99)]));
        assert_eq!(inherited, meters(&[("calls", 99)]));
        assert!(validate_budget_attenuation(&parent, &inherited).is_err());
    }
}
