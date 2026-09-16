//! Exact quantities (BUD-PRECISION).
//!
//! No budget quantity is ever a float. A [`Unit`] declares how many decimal
//! digits it records, and a [`Quantity`] is an unsigned integer count of those
//! minor units, so `0.1 + 0.2` is the same value here as anywhere and a cap of
//! `1.00` is never `0.9999999999`.
//!
//! Two consequences are deliberate:
//!
//! - Text that carries more digits than the unit records is **refused**, not
//!   rounded. Rounding a spend down loses money and rounding it up invents an
//!   overcharge; refusing makes the caller state the unit it meant.
//! - [`Quantity`] is unsigned, so a bucket can never hold a negative balance.
//!   Conservation in [`super::ledger`] then follows from the type rather than
//!   from a check somebody has to remember to run.

use std::fmt;

use serde::{Deserialize, Deserializer, Serialize, Serializer};

use super::BudgetError;

/// Most fractional digits a unit may declare. Eighteen covers everything from
/// whole call counts to wei-scale amounts while leaving `u128` headroom far
/// past any real cap.
pub const MAX_SCALE: u8 = 18;

/// Longest unit name accepted.
const MAX_UNIT_NAME: usize = 32;

/// What a budget key counts, and how finely it counts it.
///
/// The name is opaque to this module — `calls`, `usd`, `tokens`, `bytes`. Only
/// the scale has meaning: the number of decimal digits below one whole unit.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(try_from = "UnitRepr")]
pub struct Unit {
    name: String,
    scale: u8,
}

/// Deserialization goes through this so a persisted or received unit is
/// validated on the way in; a scale of 200 can never reach [`Unit`].
#[derive(Deserialize)]
struct UnitRepr {
    name: String,
    scale: u8,
}

impl TryFrom<UnitRepr> for Unit {
    type Error = BudgetError;

    fn try_from(repr: UnitRepr) -> Result<Self, Self::Error> {
        Self::new(&repr.name, repr.scale)
    }
}

impl Unit {
    /// A named unit recording `scale` decimal digits.
    ///
    /// # Errors
    ///
    /// Returns [`BudgetError::InvalidUnit`] when the name is empty, too long,
    /// not lowercase ASCII/digits/underscore, or the scale exceeds
    /// [`MAX_SCALE`].
    pub fn new(name: &str, scale: u8) -> Result<Self, BudgetError> {
        let invalid_name = name.is_empty()
            || name.len() > MAX_UNIT_NAME
            || !name
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_');
        if invalid_name {
            return Err(BudgetError::InvalidUnit(name.to_string()));
        }
        if scale > MAX_SCALE {
            return Err(BudgetError::InvalidUnit(format!(
                "{name} declares scale {scale}, over the {MAX_SCALE} digit maximum"
            )));
        }
        Ok(Self {
            name: name.to_string(),
            scale,
        })
    }

    /// The whole-number unit: one call, one invocation, one message.
    #[must_use]
    pub fn count() -> Self {
        Self {
            name: "count".to_string(),
            scale: 0,
        }
    }

    #[must_use]
    pub fn name(&self) -> &str {
        &self.name
    }

    #[must_use]
    pub const fn scale(&self) -> u8 {
        self.scale
    }

    /// Minor units in one whole unit.
    ///
    /// Cannot overflow: [`Unit::new`] caps the scale at [`MAX_SCALE`] and
    /// `10^18` is far inside `u128`.
    #[must_use]
    pub fn scale_factor(&self) -> u128 {
        10_u128.pow(u32::from(self.scale))
    }
}

impl fmt::Display for Unit {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.scale == 0 {
            write!(f, "{}", self.name)
        } else {
            write!(f, "{}(e-{})", self.name, self.scale)
        }
    }
}

/// A non-negative quantity, counted in its unit's minor units.
///
/// Serialized as a decimal **string** of minor units. A JSON number would be
/// read back by any JavaScript consumer as an `f64` and silently rounded past
/// `2^53` — exactly the loss this type exists to prevent.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Quantity(u128);

impl Quantity {
    pub const ZERO: Self = Self(0);

    #[must_use]
    pub const fn from_minor_units(units: u128) -> Self {
        Self(units)
    }

    #[must_use]
    pub const fn minor_units(self) -> u128 {
        self.0
    }

    #[must_use]
    pub const fn is_zero(self) -> bool {
        self.0 == 0
    }

    /// # Errors
    ///
    /// Returns [`BudgetError::Overflow`] rather than wrapping.
    pub fn checked_add(self, other: Self) -> Result<Self, BudgetError> {
        self.0
            .checked_add(other.0)
            .map(Self)
            .ok_or(BudgetError::Overflow)
    }

    /// # Errors
    ///
    /// Returns [`BudgetError::Underflow`] rather than wrapping: a budget
    /// balance that went negative would be authority created from nothing.
    pub fn checked_sub(self, other: Self) -> Result<Self, BudgetError> {
        self.0
            .checked_sub(other.0)
            .map(Self)
            .ok_or(BudgetError::Underflow)
    }

    /// Floors at zero. Used only where the difference is already known
    /// non-negative by invariant and the floor is documentation.
    #[must_use]
    pub const fn saturating_sub(self, other: Self) -> Self {
        Self(self.0.saturating_sub(other.0))
    }

