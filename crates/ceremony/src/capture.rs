//! Typed capture slots, and the shapes that fail closed.
//!
//! `capture_credential` is the first tool in the system that moves a secret
//! *toward* the vault from an untrusted page (ADR 0082 consequences). Nothing
//! here ever holds a value: a slot says what shape is expected and the
//! deterministic controller reads the node, checks the shape, and seals it. The
//! model names a slot and a selector, and receives a digest that redeems
//! nothing.

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// The typed slots a ceremony recipe may declare.
///
/// A closed set on purpose. ADR 0082 §3: "a model free to choose what to
/// capture could capture the page's session cookie and seal it as a client
/// secret". A slot is not a label a caller invents — it is a name from this
/// list, with a shape attached.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, Hash)]
#[serde(rename_all = "snake_case")]
pub enum Slot {
    /// A provider's numeric identifier for the app it just created.
    AppId,
    /// A PEM private key, usually delivered as a download rather than a DOM
    /// value.
    PrivateKey,
    /// An OAuth client identifier. Not secret, and still declared, because a
    /// ceremony that captures the wrong one fails at first use.
    ClientId,
    /// An OAuth client secret.
    ClientSecret,
    /// The shared secret a provider signs its webhooks with.
    WebhookSecret,
    /// Which installation of the app on which account. Captured because a
    /// registration without one is the silent failure ADR 0082 §1 names.
    InstallationId,
}

impl Slot {
    pub const ALL: [Self; 6] = [
        Self::AppId,
        Self::PrivateKey,
        Self::ClientId,
        Self::ClientSecret,
        Self::WebhookSecret,
        Self::InstallationId,
    ];

    /// Frozen wire name.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::AppId => "app_id",
            Self::PrivateKey => "private_key",
            Self::ClientId => "client_id",
            Self::ClientSecret => "client_secret",
            Self::WebhookSecret => "webhook_secret",
            Self::InstallationId => "installation_id",
        }
    }

    #[must_use]
    pub fn parse(raw: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|slot| slot.as_str() == raw)
    }

    /// The shape a value must have to be sealed into this slot.
    #[must_use]
    pub const fn shape(self) -> Shape {
        match self {
            Self::AppId | Self::InstallationId => Shape::Digits,
            Self::PrivateKey => Shape::Pem,
            // Providers spell client identifiers in wildly different ways
            // (`Iv1.` prefixes, UUIDs, opaque base64), so the only honest
            // structural claim is that it is a bounded printable token.
            Self::ClientId | Self::ClientSecret | Self::WebhookSecret => Shape::OpaqueToken,
        }
    }

    /// Whether a value in this slot is credential material.
    ///
    /// A client id is not, and is still captured — knowing which fields are
    /// secret is what lets a receipt name what was created without naming what
    /// was sealed (ADR 0082 §8).
    #[must_use]
    pub const fn is_secret(self) -> bool {
        matches!(
            self,
            Self::PrivateKey | Self::ClientSecret | Self::WebhookSecret
        )
    }
}

/// Shortest value any slot accepts.
///
/// A page that renders an empty field, or a one-character placeholder, must not
/// pass as a client secret.
pub const MIN_TOKEN_CHARS: usize = 8;
/// Longest value captured into an opaque slot.
///
/// Bounded because an unbounded capture from a hostile page is an unbounded
/// write into the vault. Real client secrets are tens of characters.
pub const MAX_TOKEN_CHARS: usize = 4_096;
/// Longest PEM body accepted. A 4096-bit RSA key armors to well under this.
pub const MAX_PEM_BYTES: usize = 16_384;

const PEM_BEGIN: &str = "-----BEGIN ";
const PEM_END: &str = "-----END ";

/// What a captured value has to look like.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Shape {
    /// ASCII digits, no separators.
    Digits,
    /// PEM armor, begin and end.
    Pem,
    /// A bounded, printable, whitespace-free token.
    OpaqueToken,
}

/// Why a captured value was refused.
///
/// Every variant aborts the run. ADR 0082 §3: "the alternative is sealing a
/// login page as a signing key and discovering it at first use, months later,
/// during a backup."
#[derive(Clone, Copy, Debug, PartialEq, Eq, Error, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CaptureRefusal {
    #[error("the recipe does not declare this slot")]
    SlotNotDeclared,
    #[error("this slot was already captured")]
    SlotAlreadyFilled,
    #[error("the captured value is empty")]
    Empty,
    #[error("the captured value is too short for the slot")]
    TooShort,
    #[error("the captured value is longer than the slot allows")]
    TooLong,
    #[error("the captured value does not have the slot's shape")]
    WrongShape,
    #[error("a downloaded capture did not arrive as the declared content type")]
    WrongContentType,
}

