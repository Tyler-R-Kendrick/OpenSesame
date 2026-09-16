//! What a bucket reads (BUD-METER).
//!
//! Two types, both of which exist to stop a number from travelling without the
//! unit that gives it meaning.
//!
//! [`Amount`] is a [`Quantity`] carrying its [`Unit`]. A bare quantity is a
//! count of minor units and nothing more, so `500` against a cap of `5.00` is
//! either five dollars or half a cent depending on a scale the callee cannot
//! see. Requiring the unit at the boundary turns that into a
//! [`BudgetError::UnitMismatch`] instead of a hundredfold spend.
//!
//! [`MeterReading`] is an immutable snapshot of one `(key, window)` bucket:
//! cap, spent, held, and the availability that follows from them. It is what a
//! receipt quotes, what a UI renders, and what a caller consults to size a
//! request before making one — a dry run that cannot mutate anything because it
//! holds no ledger.
//!
//! Committed, held and available are deliberately three facts rather than one.
//! A caller that sees only "spent" will oversubscribe a budget whose remaining
//! capacity is already promised to a hold somebody else is about to settle.

use serde::{Deserialize, Serialize};

use super::{BudgetError, BudgetKey, Quantity, Unit, WindowId};

/// A quantity together with the unit it was measured in.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Amount {
    quantity: Quantity,
    unit: Unit,
}

impl Amount {
    #[must_use]
    pub const fn new(quantity: Quantity, unit: Unit) -> Self {
        Self { quantity, unit }
    }

    /// An amount from exact decimal text, in `unit`'s terms.
    ///
    /// # Errors
    ///
    /// Propagates [`Quantity::parse_decimal`]: non-decimal text, precision
    /// finer than the unit records, or overflow.
    pub fn parse(text: &str, unit: Unit) -> Result<Self, BudgetError> {
        let quantity = Quantity::parse_decimal(text, &unit)?;
        Ok(Self { quantity, unit })
    }

    /// A whole-unit count: invocations, messages, calls.
    #[must_use]
    pub fn count(units: u128) -> Self {
        Self {
            quantity: Quantity::from_minor_units(units),
            unit: Unit::count(),
        }
    }

    #[must_use]
    pub const fn quantity(&self) -> Quantity {
        self.quantity
    }

    #[must_use]
    pub const fn unit(&self) -> &Unit {
        &self.unit
    }

    #[must_use]
    pub const fn is_zero(&self) -> bool {
        self.quantity.is_zero()
    }

    /// The quantity, but only if this amount is denominated in `expected`.
    ///
    /// Every path that moves an amount into a bucket goes through here, so a
    /// redenominated spend is refused at the boundary rather than recorded at
    /// the wrong scale.
    ///
    /// # Errors
    ///
    /// Returns [`BudgetError::UnitMismatch`] when the units differ.
    pub fn quantity_in(&self, expected: &Unit, key: &BudgetKey) -> Result<Quantity, BudgetError> {
        if &self.unit != expected {
            return Err(BudgetError::UnitMismatch {
                key: key.to_string(),
                expected: expected.to_string(),
                actual: self.unit.to_string(),
            });
        }
        Ok(self.quantity)
    }

    /// Human-facing rendering: `"1.500000 usd"`, `"7 count"`.
    #[must_use]
    pub fn to_display_string(&self) -> String {
        format!(
            "{} {}",
            self.quantity.to_decimal_string(&self.unit),
            self.unit.name()
        )
    }
}

/// One `(key, window)` bucket, as it stands at a single instant.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MeterReading {
    key: BudgetKey,
    unit: Unit,
    window: WindowId,
    cap: Quantity,
    spent: Quantity,
    held: Quantity,
}

impl MeterReading {
    #[must_use]
    pub const fn new(
        key: BudgetKey,
        unit: Unit,
        window: WindowId,
        cap: Quantity,
        spent: Quantity,
        held: Quantity,
    ) -> Self {
        Self {
            key,
            unit,
            window,
            cap,
            spent,
            held,
        }
    }

    #[must_use]
    pub const fn key(&self) -> &BudgetKey {
        &self.key
    }

    #[must_use]
    pub const fn unit(&self) -> &Unit {
        &self.unit
    }

    #[must_use]
    pub const fn window(&self) -> WindowId {
        self.window
    }

    #[must_use]
    pub const fn cap(&self) -> Quantity {
        self.cap
    }

    /// Quantity already settled in this window.
    #[must_use]
    pub const fn spent(&self) -> Quantity {
        self.spent
    }

    /// Quantity promised to open reservations: not spent, and not available.
    #[must_use]
    pub const fn held(&self) -> Quantity {
        self.held
    }

