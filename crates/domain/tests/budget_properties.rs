//! Generative properties for the budget primitives.
//!
//! The hand-written tests check the cases a human thought of. These let
//! proptest pick the parent/child pairs, the window boundaries and the decimal
//! scales instead, which is where budget bugs actually live: the instant a
//! window rolls, the digit past the unit's precision, the child that narrows
//! one key of four.

use std::collections::BTreeMap;

use chrono::{Duration, TimeZone, Utc};
use opensesame_domain::budget::{
    effective_grant_budgets, BudgetError, BudgetKey, Limit, Limits, Quantity, Unit, WindowSpec,
};
use proptest::prelude::*;

const KEYS: [&str; 4] = ["calls", "usd", "tokens", "egress_bytes"];

fn key(raw: &str) -> BudgetKey {
    BudgetKey::parse(raw).expect("fixture key")
}

fn unit_strategy() -> impl Strategy<Value = Unit> {
    (
        prop::sample::select(vec!["count", "usd", "tokens"]),
        0u8..=6,
    )
        .prop_map(|(name, scale)| Unit::new(name, scale).expect("fixture unit"))
}

fn window_strategy() -> impl Strategy<Value = WindowSpec> {
    prop_oneof![
        Just(WindowSpec::Lifetime),
        (1u32..=1_000_000).prop_map(|period| WindowSpec::periodic(period).expect("fixture period")),
    ]
}

fn limit_strategy() -> impl Strategy<Value = Limit> {
    (
        0u128..=1_000_000_000_000,
        unit_strategy(),
        window_strategy(),
    )
        .prop_map(|(cap, unit, window)| Limit::new(Quantity::from_minor_units(cap), unit, window))
}

fn limits_strategy() -> impl Strategy<Value = Limits> {
    prop::collection::btree_map(
        prop::sample::select(KEYS.to_vec()).prop_map(key),
        limit_strategy(),
        0..5,
    )
    .prop_map(Limits::new)
}

/// `(key index, divisor)` pairs describing how a child narrows its parent.
///
/// Named rather than inlined so the value type is stated once: proptest's `in`
/// bindings and the slice coercion in [`narrowed`] otherwise leave the element
/// type ambiguous.
fn picks_strategy() -> impl Strategy<Value = Vec<(usize, u8)>> {
    prop::collection::vec((0usize..8, 0u8..8), 0..6)
}