/// Check a value against a slot's shape.
///
/// Takes the value and returns nothing but a verdict. There is no accessor on
/// the way out and no `Ok(String)`: the controller that called this already
/// holds the plaintext and is about to seal it, and handing it back would
/// create a second place it lives.
///
/// # Errors
///
/// [`CaptureRefusal`] naming what was wrong. Never *what the value was*: these
/// errors reach a receipt and a log line.
pub fn check_shape(slot: Slot, value: &str) -> Result<(), CaptureRefusal> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(CaptureRefusal::Empty);
    }
    match slot.shape() {
        Shape::Digits => {
            if trimmed.chars().count() > MAX_TOKEN_CHARS {
                return Err(CaptureRefusal::TooLong);
            }
            if !trimmed.chars().all(|ch| ch.is_ascii_digit()) {
                return Err(CaptureRefusal::WrongShape);
            }
            Ok(())
        }
        Shape::Pem => {
            if trimmed.len() > MAX_PEM_BYTES {
                return Err(CaptureRefusal::TooLong);
            }
            // Armor at both ends. An HTML error page rendered where a key was
            // expected fails here, which is the case this check exists for.
            if !trimmed.starts_with(PEM_BEGIN) || !trimmed.contains(PEM_END) {
                return Err(CaptureRefusal::WrongShape);
            }
            Ok(())
        }
        Shape::OpaqueToken => {
            let chars = trimmed.chars().count();
            if chars < MIN_TOKEN_CHARS {
                return Err(CaptureRefusal::TooShort);
            }
            if chars > MAX_TOKEN_CHARS {
                return Err(CaptureRefusal::TooLong);
            }
            // Printable and unbroken. A value carrying whitespace or control
            // characters is a page fragment, not a token.
            if !trimmed
                .chars()
                .all(|ch| ch.is_ascii_graphic() && !ch.is_ascii_whitespace())
            {
                return Err(CaptureRefusal::WrongShape);
            }
            Ok(())
        }
    }
}

/// A non-redeemable receipt that a slot was filled.
///
/// The same shape as ADR 0005's `ConnectionRef`: it names *that* something was
/// captured and *which slot* it went into, and it cannot be exchanged for the
/// value. This is what a capture step returns to the model, so the model can
/// see progress without ever seeing material.
///
/// There is deliberately no constructor taking a plaintext and no accessor
/// returning one. The digest is supplied by the controller that did the
/// sealing, from the sealed blob rather than from the value.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CaptureDigest {
    slot: Slot,
    /// A short, opaque marker of the sealed blob. Not a hash of the plaintext:
    /// a stored digest of a secret is a crackable artifact, which is the trade
    /// ADR 0080 §5 already refused for breach findings.
    marker: String,
}

impl CaptureDigest {
    #[must_use]
    pub fn of_sealed(slot: Slot, marker: impl Into<String>) -> Self {
        Self {
            slot,
            marker: marker.into(),
        }
    }

    #[must_use]
    pub const fn slot(&self) -> Slot {
        self.slot
    }

    #[must_use]
    pub fn marker(&self) -> &str {
        &self.marker
    }
}

/// The slots one recipe declares, and which have been filled.
///
/// ADR 0082 §3's rule made structural: a capture step may only name a declared
/// slot, so the set is fixed when the recipe is loaded and a run cannot grow it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeclaredSlots {
    declared: Vec<Slot>,
    filled: Vec<Slot>,
}

impl DeclaredSlots {
    /// Declare the slots a recipe names. Duplicates collapse.
    #[must_use]
    pub fn declare(slots: &[Slot]) -> Self {
        let mut declared: Vec<Slot> = slots.to_vec();
        declared.sort_unstable();
        declared.dedup();
        Self {
            declared,
            filled: Vec::new(),
        }
    }

    #[must_use]
    pub fn declares(&self, slot: Slot) -> bool {
        self.declared.contains(&slot)
    }

    #[must_use]
    pub fn is_filled(&self, slot: Slot) -> bool {
        self.filled.contains(&slot)
    }

