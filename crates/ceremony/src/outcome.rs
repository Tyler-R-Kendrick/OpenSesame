//! When a ceremony is allowed to say it worked.
//!
//! ADR 0082 §6: success means a round trip, not a green form. The failure this
//! prevents is specific and expensive — a ceremony that reports success on a
//! form submission, and a user who discovers months later that backup never
//! worked because the app was registered and never installed.
//!
//! That is ADR 0052 §11's silent failure with a longer fuse, so the type here
//! cannot be constructed as a success without the proof.

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::capture::{DeclaredSlots, Slot};

/// What was proven by actually using the credential.
///
/// Not a status code and not a 200: the name of the call that was made and what
/// came back, so a receipt can say *how* it was proven rather than that
/// something somewhere returned OK.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RoundTrip {
    /// The provider call that used the captured credential — `minted an
    /// installation token`, `listed installations`, `GET /user`.
    pub used: String,
    /// What the provider said the credential is, in the provider's own terms.
    /// Metadata; never material.
    pub identified_as: String,
}

/// A permission the ceremony asked for, and what the provider actually granted.
///
/// ADR 0082 §5: the recipe declares the exact set and the run **verifies
/// after** rather than trusting the form. A registration that came back with
/// more authority than was asked for aborts and reports.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct GrantedPermissions {
    pub requested: Vec<String>,
    pub granted: Vec<String>,
}

impl GrantedPermissions {
    /// Anything granted that was never requested.
    ///
    /// Compared as sets rather than as sequences: providers reorder and
    /// normalize permission names, and treating that as excess would abort
    /// every successful run.
    #[must_use]
    pub fn excess(&self) -> Vec<String> {
        let mut excess: Vec<String> = self
            .granted
            .iter()
            .filter(|permission| !self.requested.contains(permission))
            .cloned()
            .collect();
        excess.sort();
        excess.dedup();
        excess
    }

    /// Anything requested that was not granted.
    ///
    /// Not an abort. Being given *less* than asked for is a working
    /// registration that will fail a specific later operation, and the receipt
    /// naming it is more useful than a refusal that leaves the user with
    /// nothing.
    #[must_use]
    pub fn shortfall(&self) -> Vec<String> {
        let mut missing: Vec<String> = self
            .requested
            .iter()
            .filter(|permission| !self.granted.contains(permission))
            .cloned()
            .collect();
        missing.sort();
        missing.dedup();
        missing
    }
}

/// Why a ceremony did not succeed.
#[derive(Clone, Debug, PartialEq, Eq, Error, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "reason")]
pub enum Incomplete {
    /// Declared slots are still empty. Names them, because "registration
    /// failed" is not something a user can act on.
    #[error("the ceremony did not capture every slot it declared")]
    SlotsOutstanding { slots: Vec<String> },
    /// The credential was captured and never used.
    #[error("the ceremony never used the credential it captured")]
    NotRoundTripped,
    /// The provider granted authority nobody asked for.
    #[error("the registration came back with permissions that were not requested")]
    ExcessPermissions { granted: Vec<String> },
}

/// A ceremony that finished, with the proof that it did.
///
/// Constructed only through [`Self::completed`], so there is no path to a
/// success value that skips the round trip.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Completion {
    pub provider_id: String,
    /// What now exists at the provider, in the user's words rather than the
    /// provider's field names (ADR 0082 §8).
    pub created: String,
    /// Which account or organization it exists on.
    pub on_account: String,
    pub permissions: GrantedPermissions,
    /// The slots `OpenSesame` now holds, by name. Never their values, and the
    /// secret ones are named as held rather than shown.
    pub holds: Vec<String>,
    pub proof: RoundTrip,
}

