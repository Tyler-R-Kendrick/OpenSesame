//! The delegation boundary: a chain of grants becomes one ledger (BUD-DELEGATE).
//!
//! [`crate::grant_attenuation`] answers *may this child exist?* and this module
//! answers *what may it actually spend?* Both refuse to let a budget widen, and
//! they do it by opposite means. That is deliberate, and worth being precise
//! about, because the two rules read as if they contradict each other:
//!
//! - The **grant layer refuses omission.** A child whose `budgets` map drops a
//!   key its parent metered fails `validate_constraint_attenuation` outright.
//!   A grant is a document a person or a service signed, and one that silently
//!   stops mentioning a limit is not a narrower document — it is an ambiguous
//!   one, so the child is made to restate the limit it is accepting.
//!
//! - The **ledger layer binds omission.** [`Limits::inherit`], and therefore
//!   [`effective_chain_limits`], starts from the parent's whole map and lets the
//!   child replace entries only with narrower ones. A key nobody restated keeps
//!   the parent's cap.
//!
//! Neither is redundant. The grant check is a validation gate that some caller
//! has to remember to run; the inheritance rule is what the enforcement path
//! computes even when nobody ran it. Both fail closed, so the two possible
//! answers for an omitted key are "this chain is invalid" and "this chain is
//! metered at the parent's cap" — and never "this dimension is unmetered",
//! which is what a loop over the child's own keys would produce.
//!
//! The tests at the bottom hold that correspondence in place: for every case,
//! whatever the grant layer decides, the ledger layer never ends up wider than
//! the parent.

use chrono::{DateTime, Utc};

use super::{limits_from_grant_budgets, BudgetError, BudgetLedger, Limits, WindowSpec};
use crate::GrantConstraints;

/// The limits in force at the end of a delegation chain, **root first**.
///
/// An empty chain is unmetered: there is no root, so there is no authority to
/// meter. A chain of one is that grant's own budgets.
///
/// # Errors
///
/// Returns [`BudgetError::UnknownKey`] when a link invents a dimension its
/// parent never metered, [`BudgetError::WidenForbidden`] when one raises a cap or
/// outpaces a period, or the conversion refusals from
/// [`limits_from_grant_budgets`] for a malformed map.
pub fn effective_chain_limits(
    root_first: &[&GrantConstraints],
    window: WindowSpec,
) -> Result<Limits, BudgetError> {
    let mut links = root_first.iter();
    let Some(root) = links.next() else {
        return Ok(Limits::unmetered());
    };
    let mut effective = limits_from_grant_budgets(&root.budgets, window)?;
    for link in links {
        let stated = limits_from_grant_budgets(&link.budgets, window)?;
        effective = Limits::inherit(&effective, &stated)?;
    }
    Ok(effective)
}

/// A ledger metering the leaf of a delegation chain.
///
/// The ledger is the leaf's, but its capacity is the root's: every link only
/// ever narrowed it, so nothing spent here can exceed what the root allowed.
///
/// # Errors
///
/// As [`effective_chain_limits`].
pub fn ledger_for_chain(
    root_first: &[&GrantConstraints],
    window: WindowSpec,
    opened_at: DateTime<Utc>,
) -> Result<BudgetLedger, BudgetError> {
    Ok(BudgetLedger::new(
        effective_chain_limits(root_first, window)?,
        opened_at,
    ))
}

#[cfg(test)]
mod tests {
    use chrono::{Duration, Utc};

    use super::*;
    use crate::budget::fixtures::{at, key};
    use crate::budget::{Amount, Quantity, ReservationId, SpendRequest};
    use crate::grant_attenuation::validate_constraint_attenuation;
    use crate::OfflineUse;

    fn constraints(budgets: &[(&str, i64)]) -> GrantConstraints {
        let now = Utc::now();
        GrantConstraints {
            audiences: vec!["host".to_string()],
            not_before: Some(now),
            expires_at: now + Duration::hours(1),
            required_assurance: Some("mfa".to_string()),
            authentication_max_age_seconds: Some(600),
            allowed_networks: vec![],
            parameter_rules_digest: None,
            budgets: budgets
                .iter()
                .map(|(key, cap)| ((*key).to_string(), *cap))
                .collect(),
            maximum_delegation_depth: 2,
            offline_use: OfflineUse::Forbidden,
            raw_credential_export: false,
        }
    }

    fn cap_of(limits: &Limits, raw: &str) -> Option<u128> {
        limits.get(&key(raw)).map(|limit| limit.cap().minor_units())
    }

    #[test]
    fn a_child_that_omits_a_key_is_refused_by_the_grant_layer() {
        let parent = constraints(&[("calls", 10)]);
        let silent = constraints(&[]);
        // Point 4: this is already the grant layer's answer, and it stays that way.
        assert!(validate_constraint_attenuation(&parent, &silent).is_err());
    }

    #[test]
    fn but_the_ledger_layer_still_meters_that_child_at_the_parents_cap() {
        let parent = constraints(&[("calls", 10)]);
        let silent = constraints(&[]);
        let effective = effective_chain_limits(&[&parent, &silent], WindowSpec::Lifetime).unwrap();
        assert_eq!(
            cap_of(&effective, "calls"),
            Some(10),
            "silence inherits the limit; it never removes it"
        );
    }

