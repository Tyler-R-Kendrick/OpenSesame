//! The `VaultItemType` manifest, as the host plane parses it (ADR 0087 §1).
//!
//! `deny_unknown_fields` on every struct, for the reason ADR 0065 §4 gives: an
//! author must not be able to smuggle in a field this parser silently drops
//! today and some later consumer honours. There is no field here capable of
//! carrying a URL a loader would fetch, and none capable of carrying a value —
//! `default` is refused on every concealed field type by `validate`.

use serde::{Deserialize, Serialize};

use crate::catalogue::FieldTypeId;

pub const DEFINITION_API_VERSION: &str = "opensesame.dev/v1alpha1";
pub const DEFINITION_KIND: &str = "VaultItemType";
/// The publisher only built-in definitions may claim (ADR 0087 §5).
pub const PLATFORM_PUBLISHER: &str = "https://opensesame.dev";

pub const MAX_DEFINITION_BYTES: usize = 64 * 1024;
pub const MAX_SECTIONS: usize = 16;
pub const MAX_FIELDS: usize = 64;
pub const MAX_OPTIONS: usize = 32;
pub const MAX_LABEL_CHARS: usize = 120;
pub const MAX_SUMMARY_CHARS: usize = 400;

/// Ceremonies the platform implements because no data description can express
/// them. Only a platform-published definition may name one (ADR 0087 §6).
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum HandlerId {
    Login,
    Passkey,
    Secret,
    Certificate,
    Drop,
}

/// FIDO CXF credential discriminators a definition may map onto.
/// `CustomFields` is the floor, so nothing is unexportable (ADR 0087 §4).
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CxfCredentialId {
    BasicAuth,
    Passkey,
    Totp,
    CreditCard,
    Note,
    SshKey,
    ApiKey,
    Wifi,
    Address,
    PersonName,
    IdentityDocument,
    DriversLicense,
    Passport,
    File,
    CustomFields,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct FieldDefinition {
    pub id: String,
    #[serde(rename = "type")]
    pub field_type: FieldTypeId,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub help: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub required: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub placeholder: Option<String>,
    /// `select` only; the complete closed option list.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<String>>,
    /// Scalar shapes only; the field holds an ordered list of values.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub multiple: Option<bool>,
    /// Prefilled in a new item. Refused outright on a concealed field type.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<String>,
}

impl FieldDefinition {
    #[must_use]
    pub fn repeats(&self) -> bool {
        self.multiple == Some(true)
    }

    #[must_use]
    pub fn is_required(&self) -> bool {
        self.required == Some(true)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SectionDefinition {
    pub id: String,
    pub title: String,
    pub fields: Vec<FieldDefinition>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct TrailerMapping {
    /// The `key:` written into the native entry's trailer.
    pub key: String,
    /// The field whose value it carries.
    pub field: String,
}

/// How the type lands on `sealed_store::Entry`: one field becomes line one,
/// the rest become trailer keys. `secret: null` projects an empty first line.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct NativeProjection {
    pub secret: Option<String>,
    pub trailer: Vec<TrailerMapping>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct CxfMapping {
    pub credential: CxfCredentialId,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ItemTypeSpec {
    pub title: String,
    pub plural: String,
    /// VFS filename extension, leading dot (ADR 0064/0073).
    pub extension: String,
    pub summary: String,
    pub categories: Vec<String>,
    pub sections: Vec<SectionDefinition>,
    pub native: NativeProjection,
    pub cxf: CxfMapping,
    /// Fields shown in the item list. Never concealed ones (ADR 0087 §5).
    pub subtitle: Vec<String>,
    /// Fields added to the search haystack. Never concealed ones.
    pub search: Vec<String>,
    /// Platform-published definitions only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub handler: Option<HandlerId>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ItemTypeMetadata {
    pub id: String,
    pub version: String,
    pub publisher: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ItemTypeDefinition {
    pub api_version: String,
    pub kind: String,
    pub metadata: ItemTypeMetadata,
    pub spec: ItemTypeSpec,
}

impl ItemTypeDefinition {
    /// Every field, flattened in section then declaration order.
    #[must_use]
    pub fn fields(&self) -> Vec<&FieldDefinition> {
        self.spec
            .sections
            .iter()
            .flat_map(|section| section.fields.iter())
            .collect()
    }

    #[must_use]
    pub fn field(&self, id: &str) -> Option<&FieldDefinition> {
        self.fields().into_iter().find(|field| field.id == id)
    }

    #[must_use]
    pub fn is_platform_published(&self) -> bool {
        self.metadata.publisher == PLATFORM_PUBLISHER
    }
}