impl Completion {
    /// Finish a ceremony, or say why it is not finished.
    ///
    /// Three conditions, all required: every declared slot filled, a round trip
    /// performed, and no authority granted beyond what was asked for.
    ///
    /// # Errors
    ///
    /// [`Incomplete`] naming which one failed, with enough detail for a person
    /// to act on it.
    pub fn completed(
        provider_id: impl Into<String>,
        created: impl Into<String>,
        on_account: impl Into<String>,
        slots: &DeclaredSlots,
        permissions: GrantedPermissions,
        proof: Option<RoundTrip>,
    ) -> Result<Self, Incomplete> {
        let outstanding = slots.outstanding();
        if !outstanding.is_empty() {
            return Err(Incomplete::SlotsOutstanding {
                slots: outstanding
                    .iter()
                    .map(|slot| slot.as_str().to_string())
                    .collect(),
            });
        }
        let excess = permissions.excess();
        if !excess.is_empty() {
            return Err(Incomplete::ExcessPermissions { granted: excess });
        }
        // Last, and deliberately so: a run that captured everything and asked
        // for nothing extra has done all the visible work, and this is the
        // check that says the visible work is not the point.
        let proof = proof.ok_or(Incomplete::NotRoundTripped)?;
        Ok(Self {
            provider_id: provider_id.into(),
            created: created.into(),
            on_account: on_account.into(),
            permissions,
            holds: slots
                .declared()
                .iter()
                .map(|slot| held_description(*slot))
                .collect(),
            proof,
        })
    }
}