    #[test]
    fn the_two_layers_never_disagree_in_the_direction_that_matters() {
        let parent = constraints(&[("calls", 10), ("usd", 5)]);
        for child in [
            constraints(&[]),                          // omits both
            constraints(&[("calls", 10), ("usd", 5)]), // restates both
            constraints(&[("calls", 4), ("usd", 5)]),  // narrows one
            constraints(&[("calls", 0), ("usd", 0)]),  // narrows to nothing
        ] {
            let effective =
                effective_chain_limits(&[&parent, &child], WindowSpec::Lifetime).unwrap();
            let parent_limits =
                limits_from_grant_budgets(&parent.budgets, WindowSpec::Lifetime).unwrap();
            for (name, limit) in parent_limits.iter() {
                let effective_cap = effective
                    .get(name)
                    .expect("no parent dimension may disappear")
                    .cap();
                assert!(
                    effective_cap <= limit.cap(),
                    "{name} widened from {} to {effective_cap}",
                    limit.cap()
                );
            }
            // Whatever the grant layer decided, the ledger layer is no wider.
            let _ = validate_constraint_attenuation(&parent, &child);
        }
    }

    #[test]
    fn both_layers_refuse_a_raised_cap_and_an_invented_dimension() {
        let parent = constraints(&[("calls", 10)]);

        let raised = constraints(&[("calls", 11)]);
        assert!(validate_constraint_attenuation(&parent, &raised).is_err());
        assert!(matches!(
            effective_chain_limits(&[&parent, &raised], WindowSpec::Lifetime),
            Err(BudgetError::WidenForbidden { .. })
        ));

        let invented = constraints(&[("calls", 5), ("tokens", 1)]);
        assert!(validate_constraint_attenuation(&parent, &invented).is_err());
        assert!(matches!(
            effective_chain_limits(&[&parent, &invented], WindowSpec::Lifetime),
            Err(BudgetError::UnknownKey(_))
        ));
    }

    #[test]
    fn a_long_chain_of_quiet_links_still_ends_at_the_root_cap() {
        let root = constraints(&[("calls", 10)]);
        let quiet = constraints(&[]);
        let narrowing = constraints(&[("calls", 3)]);
        let effective =
            effective_chain_limits(&[&root, &quiet, &narrowing, &quiet], WindowSpec::Lifetime)
                .unwrap();
        assert_eq!(
            cap_of(&effective, "calls"),
            Some(3),
            "the narrowest link in the chain wins, and quiet links do not undo it"
        );
    }

    #[test]
    fn an_empty_chain_meters_nothing_because_it_authorizes_nothing() {
        let effective = effective_chain_limits(&[], WindowSpec::Lifetime).unwrap();
        assert!(effective.is_empty());
    }

    #[test]
    fn a_leaf_ledger_cannot_outspend_the_root() {
        let root = constraints(&[("calls", 10)]);
        let leaf = constraints(&[("calls", 2)]);
        let mut ledger = ledger_for_chain(&[&root, &leaf], WindowSpec::Lifetime, at(0)).unwrap();
        let request = SpendRequest::new(ReservationId::parse("run-1").unwrap(), 60)
            .unwrap()
            .spending(key("calls"), Amount::count(3))
            .unwrap();
        assert!(
            matches!(
                ledger.reserve(&request, at(0)),
                Err(BudgetError::LimitExceeded { .. })
            ),
            "the leaf's own narrower cap binds, not the root's"
        );
        let within = SpendRequest::new(ReservationId::parse("run-2").unwrap(), 60)
            .unwrap()
            .spending(key("calls"), Amount::count(2))
            .unwrap();
        ledger.reserve(&within, at(0)).unwrap();
        ledger.settle_in_full(within.id(), at(1)).unwrap();
        ledger.assert_conserved().unwrap();
        assert_eq!(
            ledger.reading(&key("calls"), at(1)).unwrap().available(),
            Quantity::ZERO
        );
    }

    #[test]
    fn a_negative_count_in_a_grant_is_malformed_not_generous() {
        let parent = constraints(&[("calls", -1)]);
        assert!(matches!(
            effective_chain_limits(&[&parent], WindowSpec::Lifetime),
            Err(BudgetError::InvalidLimit { .. })
        ));
    }

    #[test]
    fn a_recurring_window_applies_to_every_link_alike() {
        let root = constraints(&[("calls", 10)]);
        let leaf = constraints(&[("calls", 4)]);
        let hourly = WindowSpec::periodic(3_600).unwrap();
        let effective = effective_chain_limits(&[&root, &leaf], hourly).unwrap();
        let limit = effective.get(&key("calls")).expect("metered");
        assert_eq!(limit.cap(), Quantity::from_minor_units(4));
        assert_eq!(limit.window(), hourly);
        // Sanity: the same map read as lifetime limits gives the same caps.
        let once = effective_chain_limits(&[&root, &leaf], WindowSpec::Lifetime).unwrap();
        assert_eq!(cap_of(&once, "calls"), cap_of(&effective, "calls"));
    }
}