/// A child built to narrow `parent`: same unit, same window, cap divided down.
/// Anything this produces must be accepted, which is what makes the "narrowing
/// is always allowed" direction testable separately from the refusals.
fn narrowed(parent: &Limits, picks: &[(usize, u8)]) -> Limits {
    let keys: Vec<BudgetKey> = parent.keys().cloned().collect();
    if keys.is_empty() {
        return Limits::unmetered();
    }
    let mut entries = BTreeMap::new();
    for (index, divisor) in picks {
        let chosen = &keys[index % keys.len()];
        let limit = parent.get(chosen).expect("key came from the parent");
        let divisor = u128::from(*divisor).max(1);
        entries.insert(
            chosen.clone(),
            Limit::new(
                Quantity::from_minor_units(limit.cap().minor_units() / divisor),
                limit.unit().clone(),
                limit.window(),
            ),
        );
    }
    Limits::new(entries)
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(256))]

    // ---- BUD-DELEGATE ----

    /// The headline invariant: a child that states nothing is bound by
    /// everything its parent was bound by. Not "unmetered", not "missing".
    #[test]
    fn a_silent_child_is_bound_by_exactly_the_parents_limits(parent in limits_strategy()) {
        let effective = Limits::inherit(&parent, &Limits::unmetered())
            .expect("omitting every key can never widen anything");
        prop_assert_eq!(effective, parent);
    }

    /// Whatever a child narrows, the key set never shrinks and no cap ever
    /// rises. A dimension cannot be dropped by restating a subset.
    #[test]
    fn inheritance_never_widens_and_never_loses_a_key(
        parent in limits_strategy(),
        picks in picks_strategy(),
    ) {
        let child = narrowed(&parent, &picks);
        let effective = Limits::inherit(&parent, &child)
            .expect("a cap divided down, at the same unit and window, narrows");
        prop_assert_eq!(effective.len(), parent.len());
        for (key, limit) in effective.iter() {
            let ceiling = parent.get(key).expect("no key may appear from nowhere");
            prop_assert!(limit.cap() <= ceiling.cap());
            prop_assert_eq!(limit.unit(), ceiling.unit());
        }
    }

    /// Applying the same narrowing twice changes nothing the second time.
    #[test]
    fn inheritance_is_idempotent(
        parent in limits_strategy(),
        picks in picks_strategy(),
    ) {
        let child = narrowed(&parent, &picks);
        let once = Limits::inherit(&parent, &child).expect("narrowing is accepted");
        let twice = Limits::inherit(&once, &child).expect("the same narrowing still narrows");
        prop_assert_eq!(once, twice);
    }

    /// Down a whole chain, no descendant can end up above the root — however
    /// many quiet hops it takes to get there.
    #[test]
    fn no_descendant_outranks_the_root(
        root in limits_strategy(),
        generations in prop::collection::vec(picks_strategy(), 0..5),
    ) {
        let mut effective = root.clone();
        for picks in &generations {
            let child = narrowed(&effective, picks);
            effective = Limits::inherit(&effective, &child).expect("each hop narrows");
        }
        prop_assert_eq!(effective.len(), root.len());
        for (key, limit) in effective.iter() {
            prop_assert!(limit.cap() <= root.get(key).expect("root metered it").cap());
        }
    }

    /// Any cap above the parent's is refused, at any key, by any margin.
    #[test]
    fn a_raised_cap_is_always_refused(
        parent in limits_strategy(),
        index in 0usize..8,
        excess in 1u128..1_000,
    ) {
        prop_assume!(!parent.is_empty());
        let keys: Vec<BudgetKey> = parent.keys().cloned().collect();
        let chosen = keys[index % keys.len()].clone();
        let limit = parent.get(&chosen).expect("key came from the parent");
        let raised = Limits::new(
            [(
                chosen,
                Limit::new(
                    Quantity::from_minor_units(limit.cap().minor_units() + excess),
                    limit.unit().clone(),
                    limit.window(),
                ),
            )]
            .into_iter()
            .collect(),
        );
        let refused = matches!(
            Limits::inherit(&parent, &raised),
            Err(BudgetError::WidenForbidden { .. })
        );
        prop_assert!(refused, "a cap above the parent's must be refused");
    }

    /// The same rule in the shape grants already store budgets in.
    #[test]
    fn a_quiet_child_grant_keeps_every_parent_budget(
        parent in prop::collection::btree_map(
            prop::sample::select(KEYS.to_vec()).prop_map(str::to_string),
            0i64..1_000_000,
            0..5,
        ),
    ) {
        let effective = effective_grant_budgets(&parent, &BTreeMap::new())
            .expect("a child that states nothing cannot widen");
        prop_assert_eq!(effective, parent);
    }

    // ---- BUD-TIME ----

    /// A window contains the instant that named it, ends strictly after it,
    /// and hands the boundary itself to the next window. That is what makes
    /// the windows a partition rather than a set of overlapping guesses.
    #[test]
    fn windows_partition_time(
        seconds in -4_000_000_000i64..4_000_000_000,
        period in 1u32..=1_000_000,
    ) {
        let spec = WindowSpec::periodic(period).expect("valid period");
        let at = Utc.timestamp_opt(seconds, 0).single().expect("valid instant");
        let window = spec.window_at(at);
        let end = window.ends_at().expect("a periodic window ends");
        prop_assert!(end > at, "a window must outlast the instant inside it");
        prop_assert_ne!(spec.window_at(end), window, "the boundary starts the next one");
        prop_assert_eq!(
            spec.window_at(end - Duration::seconds(1)),
            window,
            "the last second before the boundary is still this window"
        );
    }

    /// Alignment is a function of the instant alone. Two ledgers that never
    /// spoke agree on every boundary, and a restart cannot mint a fresh
    /// allowance by starting its own clock.
    #[test]
    fn window_identity_depends_only_on_the_instant(
        seconds in -4_000_000_000i64..4_000_000_000,
        period in 1u32..=1_000_000,
        offset in 0i64..1_000_000,
    ) {
        let spec = WindowSpec::periodic(period).expect("valid period");
        let at = Utc.timestamp_opt(seconds, 0).single().expect("valid instant");
        let later = at + Duration::seconds(offset);
        let same_window = spec.window_at(at) == spec.window_at(later);
        let within = offset < i64::from(period)
            && spec.window_at(at).ends_at().is_some_and(|end| later < end);
        prop_assert_eq!(same_window, within);
    }

    // ---- BUD-PRECISION ----

    /// Rendering and re-reading a quantity is lossless at every scale.
    #[test]
    fn decimal_text_round_trips_exactly(
        units in 0u128..=u128::from(u64::MAX),
        scale in 0u8..=18,
    ) {
        let unit = Unit::new("usd", scale).expect("valid scale");
        let quantity = Quantity::from_minor_units(units);
        let text = quantity.to_decimal_string(&unit);
        prop_assert_eq!(
            Quantity::parse_decimal(&text, &unit).expect("its own rendering must parse"),
            quantity
        );
    }

    /// One digit finer than the unit records is refused rather than rounded.
    /// Rounding down loses the spend; rounding up invents one.
    #[test]
    fn a_digit_past_the_unit_is_refused_not_rounded(
        units in 0u128..1_000_000,
        scale in 0u8..=17,
    ) {
        let unit = Unit::new("usd", scale).expect("valid scale");
        let finer = Unit::new("usd", scale + 1).expect("valid scale");
        let text = Quantity::from_minor_units(units * 10 + 7).to_decimal_string(&finer);
        let refused = matches!(
            Quantity::parse_decimal(&text, &unit),
            Err(BudgetError::Precision { .. })
        );
        prop_assert!(refused, "{text} is finer than the unit and must be refused");
    }

    /// Arithmetic is exact or it refuses. It never wraps, and it never
    /// saturates silently into a number nobody authorized.
    #[test]
    fn addition_is_exact_or_refused(a in any::<u128>(), b in any::<u128>()) {
        let sum = Quantity::from_minor_units(a).checked_add(Quantity::from_minor_units(b));
        match a.checked_add(b) {
            Some(expected) => {
                prop_assert_eq!(sum.expect("in range").minor_units(), expected);
            }
            None => prop_assert_eq!(sum, Err(BudgetError::Overflow)),
        }
    }

    /// Serialization survives values past an f64's 53 bits of integer
    /// precision — the loss a JSON number would take silently.
    #[test]
    fn serialization_is_lossless_past_f64(units in any::<u128>()) {
        let quantity = Quantity::from_minor_units(units);
        let json = serde_json::to_string(&quantity).expect("serializes");
        prop_assert_eq!(
            serde_json::from_str::<Quantity>(&json).expect("round trips"),
            quantity
        );
    }
}