    /// Parse an exact decimal in `unit`'s terms: `"12"`, `"0.75"`, `"1.000001"`.
    ///
    /// Leading `+`/`-`, exponents, underscores, whitespace and thousands
    /// separators are all refused, as is any value carrying more fractional
    /// digits than the unit records.
    ///
    /// # Errors
    ///
    /// Returns [`BudgetError::NotADecimal`] for anything that is not a bare
    /// unsigned decimal, [`BudgetError::Precision`] when the text is finer
    /// than the unit, and [`BudgetError::Overflow`] past `u128`.
    pub fn parse_decimal(text: &str, unit: &Unit) -> Result<Self, BudgetError> {
        let (whole, fraction) = text.split_once('.').unwrap_or((text, ""));
        let shaped = !whole.is_empty() || !fraction.is_empty();
        let digits_only = whole.bytes().all(|b| b.is_ascii_digit())
            && fraction.bytes().all(|b| b.is_ascii_digit())
            && text.matches('.').count() <= 1;
        if !shaped || !digits_only {
            return Err(BudgetError::NotADecimal(text.to_string()));
        }
        let scale = usize::from(unit.scale());
        if fraction.len() > scale {
            return Err(BudgetError::Precision {
                text: text.to_string(),
                unit: unit.name().to_string(),
                scale: unit.scale(),
            });
        }
        let mut minor = String::with_capacity(whole.len() + scale);
        minor.push_str(whole);
        minor.push_str(fraction);
        for _ in fraction.len()..scale {
            minor.push('0');
        }
        minor
            .parse::<u128>()
            .map(Self)
            .map_err(|_| BudgetError::Overflow)
    }

    /// Render in `unit`'s terms, with exactly `unit.scale()` fractional
    /// digits. Round-trips through [`Quantity::parse_decimal`] unchanged.
    #[must_use]
    pub fn to_decimal_string(self, unit: &Unit) -> String {
        let factor = unit.scale_factor();
        let whole = self.0 / factor;
        if unit.scale() == 0 {
            return whole.to_string();
        }
        let fraction = self.0 % factor;
        let width = usize::from(unit.scale());
        format!("{whole}.{fraction:0width$}")
    }
}

impl fmt::Display for Quantity {
    /// Minor units, unit-free. Use [`Quantity::to_decimal_string`] to show a
    /// person a number they would recognize.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl Serialize for Quantity {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0.to_string())
    }
}

impl<'de> Deserialize<'de> for Quantity {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(deserializer)?;
        raw.parse::<u128>()
            .map(Self)
            .map_err(serde::de::Error::custom)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn usd() -> Unit {
        Unit::new("usd", 6).expect("usd is a valid unit")
    }

    #[test]
    fn parses_and_renders_exactly() {
        let unit = usd();
        assert_eq!(
            Quantity::parse_decimal("1.000001", &unit)
                .unwrap()
                .minor_units(),
            1_000_001
        );
        assert_eq!(
            Quantity::parse_decimal("0.5", &unit).unwrap().minor_units(),
            500_000
        );
        assert_eq!(
            Quantity::from_minor_units(1_000_001).to_decimal_string(&unit),
            "1.000001"
        );
        assert_eq!(
            Quantity::from_minor_units(7).to_decimal_string(&Unit::count()),
            "7"
        );
    }

    #[test]
    fn refuses_precision_it_cannot_hold() {
        // A tenth of a cent under a cent-scale unit is not "about zero".
        let cents = Unit::new("usd", 2).unwrap();
        assert!(matches!(
            Quantity::parse_decimal("0.001", &cents),
            Err(BudgetError::Precision { .. })
        ));
        assert!(matches!(
            Quantity::parse_decimal("1.5", &Unit::count()),
            Err(BudgetError::Precision { .. })
        ));
    }

    #[test]
    fn refuses_anything_that_is_not_a_bare_decimal() {
        let unit = usd();
        for text in [
            "", ".", "-1", "+1", "1e3", "1_000", " 1", "1 ", "1.2.3", "0x10", "1,000", "NaN",
        ] {
            assert!(
                Quantity::parse_decimal(text, &unit).is_err(),
                "{text} must be refused"
            );
        }
    }

    #[test]
    fn arithmetic_fails_closed_at_both_ends() {
        let big = Quantity::from_minor_units(u128::MAX);
        assert_eq!(
            big.checked_add(Quantity::from_minor_units(1)),
            Err(BudgetError::Overflow)
        );
        assert_eq!(
            Quantity::ZERO.checked_sub(Quantity::from_minor_units(1)),
            Err(BudgetError::Underflow)
        );
    }

    #[test]
    fn serializes_as_a_string_so_large_values_survive() {
        let huge = Quantity::from_minor_units(9_007_199_254_740_993);
        let json = serde_json::to_string(&huge).unwrap();
        assert_eq!(json, "\"9007199254740993\"");
        assert_eq!(serde_json::from_str::<Quantity>(&json).unwrap(), huge);
    }

    #[test]
    fn a_unit_with_an_absurd_scale_cannot_be_deserialized() {
        assert!(Unit::new("usd", 40).is_err());
        assert!(serde_json::from_str::<Unit>(r#"{"name":"usd","scale":200}"#).is_err());
        assert!(serde_json::from_str::<Unit>(r#"{"name":"US Dollars","scale":2}"#).is_err());
    }
}
