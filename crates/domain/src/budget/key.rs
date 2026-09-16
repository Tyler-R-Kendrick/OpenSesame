//! The name of a budget dimension.

use std::fmt;

use serde::{Deserialize, Serialize};

use super::BudgetError;

/// Longest key accepted.
const MAX_KEY: usize = 64;

/// One metered dimension: `invocations`, `usd`, `tokens_out`, `egress_bytes`.
///
/// Opaque and compared byte-for-byte. Validation is only enough to keep a key
/// printable and bounded — whitespace, control bytes and non-ASCII are refused
/// so a key can never be confused with another in a log line, a receipt, or a
/// persisted map.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct BudgetKey(String);

impl BudgetKey {
    /// # Errors
    ///
    /// Returns [`BudgetError::InvalidKey`] when the key is empty, longer than
    /// 64 bytes, or contains anything but printable ASCII.
    pub fn parse(raw: &str) -> Result<Self, BudgetError> {
        if raw.is_empty() || raw.len() > MAX_KEY || !raw.bytes().all(|b| b.is_ascii_graphic()) {
            return Err(BudgetError::InvalidKey(raw.to_string()));
        }
        Ok(Self(raw.to_string()))
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for BudgetKey {
    type Error = BudgetError;

    fn try_from(raw: String) -> Result<Self, Self::Error> {
        Self::parse(&raw)
    }
}

impl From<BudgetKey> for String {
    fn from(key: BudgetKey) -> Self {
        key.0
    }
}

impl fmt::Display for BudgetKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_the_keys_grants_already_use() {
        for raw in ["invocations", "calls", "usd", "tokens_out", "egress.bytes"] {
            assert!(BudgetKey::parse(raw).is_ok(), "{raw} should parse");
        }
    }

    #[test]
    fn refuses_keys_that_could_be_confused_for_another() {
        for raw in [
            "",
            " calls",
            "calls ",
            "cal ls",
            "calls\n",
            "caf\u{e9}",
            "a\0b",
        ] {
            assert!(BudgetKey::parse(raw).is_err(), "{raw:?} should be refused");
        }
        assert!(BudgetKey::parse(&"c".repeat(MAX_KEY + 1)).is_err());
    }

    #[test]
    fn deserialization_is_validated() {
        assert!(serde_json::from_str::<BudgetKey>(r#""calls""#).is_ok());
        assert!(serde_json::from_str::<BudgetKey>(r#""bad key""#).is_err());
    }
}