    #[must_use]
    pub fn declared(&self) -> &[Slot] {
        &self.declared
    }

    /// Every declared slot that is still empty.
    #[must_use]
    pub fn outstanding(&self) -> Vec<Slot> {
        self.declared
            .iter()
            .copied()
            .filter(|slot| !self.is_filled(*slot))
            .collect()
    }

    /// Admit one capture: the slot must be declared, unfilled, and the value
    /// must have the slot's shape.
    ///
    /// Filling happens here rather than at the call site so the three checks
    /// cannot drift apart — a caller that remembered the shape check but not
    /// the declaration check would be exactly the ADR 0082 §3 hole.
    ///
    /// # Errors
    ///
    /// [`CaptureRefusal`] naming which rule was broken.
    pub fn admit(&mut self, slot: Slot, value: &str) -> Result<(), CaptureRefusal> {
        if !self.declares(slot) {
            return Err(CaptureRefusal::SlotNotDeclared);
        }
        if self.is_filled(slot) {
            // A second capture into one slot is either a recipe bug or a page
            // that re-rendered; overwriting would mean the sealed value and the
            // receipt describe different things.
            return Err(CaptureRefusal::SlotAlreadyFilled);
        }
        check_shape(slot, value)?;
        self.filled.push(slot);
        Ok(())
    }

