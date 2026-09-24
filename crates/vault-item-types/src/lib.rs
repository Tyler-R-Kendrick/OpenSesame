//! Vault item types on the host plane (ADR 0087).
//!
//! A vault item type is a manifest, not a code path. This crate holds the
//! closed field-type catalogue, the parser and its rejection table, the
//! runtime registry, and the projection onto the base native secret
//! (`sealed_store::Entry`) that makes every type — built-in or community —
//! readable by `opensesame pass`, the password-manager bridges, and
//! `ConnectionRef` materialisation with no per-type host code.
//!
//! The definitions themselves live in `marketplace/item-types/builtin`
//! and are embedded here verbatim, so the host plane and the client plane
//! cannot disagree about what a bank account is (ADR 0087 §8).

pub mod catalogue;
mod errors;
pub mod native;
pub mod registry;
pub mod schema;
pub mod validate;

pub use catalogue::{FieldPart, FieldShape, FieldTypeId, FIELD_TYPE_IDS};
pub use native::{
    decode_value, encode_value, from_entry, to_entry, FieldValue, FieldValues, Readback,
};
pub use registry::{
    directory_name, ItemTypeRegistry, LoadError, Registered, Source, RESERVED_DIRECTORIES,
    RESERVED_TYPE_IDS,
};
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
        include_str!("../../../marketplace/item-types/builtin/address.json"),
    ),
    (
        "api-credential",
        include_str!("../../../marketplace/item-types/builtin/api-credential.json"),
    ),
    (
        "bank-account",
        include_str!("../../../marketplace/item-types/builtin/bank-account.json"),
    ),
    (
        "card",
        include_str!("../../../marketplace/item-types/builtin/card.json"),
    ),
    (
        "certificate",
        include_str!("../../../marketplace/item-types/builtin/certificate.json"),
    ),
    (
        "contact",
        include_str!("../../../marketplace/item-types/builtin/contact.json"),
    ),
    (
        "crypto-wallet",
        include_str!("../../../marketplace/item-types/builtin/crypto-wallet.json"),
    ),
    (
        "database",
        include_str!("../../../marketplace/item-types/builtin/database.json"),
    ),
    (
        "document",
        include_str!("../../../marketplace/item-types/builtin/document.json"),
    ),
    (
        "drivers-license",
        include_str!("../../../marketplace/item-types/builtin/drivers-license.json"),
    ),
    (
        "drop",
        include_str!("../../../marketplace/item-types/builtin/drop.json"),
    ),
    (
        "health-insurance",
        include_str!("../../../marketplace/item-types/builtin/health-insurance.json"),
    ),
    (
        "identity-document",
        include_str!("../../../marketplace/item-types/builtin/identity-document.json"),
    ),
    (
        "login",
        include_str!("../../../marketplace/item-types/builtin/login.json"),
    ),
    (
        "membership",
        include_str!("../../../marketplace/item-types/builtin/membership.json"),
    ),
    (
        "note",
        include_str!("../../../marketplace/item-types/builtin/note.json"),
    ),
    (
        "passkey",
        include_str!("../../../marketplace/item-types/builtin/passkey.json"),
    ),
    (
        "passport",
        include_str!("../../../marketplace/item-types/builtin/passport.json"),
    ),
    (
        "secret",
        include_str!("../../../marketplace/item-types/builtin/secret.json"),
    ),
    (
        "server",
        include_str!("../../../marketplace/item-types/builtin/server.json"),
    ),
    (
        "software-license",
        include_str!("../../../marketplace/item-types/builtin/software-license.json"),
    ),
    (
        "ssh-key",
        include_str!("../../../marketplace/item-types/builtin/ssh-key.json"),
    ),
    (
        "wifi",
        include_str!("../../../marketplace/item-types/builtin/wifi.json"),
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
