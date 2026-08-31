//! Vault item types on the host plane (ADR 0087).
//!
//! A vault item type is a manifest, not a code path. This crate holds the
//! closed field-type catalogue, the parser and its rejection table, the
//! runtime registry, and the projection onto the base native secret
//! (`sealed_store::Entry`) that makes every type — built-in or community —
//! readable by `opensesame pass`, the password-manager bridges, and
//! `ConnectionRef` materialisation with no per-type host code.
//!
//! The definitions themselves live in `packages/vault-item-types/definitions`
//! and are embedded here verbatim, so the host plane and the client plane
//! cannot disagree about what a bank account is (ADR 0087 §8).

pub mod catalogue;
pub mod native;
pub mod registry;
pub mod schema;
pub mod validate;

pub use catalogue::{FieldPart, FieldShape, FieldTypeId, FIELD_TYPE_IDS};
pub use native::{
    decode_value, encode_value, from_entry, to_entry, FieldValue, FieldValues, Readback,
};
pub use registry::{ItemTypeRegistry, LoadError, Registered, Source};
pub use schema::{
    CxfCredentialId, FieldDefinition, HandlerId, ItemTypeDefinition, ItemTypeMetadata,
    ItemTypeSpec, NativeProjection, SectionDefinition, TrailerMapping, DEFINITION_API_VERSION,
    DEFINITION_KIND, PLATFORM_PUBLISHER,
};
pub use validate::{
    parse_definition, validate, DefinitionError, DefinitionErrors, ErrorCode, Trust,
};

/// The shared corpus, keyed by type id. One source of truth for both planes.
pub const BUILTIN_DEFINITIONS: &[(&str, &str)] = &[
    (
        "address",
        include_str!("../../../packages/vault-item-types/definitions/address.json"),
    ),
    (
        "api-credential",
        include_str!("../../../packages/vault-item-types/definitions/api-credential.json"),
    ),
    (
        "bank-account",
        include_str!("../../../packages/vault-item-types/definitions/bank-account.json"),
    ),
    (
        "card",
        include_str!("../../../packages/vault-item-types/definitions/card.json"),
    ),
    (
        "certificate",
        include_str!("../../../packages/vault-item-types/definitions/certificate.json"),
    ),
    (
        "contact",
        include_str!("../../../packages/vault-item-types/definitions/contact.json"),
    ),
    (
        "crypto-wallet",
        include_str!("../../../packages/vault-item-types/definitions/crypto-wallet.json"),
    ),
    (
        "database",
        include_str!("../../../packages/vault-item-types/definitions/database.json"),
    ),
    (
        "document",
        include_str!("../../../packages/vault-item-types/definitions/document.json"),
    ),
    (
        "drivers-license",
        include_str!("../../../packages/vault-item-types/definitions/drivers-license.json"),
    ),
    (
        "drop",
        include_str!("../../../packages/vault-item-types/definitions/drop.json"),
    ),
    (
        "health-insurance",
        include_str!("../../../packages/vault-item-types/definitions/health-insurance.json"),
    ),
    (
        "identity-document",
        include_str!("../../../packages/vault-item-types/definitions/identity-document.json"),
    ),
    (
        "login",
        include_str!("../../../packages/vault-item-types/definitions/login.json"),
    ),
    (
        "membership",
        include_str!("../../../packages/vault-item-types/definitions/membership.json"),
    ),
    (
        "note",
        include_str!("../../../packages/vault-item-types/definitions/note.json"),
    ),
    (
        "passkey",
        include_str!("../../../packages/vault-item-types/definitions/passkey.json"),
    ),
    (
        "passport",
        include_str!("../../../packages/vault-item-types/definitions/passport.json"),
    ),
    (
        "secret",
        include_str!("../../../packages/vault-item-types/definitions/secret.json"),
    ),
    (
        "server",
        include_str!("../../../packages/vault-item-types/definitions/server.json"),
    ),
    (
        "software-license",
        include_str!("../../../packages/vault-item-types/definitions/software-license.json"),
    ),
    (
        "ssh-key",
        include_str!("../../../packages/vault-item-types/definitions/ssh-key.json"),
    ),
    (
        "wifi",
        include_str!("../../../packages/vault-item-types/definitions/wifi.json"),
    ),
];

/// The environment variable naming a directory of host-provisioned types.
pub const ITEM_TYPE_DIR_ENV: &str = "OPENSESAME_VAULT_ITEM_TYPE_DIR";

/// The seven ids that predate ADR 0087 and are still spelled out in the
/// client's storage. Kept here so the corpus cannot lose one silently.
pub const LEGACY_TYPE_IDS: &[&str] = &[
    "login",
    "passkey",
    "card",
    "secret",
    "note",
    "certificate",
    "drop",
];