    /// Whether every declared slot has been filled.
    #[must_use]
    pub fn is_complete(&self) -> bool {
        self.outstanding().is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PEM: &str =
        "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAK\n-----END RSA PRIVATE KEY-----";

    #[test]
    fn wire_names_are_frozen() {
        let names: Vec<&str> = Slot::ALL.iter().map(|slot| slot.as_str()).collect();
        assert_eq!(
            names,
            [
                "app_id",
                "private_key",
                "client_id",
                "client_secret",
                "webhook_secret",
                "installation_id"
            ]
        );
        for slot in Slot::ALL {
            assert_eq!(Slot::parse(slot.as_str()), Some(slot));
        }
        assert_eq!(Slot::parse("session_cookie"), None);
    }

    #[test]
    fn a_slot_the_recipe_did_not_declare_is_refused() {
        // The rule ADR 0082 §3 calls more load-bearing than rotation's: a model
        // free to choose what to capture could seal a session cookie as a
        // client secret.
        let mut slots = DeclaredSlots::declare(&[Slot::AppId]);
        assert_eq!(
            slots.admit(Slot::ClientSecret, "shhhhhhhh"),
            Err(CaptureRefusal::SlotNotDeclared)
        );
        assert_eq!(slots.admit(Slot::AppId, "123456"), Ok(()));
    }

    #[test]
    fn an_html_error_page_is_not_a_private_key() {
        // The case the shape check exists for. Sealing this would produce a
        // signing key that fails at first use, months later, during a backup.
        let mut slots = DeclaredSlots::declare(&[Slot::PrivateKey]);
        assert_eq!(
            slots.admit(Slot::PrivateKey, "<!doctype html><html><body>Sign in"),
            Err(CaptureRefusal::WrongShape),
        );
        assert_eq!(slots.admit(Slot::PrivateKey, PEM), Ok(()));
    }

    #[test]
    fn a_truncated_pem_is_refused_rather_than_sealed_half() {
        assert_eq!(
            check_shape(
                Slot::PrivateKey,
                "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAK"
            ),
            Err(CaptureRefusal::WrongShape),
            "armor at one end is a download that was cut off",
        );
    }

    #[test]
    fn an_id_slot_takes_digits_and_nothing_else() {
        for slot in [Slot::AppId, Slot::InstallationId] {
            assert_eq!(check_shape(slot, "48271"), Ok(()));
            assert_eq!(check_shape(slot, "48,271"), Err(CaptureRefusal::WrongShape));
            assert_eq!(
                check_shape(slot, "app-48271"),
                Err(CaptureRefusal::WrongShape)
            );
            assert_eq!(check_shape(slot, "   "), Err(CaptureRefusal::Empty));
        }
    }

    #[test]
    fn a_token_slot_refuses_a_page_fragment() {
        // Whitespace or control characters mean the selector matched a block of
        // markup rather than a field.
        assert_eq!(
            check_shape(Slot::ClientSecret, "abc123 def456"),
            Err(CaptureRefusal::WrongShape)
        );
        assert_eq!(
            check_shape(Slot::ClientSecret, "abc123\ndef456"),
            Err(CaptureRefusal::WrongShape)
        );
        assert_eq!(check_shape(Slot::ClientSecret, "Iv1.a1b2c3d4e5f6"), Ok(()));
    }

    #[test]
    fn a_placeholder_is_too_short_to_be_a_secret() {
        assert_eq!(
            check_shape(Slot::WebhookSecret, "•••"),
            Err(CaptureRefusal::TooShort),
        );
        assert_eq!(
            check_shape(Slot::ClientId, "x"),
            Err(CaptureRefusal::TooShort)
        );
    }

    #[test]
    fn an_unbounded_capture_is_refused_rather_than_written_to_the_vault() {
        let huge = "a".repeat(MAX_TOKEN_CHARS + 1);
        assert_eq!(
            check_shape(Slot::ClientSecret, &huge),
            Err(CaptureRefusal::TooLong)
        );
        let huge_pem = format!(
            "-----BEGIN RSA PRIVATE KEY-----\n{}\n-----END RSA PRIVATE KEY-----",
            "A".repeat(MAX_PEM_BYTES)
        );
        assert_eq!(
            check_shape(Slot::PrivateKey, &huge_pem),
            Err(CaptureRefusal::TooLong)
        );
    }

    #[test]
    fn a_slot_is_filled_once() {
        // A second capture into one slot means the sealed value and the receipt
        // would describe different things.
        let mut slots = DeclaredSlots::declare(&[Slot::ClientSecret]);
        assert_eq!(slots.admit(Slot::ClientSecret, "firstsecret"), Ok(()));
        assert_eq!(
            slots.admit(Slot::ClientSecret, "secondsecret"),
            Err(CaptureRefusal::SlotAlreadyFilled)
        );
    }

    #[test]
    fn a_refused_capture_does_not_count_as_filled() {
        let mut slots = DeclaredSlots::declare(&[Slot::AppId]);
        assert!(slots.admit(Slot::AppId, "not-digits").is_err());
        assert!(!slots.is_filled(Slot::AppId));
        assert_eq!(slots.outstanding(), vec![Slot::AppId]);
        assert!(!slots.is_complete());
    }

    #[test]
    fn a_ceremony_knows_what_it_still_owes() {
        let mut slots =
            DeclaredSlots::declare(&[Slot::AppId, Slot::PrivateKey, Slot::InstallationId]);
        assert!(!slots.is_complete());
        assert_eq!(slots.admit(Slot::AppId, "48271"), Ok(()));
        assert_eq!(slots.admit(Slot::PrivateKey, PEM), Ok(()));
        assert_eq!(slots.outstanding(), vec![Slot::InstallationId]);
        assert_eq!(slots.admit(Slot::InstallationId, "99001"), Ok(()));
        assert!(slots.is_complete());
    }

    #[test]
    fn a_duplicate_declaration_is_one_slot() {
        let slots = DeclaredSlots::declare(&[Slot::AppId, Slot::AppId, Slot::ClientId]);
        assert_eq!(slots.declared(), &[Slot::AppId, Slot::ClientId]);
    }

    #[test]
    fn a_digest_names_its_slot_and_redeems_nothing() {
        // The ConnectionRef shape: the model sees that a capture happened and
        // where it went, and holds nothing it can exchange for the value.
        let digest = CaptureDigest::of_sealed(Slot::PrivateKey, "sealed:9f2c");
        assert_eq!(digest.slot(), Slot::PrivateKey);
        assert_eq!(digest.marker(), "sealed:9f2c");

        // Serializing it must not produce anything value-shaped either.
        let wire = serde_json::to_string(&digest).unwrap();
        assert_eq!(wire, r#"{"slot":"private_key","marker":"sealed:9f2c"}"#);
    }

    #[test]
    fn the_slots_that_are_secret_are_the_ones_a_receipt_must_not_name() {
        assert!(Slot::PrivateKey.is_secret());
        assert!(Slot::ClientSecret.is_secret());
        assert!(Slot::WebhookSecret.is_secret());
        // Identifiers are captured and are not material: a receipt says which
        // app on which account, and that is the point of ADR 0082 §8.
        assert!(!Slot::AppId.is_secret());
        assert!(!Slot::ClientId.is_secret());
        assert!(!Slot::InstallationId.is_secret());
    }
}