    /// `spent + held`. Saturating rather than fallible: the ledger admits a
    /// commitment only after checking it against the cap, so a sum past `u128`
    /// is unreachable, and a reading is the wrong place to raise an error a
    /// caller cannot act on.
    #[must_use]
    pub fn committed(&self) -> Quantity {
        Quantity::from_minor_units(
            self.spent
                .minor_units()
                .saturating_add(self.held.minor_units()),
        )
    }

    /// What a new reservation could still take.
    #[must_use]
    pub fn available(&self) -> Quantity {
        self.cap.saturating_sub(self.committed())
    }

    #[must_use]
    pub fn is_exhausted(&self) -> bool {
        self.available().is_zero()
    }

    /// Whether a request for `wanted` would fit right now.
    #[must_use]
    pub fn admits(&self, wanted: Quantity) -> bool {
        wanted <= self.available()
    }

    /// Availability as an [`Amount`], for a receipt or a notice.
    #[must_use]
    pub fn available_amount(&self) -> Amount {
        Amount::new(self.available(), self.unit.clone())
    }

    /// Proportion of the cap already committed, in basis points (0..=10_000).
    ///
    /// A cap of zero reads as fully used, because nothing is available under it.
    #[must_use]
    pub fn used_basis_points(&self) -> u32 {
        let cap = self.cap.minor_units();
        if cap == 0 {
            return 10_000;
        }
        let committed = self.committed().minor_units().min(cap);
        // cap > 0 and committed <= cap, so the ratio lands inside 0..=10_000 and
        // the narrowing cannot truncate.
        u32::try_from(committed.saturating_mul(10_000) / cap).unwrap_or(10_000)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key() -> BudgetKey {
        BudgetKey::parse("usd").expect("test key")
    }

    fn usd() -> Unit {
        Unit::new("usd", 6).expect("valid unit")
    }

    fn reading(cap: u128, spent: u128, held: u128) -> MeterReading {
        MeterReading::new(
            key(),
            usd(),
            WindowId::Lifetime,
            Quantity::from_minor_units(cap),
            Quantity::from_minor_units(spent),
            Quantity::from_minor_units(held),
        )
    }

    #[test]
    fn an_amount_in_the_wrong_unit_is_refused_not_rescaled() {
        let cents = Amount::new(
            Quantity::from_minor_units(500),
            Unit::new("usd", 2).unwrap(),
        );
        // 500 cents is five dollars; under a six-digit unit the same integer is
        // half a cent. Neither reading may be guessed at.
        assert!(matches!(
            cents.quantity_in(&usd(), &key()),
            Err(BudgetError::UnitMismatch { .. })
        ));
        let dollars = Amount::parse("5.00", usd()).unwrap();
        assert_eq!(
            dollars.quantity_in(&usd(), &key()).unwrap(),
            Quantity::from_minor_units(5_000_000)
        );
    }

    #[test]
    fn amounts_render_with_their_unit() {
        assert_eq!(
            Amount::parse("1.5", usd()).unwrap().to_display_string(),
            "1.500000 usd"
        );
        assert_eq!(Amount::count(7).to_display_string(), "7 count");
        assert!(Amount::count(0).is_zero());
    }

    #[test]
    fn availability_counts_holds_against_the_cap() {
        let r = reading(10, 3, 2);
        assert_eq!(r.committed(), Quantity::from_minor_units(5));
        assert_eq!(r.available(), Quantity::from_minor_units(5));
        assert!(r.admits(Quantity::from_minor_units(5)));
        assert!(
            !r.admits(Quantity::from_minor_units(6)),
            "a held amount is not available to a second spender"
        );
        assert!(!r.is_exhausted());
    }

    #[test]
    fn a_fully_committed_bucket_admits_only_zero() {
        let r = reading(10, 4, 6);
        assert!(r.is_exhausted());
        assert!(r.admits(Quantity::ZERO));
        assert!(!r.admits(Quantity::from_minor_units(1)));
        assert_eq!(r.used_basis_points(), 10_000);
    }

    #[test]
    fn a_zero_cap_is_never_spendable() {
        let r = reading(0, 0, 0);
        assert!(r.is_exhausted());
        assert_eq!(r.used_basis_points(), 10_000);
        assert!(!r.admits(Quantity::from_minor_units(1)));
    }

    #[test]
    fn usage_proportion_is_exact_at_the_edges() {
        assert_eq!(reading(10, 0, 0).used_basis_points(), 0);
        assert_eq!(reading(10, 1, 0).used_basis_points(), 1_000);
        assert_eq!(reading(3, 1, 0).used_basis_points(), 3_333);
        assert_eq!(reading(10, 10, 0).used_basis_points(), 10_000);
    }
}
