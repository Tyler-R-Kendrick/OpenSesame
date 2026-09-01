//! The closed field-type catalogue (ADR 0087 §2).
//!
//! Mirrors `packages/vault-item-types/src/catalogue.ts` entry for entry. A
//! definition names a field type; it never describes one, which is what keeps
//! a manifest inert. Adding an entry here is a platform change, and it must
//! land in both languages at once — `tests/conformance.rs` fails otherwise.

use serde::{Deserialize, Serialize};

/// A named text part of a record-shaped field.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FieldPart {
    pub id: &'static str,
    pub label: &'static str,
    /// A concealed part makes the whole field concealed for the preview rule.
    pub concealed: bool,
}

const fn part(id: &'static str, label: &'static str) -> FieldPart {
    FieldPart {
        id,
        label,
        concealed: false,
    }
}

const fn secret_part(id: &'static str, label: &'static str) -> FieldPart {
    FieldPart {
        id,
        label,
        concealed: true,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FieldShape {
    Scalar,
    Record,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "kebab-case")]
pub enum FieldTypeId {
    String,
    Multiline,
    Email,
    Url,
    Number,
    Boolean,
    Date,
    MonthYear,
    Country,
    Select,
    Phone,
    Concealed,
    Password,
    Pin,
    KeyMaterial,
    Totp,
    Address,
    PersonName,
    HostPort,
    SecurityQuestion,
    PaymentCard,
    KeyPair,
}

/// Every catalogue entry, in the same order as the TypeScript table.
pub const FIELD_TYPE_IDS: [FieldTypeId; 22] = [
    FieldTypeId::String,
    FieldTypeId::Multiline,
    FieldTypeId::Email,
    FieldTypeId::Url,
    FieldTypeId::Number,
    FieldTypeId::Boolean,
    FieldTypeId::Date,
    FieldTypeId::MonthYear,
    FieldTypeId::Country,
    FieldTypeId::Select,
    FieldTypeId::Phone,
    FieldTypeId::Concealed,
    FieldTypeId::Password,
    FieldTypeId::Pin,
    FieldTypeId::KeyMaterial,
    FieldTypeId::Totp,
    FieldTypeId::Address,
    FieldTypeId::PersonName,
    FieldTypeId::HostPort,
    FieldTypeId::SecurityQuestion,
    FieldTypeId::PaymentCard,
    FieldTypeId::KeyPair,
];

const ADDRESS_PARTS: [FieldPart; 6] = [
    part("street1", "Street"),
    part("street2", "Street 2"),
    part("city", "City"),
    part("state", "State or province"),
    part("postalCode", "Postal code"),
    part("country", "Country"),
];

const PERSON_NAME_PARTS: [FieldPart; 3] = [
    part("first", "First"),
    part("middle", "Middle"),
    part("last", "Last"),
];

const HOST_PORT_PARTS: [FieldPart; 2] = [part("host", "Host"), part("port", "Port")];

const SECURITY_QUESTION_PARTS: [FieldPart; 2] = [
    part("question", "Question"),
    secret_part("answer", "Answer"),
];

const PAYMENT_CARD_PARTS: [FieldPart; 3] = [
    secret_part("number", "Number"),
    part("expiry", "Expires"),
    secret_part("code", "Security code"),
];

const KEY_PAIR_PARTS: [FieldPart; 2] = [
    part("publicKey", "Public key"),
    secret_part("privateKey", "Private key"),
];

impl FieldTypeId {
    /// The wire spelling, as it appears in a definition's `type`.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::String => "string",
            Self::Multiline => "multiline",
            Self::Email => "email",
            Self::Url => "url",
            Self::Number => "number",
            Self::Boolean => "boolean",
            Self::Date => "date",
            Self::MonthYear => "month-year",
            Self::Country => "country",
            Self::Select => "select",
            Self::Phone => "phone",
            Self::Concealed => "concealed",
            Self::Password => "password",
            Self::Pin => "pin",
            Self::KeyMaterial => "key-material",
            Self::Totp => "totp",
            Self::Address => "address",
            Self::PersonName => "person-name",
            Self::HostPort => "host-port",
            Self::SecurityQuestion => "security-question",
            Self::PaymentCard => "payment-card",
            Self::KeyPair => "key-pair",
        }
    }

    #[must_use]
    pub const fn shape(self) -> FieldShape {
        match self {
            Self::Address
            | Self::PersonName
            | Self::HostPort
            | Self::SecurityQuestion
            | Self::PaymentCard
            | Self::KeyPair => FieldShape::Record,
            _ => FieldShape::Scalar,
        }
    }

    /// The complete, ordered part list; empty for every scalar shape.
    #[must_use]
    pub const fn parts(self) -> &'static [FieldPart] {
        match self {
            Self::Address => &ADDRESS_PARTS,
            Self::PersonName => &PERSON_NAME_PARTS,
            Self::HostPort => &HOST_PORT_PARTS,
            Self::SecurityQuestion => &SECURITY_QUESTION_PARTS,
            Self::PaymentCard => &PAYMENT_CARD_PARTS,
            Self::KeyPair => &KEY_PAIR_PARTS,
            _ => &[],
        }
    }

    /// True when the value must never render without a reveal gesture. A
    /// record shape is concealed when any one of its parts is.
    #[must_use]
    pub const fn concealed(self) -> bool {
        matches!(
            self,
            Self::Concealed
                | Self::Password
                | Self::Pin
                | Self::KeyMaterial
                | Self::Totp
                | Self::SecurityQuestion
                | Self::PaymentCard
                | Self::KeyPair
        )
    }

    #[must_use]
    pub const fn multiline(self) -> bool {
        matches!(self, Self::Multiline | Self::KeyMaterial)
    }
}
