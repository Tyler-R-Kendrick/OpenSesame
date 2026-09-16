//! The identifiers a unit and a client are named by.
//!
//! Both character sets are tighter than they strictly need to be, for one reason:
//! these strings become Blocky group names, list filenames, and YAML config keys.
//! Refusing an awkward character once here is better than escaping it three
//! different ways downstream and getting one of them wrong.

use std::fmt;

use serde::{Deserialize, Serialize};

use super::DEFAULT_CLIENT_KEY;

/// Why an identifier is not usable.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum IdError {
    /// The identifier was empty.
    #[error("an identifier cannot be empty")]
    Empty,
    /// The identifier held a character that would not survive being written into
    /// a group name, a file path, or a config key.
    #[error("`{character}` cannot appear in an identifier")]
    BadCharacter {
        /// The offending character.
        character: char,
    },
    /// The identifier collided with Blocky's reserved fallback key.
    #[error("`default` is Blocky's reserved fallback key")]
    Reserved,
}

/// One enforcement unit's identity.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct UnitId(String);

impl UnitId {
    /// Parse a unit identifier.
    ///
    /// # Errors
    ///
    /// Returns [`IdError`] when the identifier is empty, reserved, or holds
    /// anything outside `[a-z0-9-]`.
    pub fn parse(raw: &str) -> Result<Self, IdError> {
        let name = raw.trim().to_ascii_lowercase();
        if name.is_empty() {
            return Err(IdError::Empty);
        }
        if name == DEFAULT_CLIENT_KEY {
            return Err(IdError::Reserved);
        }
        if let Some(bad) = name
            .chars()
            .find(|c| !c.is_ascii_alphanumeric() && *c != '-')
        {
            return Err(IdError::BadCharacter { character: bad });
        }
        Ok(Self(name))
    }

    /// The identifier itself.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// The Blocky list-group name carrying this unit's denylist and allowlist.
    ///
    /// One name serves both maps: Blocky keys `denylists` and `allowlists` by the
    /// same group name, and `clientGroupsBlock` refers to that one name.
    #[must_use]
    pub fn group_name(&self) -> String {
        format!("unit-{}", self.0)
    }
}

/// A client as Blocky identifies one: an address, a CIDR block, or a name.
///
/// This crate does not interpret the form. Blocky matches on all three, and a
/// caller that knows it is addressing a subnet knows better than a parser here
/// would.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct ClientId(String);

impl ClientId {
    /// Parse a client identifier.
    ///
    /// # Errors
    ///
    /// Returns [`IdError`] when the identifier is empty, reserved, or holds
    /// whitespace — Blocky's `clientGroupsBlock` keys are not quoted, and a key
    /// with a space in it silently matches nothing.
    pub fn parse(raw: &str) -> Result<Self, IdError> {
        let name = raw.trim().to_ascii_lowercase();
        if name.is_empty() {
            return Err(IdError::Empty);
        }
        if name == DEFAULT_CLIENT_KEY {
            return Err(IdError::Reserved);
        }
        if let Some(bad) = name.chars().find(char::is_ascii_whitespace) {
            return Err(IdError::BadCharacter { character: bad });
        }
        Ok(Self(name))
    }

    /// The identifier itself.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for UnitId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl fmt::Display for ClientId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl TryFrom<String> for UnitId {
    type Error = IdError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::parse(&value)
    }
}

impl From<UnitId> for String {
    fn from(value: UnitId) -> Self {
        value.0
    }
}

impl TryFrom<String> for ClientId {
    type Error = IdError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::parse(&value)
    }
}

impl From<ClientId> for String {
    fn from(value: ClientId) -> Self {
        value.0
    }
}

#[cfg(test)]
mod tests {
    use super::{ClientId, IdError, UnitId};

    #[test]
    fn identifiers_refuse_what_would_need_escaping_downstream() {
        assert_eq!(UnitId::parse(""), Err(IdError::Empty));
        assert_eq!(UnitId::parse("default"), Err(IdError::Reserved));
        assert_eq!(
            UnitId::parse("unit/../etc"),
            Err(IdError::BadCharacter { character: '/' })
        );
        assert!(matches!(
            ClientId::parse("has space"),
            Err(IdError::BadCharacter { character: ' ' })
        ));
    }

    #[test]
    fn a_unit_names_one_group_serving_both_of_its_lists() {
        let unit = UnitId::parse("Alpha").expect("unit id");
        assert_eq!(unit.as_str(), "alpha");
        assert_eq!(unit.group_name(), "unit-alpha");
    }

    #[test]
    fn a_client_identifier_keeps_the_form_blocky_matches_on() {
        // Addresses, CIDR blocks and names are all legitimate here.
        for raw in ["127.0.0.1", "10.0.0.0/8", "laptop"] {
            assert_eq!(ClientId::parse(raw).expect("client id").as_str(), raw);
        }
    }
}