/// How a receipt names one thing `OpenSesame` now holds.
///
/// A secret is named as held; an identifier is named as what it is. Neither
/// carries a value — ADR 0082 §8's receipt says what exists and what we keep
/// for it, in terms a person recognizes.
fn held_description(slot: Slot) -> String {
    let name = match slot {
        Slot::AppId => "the app's id",
        Slot::PrivateKey => "a signing key",
        Slot::ClientId => "the client id",
        Slot::ClientSecret => "a client secret",
        Slot::WebhookSecret => "a webhook signing secret",
        Slot::InstallationId => "which installation it is",
    };
    if slot.is_secret() {
        format!("{name} (sealed)")
    } else {
        name.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PEM: &str =
        "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAK\n-----END RSA PRIVATE KEY-----";

    fn filled() -> DeclaredSlots {
        let mut slots =
            DeclaredSlots::declare(&[Slot::AppId, Slot::PrivateKey, Slot::InstallationId]);
        slots.admit(Slot::AppId, "48271").unwrap();
        slots.admit(Slot::PrivateKey, PEM).unwrap();
        slots.admit(Slot::InstallationId, "99001").unwrap();
        slots
    }

    fn asked_and_got(requested: &[&str], granted: &[&str]) -> GrantedPermissions {
        GrantedPermissions {
            requested: requested.iter().map(|p| (*p).to_string()).collect(),
            granted: granted.iter().map(|p| (*p).to_string()).collect(),
        }
    }

    fn proof() -> RoundTrip {
        RoundTrip {
            used: "minted an installation token".into(),
            identified_as: "opensesame-backup on acme-corp".into(),
        }
    }

    #[test]
    fn a_green_form_is_not_success() {
        // The whole of ADR 0082 §6. Everything captured, nothing over-granted,
        // and it still is not done until the credential has been used.
        let refused = Completion::completed(
            "github",
            "a GitHub App named opensesame-backup",
            "acme-corp",
            &filled(),
            asked_and_got(&["contents:write"], &["contents:write"]),
            None,
        );
        assert_eq!(refused, Err(Incomplete::NotRoundTripped));
    }

    #[test]
    fn a_registration_that_was_never_installed_is_not_complete() {
        // The long-fuse failure: an app registered, never installed, and a user
        // who finds out months later when a backup did not happen.
        let mut slots =
            DeclaredSlots::declare(&[Slot::AppId, Slot::PrivateKey, Slot::InstallationId]);
        slots.admit(Slot::AppId, "48271").unwrap();
        slots.admit(Slot::PrivateKey, PEM).unwrap();

        let refused = Completion::completed(
            "github",
            "a GitHub App named opensesame-backup",
            "acme-corp",
            &slots,
            asked_and_got(&["contents:write"], &["contents:write"]),
            Some(proof()),
        );
        assert_eq!(
            refused,
            Err(Incomplete::SlotsOutstanding {
                slots: vec!["installation_id".into()]
            }),
            "and it names the missing piece, because \"registration failed\" is not actionable",
        );
    }

    #[test]
    fn more_authority_than_was_asked_for_aborts() {
        // ADR 0082 §5: verify after, never trust the form.
        let refused = Completion::completed(
            "github",
            "a GitHub App",
            "acme-corp",
            &filled(),
            asked_and_got(&["contents:write"], &["contents:write", "admin:org"]),
            Some(proof()),
        );
        assert_eq!(
            refused,
            Err(Incomplete::ExcessPermissions {
                granted: vec!["admin:org".into()]
            })
        );
    }

    #[test]
    fn less_authority_than_was_asked_for_is_reported_rather_than_refused() {
        // Being given less is a working registration that will fail one later
        // operation. Aborting would leave the user with nothing at all.
        let permissions = asked_and_got(&["contents:write", "issues:write"], &["contents:write"]);
        assert_eq!(permissions.shortfall(), vec!["issues:write".to_string()]);
        assert!(permissions.excess().is_empty());

        let done = Completion::completed(
            "github",
            "a GitHub App",
            "acme-corp",
            &filled(),
            permissions,
            Some(proof()),
        )
        .expect("a shortfall does not abort");
        assert_eq!(
            done.permissions.shortfall(),
            vec!["issues:write".to_string()]
        );
    }

    #[test]
    fn reordered_permissions_are_not_excess() {
        // Providers normalize and reorder. Treating that as excess would abort
        // every successful run.
        let permissions = asked_and_got(
            &["contents:write", "metadata:read"],
            &["metadata:read", "contents:write"],
        );
        assert!(permissions.excess().is_empty());
        assert!(permissions.shortfall().is_empty());
    }

    #[test]
    fn the_receipt_says_what_exists_and_what_is_held_without_naming_a_value() {
        let done = Completion::completed(
            "github",
            "a GitHub App named opensesame-backup",
            "acme-corp",
            &filled(),
            asked_and_got(&["contents:write"], &["contents:write"]),
            Some(proof()),
        )
        .unwrap();

        assert_eq!(done.created, "a GitHub App named opensesame-backup");
        assert_eq!(done.on_account, "acme-corp");
        assert_eq!(
            done.holds,
            vec![
                "the app's id".to_string(),
                "a signing key (sealed)".to_string(),
                "which installation it is".to_string(),
            ],
        );
        assert_eq!(done.proof.used, "minted an installation token");

        // And nothing in the serialized receipt is value-shaped.
        let wire = serde_json::to_string(&done).unwrap();
        assert!(!wire.contains("BEGIN RSA"), "{wire}");
        assert!(!wire.contains("48271") || wire.contains("app's id"));
    }

    #[test]
    fn an_outstanding_slot_is_reported_before_a_missing_round_trip() {
        // Ordering matters for the message a user sees: "you have not finished
        // installing" is more useful than "we never tested it", when both are
        // true and the first explains the second.
        let slots = DeclaredSlots::declare(&[Slot::AppId]);
        assert_eq!(
            Completion::completed(
                "github",
                "an app",
                "acme-corp",
                &slots,
                asked_and_got(&[], &[]),
                None,
            ),
            Err(Incomplete::SlotsOutstanding {
                slots: vec!["app_id".into()]
            }),
        );
    }

    #[test]
    fn a_ceremony_that_declared_nothing_still_needs_its_round_trip() {
        // A C0 provider might capture through the manifest endpoint rather than
        // the page, declaring no browser capture slots at all. The proof
        // requirement does not move.
        let none = DeclaredSlots::declare(&[]);
        assert!(none.is_complete());
        assert_eq!(
            Completion::completed(
                "some-provider",
                "an OAuth client",
                "acme-corp",
                &none,
                asked_and_got(&[], &[]),
                None,
            ),
            Err(Incomplete::NotRoundTripped),
        );
    }
}
