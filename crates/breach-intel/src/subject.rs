//! What a breach finding is about.
//!
//! Metadata only, in the same sense and for the same reason as the lifecycle
//! plane's `ExpirySubject`: a subject has no field capable of carrying a
//! value, so a subscriber structurally cannot receive a secret through the
//! breach feed. `subject_fields_carry_no_secret_shaped_names` is the fence
//! that keeps it that way.

use serde::{Deserialize, Serialize};

/// The closed set of things a breach finding can concern.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, Hash)]
#[serde(rename_all = "snake_case")]
pub enum BreachSubjectKind {
    /// A sealed-store entry whose secret was checked against the password
    /// corpus.
    StorePath,
    /// A brokered connection's credential, checked the same way.
    ConnectionCredential,
    /// A provider domain watched against the public breach catalogue.
    Domain,
    /// A corpus itself, for a finding about the scan rather than about a
    /// tenant's secrets — a source that could not be consulted is a coverage
    /// gap, and it needs a subject to be reported against.
    Source,
}

impl BreachSubjectKind {
    pub const ALL: [Self; 4] = [
        Self::StorePath,
        Self::ConnectionCredential,
        Self::Domain,
        Self::Source,
    ];

    /// Frozen wire name. Shares the lifecycle plane's vocabulary where the
    /// thing is the same thing, so one hook can filter `store_path` across
    /// both feeds and mean it.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::StorePath => "store_path",
            Self::ConnectionCredential => "connection_credential",
            Self::Domain => "domain",
            Self::Source => "breach_source",
        }
    }

    #[must_use]
    pub fn parse(raw: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|kind| kind.as_str() == raw)
    }

    /// Whether checking this kind requires opening a sealed value in memory.
    #[must_use]
    pub const fn requires_opening(self) -> bool {
        matches!(self, Self::StorePath | Self::ConnectionCredential)
    }
}

/// A thing that was checked against a breach corpus.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BreachSubject {
    pub kind: BreachSubjectKind,
    /// Stable identity within `(organization_id, kind)`. A store path, a
    /// connection id, or a domain — never a value.
    pub subject_id: String,
    pub organization_id: String,
    /// Operator-facing name. Never a credential.
    pub label: Option<String>,
}

impl BreachSubject {
    /// A subject with no separate label.
    #[must_use]
    pub fn new(
        kind: BreachSubjectKind,
        subject_id: impl Into<String>,
        organization_id: impl Into<String>,
    ) -> Self {
        Self {
            kind,
            subject_id: subject_id.into(),
            organization_id: organization_id.into(),
            label: None,
        }
    }

    /// The same subject carrying an operator-facing label.
    #[must_use]
    pub fn labelled(mut self, label: impl Into<String>) -> Self {
        self.label = Some(label.into());
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wire_names_are_frozen() {
        let names: Vec<&str> = BreachSubjectKind::ALL
            .iter()
            .map(|kind| kind.as_str())
            .collect();
        assert_eq!(
            names,
            [
                "store_path",
                "connection_credential",
                "domain",
                "breach_source"
            ],
        );
    }

    #[test]
    fn every_wire_name_round_trips() {
        for kind in BreachSubjectKind::ALL {
            assert_eq!(BreachSubjectKind::parse(kind.as_str()), Some(kind));
        }
        assert_eq!(
            BreachSubjectKind::parse("account"),
            None,
            "accounts are deliberately not a subject kind; see crate::catalogue",
        );
    }

    #[test]
    fn a_watched_domain_never_requires_opening_anything() {
        assert!(!BreachSubjectKind::Domain.requires_opening());
        assert!(!BreachSubjectKind::Source.requires_opening());
        assert!(BreachSubjectKind::StorePath.requires_opening());
        assert!(BreachSubjectKind::ConnectionCredential.requires_opening());
    }

    /// The structural fence: serializing a subject can only ever produce these
    /// four keys, so nothing value-shaped can ride along.
    #[test]
    fn subject_fields_carry_no_secret_shaped_names() {
        let subject = BreachSubject::new(BreachSubjectKind::StorePath, "Dev/token", "org-1")
            .labelled("Dev/token");
        let encoded = serde_json::to_value(&subject).unwrap();
        let keys: Vec<&String> = encoded.as_object().unwrap().keys().collect();
        assert_eq!(keys, ["kind", "label", "organization_id", "subject_id"]);
        for key in keys {
            for forbidden in ["secret", "password", "token", "key", "credential"] {
                assert!(
                    !key.contains(forbidden),
                    "subject grew a secret-shaped field: {key}",
                );
            }
        }
    }

    #[test]
    fn a_label_is_optional_and_chainable() {
        let bare = BreachSubject::new(BreachSubjectKind::Domain, "adobe.com", "org-1");
        assert_eq!(bare.label, None);
        assert_eq!(bare.labelled("Adobe").label.as_deref(), Some("Adobe"));
    }
}
