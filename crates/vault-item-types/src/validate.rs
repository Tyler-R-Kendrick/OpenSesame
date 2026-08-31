//! The host-plane rejection table (ADR 0087 §5).
//!
//! Serde's `deny_unknown_fields` covers shape; everything below covers the
//! rules a shape cannot express — that a definition carries no value on a
//! concealed field, that concealed fields stay out of every surface which
//! renders without a reveal gesture, that the native projection points at a
//! field that can hold line one, and that only the platform names a ceremony
//! handler. `packages/vault-item-types/src/validate.ts` carries the same
//! table; `tests/conformance.rs` holds the two together.

use std::collections::BTreeSet;
use std::fmt;

use crate::catalogue::{FieldShape, FieldTypeId};
use crate::schema::{
    FieldDefinition, ItemTypeDefinition, DEFINITION_API_VERSION, DEFINITION_KIND,
    MAX_DEFINITION_BYTES, MAX_FIELDS, MAX_LABEL_CHARS, MAX_OPTIONS, MAX_SECTIONS,
    MAX_SUMMARY_CHARS, PLATFORM_PUBLISHER,
};

/// Whether the caller is loading the platform's own embedded corpus or an
/// install from anywhere else. Only the former may name a ceremony handler.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Trust {
    Platform,
    Community,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ErrorCode {
    TooLarge,
    Syntax,
    UnknownField,
    ApiVersion,
    Kind,
    Id,
    Version,
    Publisher,
    Text,
    Extension,
    Sections,
    FieldId,
    DuplicateField,
    Options,
    Multiple,
    ConcealedDefault,
    NativeSecret,
    Trailer,
    ConcealedPreview,
    Handler,
}

impl ErrorCode {
    /// The code as the TypeScript parser spells it, so the two rejection
    /// tables can be compared row for row.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::TooLarge => "too-large",
            Self::Syntax => "syntax",
            Self::UnknownField => "unknown-field",
            Self::ApiVersion => "api-version",
            Self::Kind => "kind",
            Self::Id => "id",
            Self::Version => "version",
            Self::Publisher => "publisher",
            Self::Text => "text",
            Self::Extension => "extension",
            Self::Sections => "sections",
            Self::FieldId => "field-id",
            Self::DuplicateField => "duplicate-field",
            Self::Options => "options",
            Self::Multiple => "multiple",
            Self::ConcealedDefault => "concealed-default",
            Self::NativeSecret => "native-secret",
            Self::Trailer => "trailer",
            Self::ConcealedPreview => "concealed-preview",
            Self::Handler => "handler",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DefinitionError {
    pub code: ErrorCode,
    /// Dotted path into the manifest, e.g. `spec.sections[0].fields[2].type`.
    pub path: String,
    pub message: String,
}

impl fmt::Display for DefinitionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.path.is_empty() {
            write!(f, "{}", self.message)
        } else {
            write!(f, "{}: {}", self.path, self.message)
        }
    }
}

/// Every refusal a definition drew, in the order they were found.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DefinitionErrors(pub Vec<DefinitionError>);

impl fmt::Display for DefinitionErrors {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let joined = self
            .0
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join("\n");
        write!(f, "{joined}")
    }
}

impl std::error::Error for DefinitionErrors {}

impl DefinitionErrors {
    #[must_use]
    pub fn codes(&self) -> Vec<ErrorCode> {
        self.0.iter().map(|error| error.code).collect()
    }

    #[must_use]
    pub fn has(&self, code: ErrorCode) -> bool {
        self.0.iter().any(|error| error.code == code)
    }
}

struct Refusals(Vec<DefinitionError>);

impl Refusals {
    fn add(&mut self, code: ErrorCode, path: &str, message: impl Into<String>) {
        self.0.push(DefinitionError {
            code,
            path: path.to_owned(),
            message: message.into(),
        });
    }
}

fn is_lower_slug(value: &str, min_len: usize) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    value.len() >= min_len
        && first.is_ascii_lowercase()
        && value
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

fn is_identifier(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    value.len() <= 48
        && first.is_ascii_alphabetic()
        && value.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn is_trailer_key(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    value.len() <= 32
        && first.is_ascii_lowercase()
        && value
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
}

fn is_semver(value: &str) -> bool {
    let parts: Vec<&str> = value.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_digit()))
}

fn is_extension(value: &str) -> bool {
    let Some(rest) = value.strip_prefix('.') else {
        return false;
    };
    !rest.is_empty()
        && rest.len() <= 12
        && rest
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
}

fn check_text(refusals: &mut Refusals, value: &str, path: &str, max: usize) {
    if value.trim().is_empty() {
        refusals.add(ErrorCode::Text, path, format!("{path} must not be empty"));
    } else if value.chars().count() > max {
        refusals.add(
            ErrorCode::Text,
            path,
            format!("{path} exceeds {max} characters"),
        );
    }
}

fn check_metadata(refusals: &mut Refusals, definition: &ItemTypeDefinition) {
    if definition.api_version != DEFINITION_API_VERSION {
        refusals.add(
            ErrorCode::ApiVersion,
            "apiVersion",
            format!("unsupported apiVersion; expected `{DEFINITION_API_VERSION}`"),
        );
    }
    if definition.kind != DEFINITION_KIND {
        refusals.add(
            ErrorCode::Kind,
            "kind",
            format!("unsupported kind; expected `{DEFINITION_KIND}`"),
        );
    }
    let metadata = &definition.metadata;
    if !is_lower_slug(&metadata.id, 2) || metadata.id.len() > 48 {
        refusals.add(
            ErrorCode::Id,
            "metadata.id",
            format!("type id `{}` is not a lowercase slug", metadata.id),
        );
    }
    if !is_semver(&metadata.version) {
        refusals.add(
            ErrorCode::Version,
            "metadata.version",
            "version must be MAJOR.MINOR.PATCH",
        );
    }
    if !metadata.publisher.starts_with("https://") {
        refusals.add(
            ErrorCode::Publisher,
            "metadata.publisher",
            "publisher must be an https URL",
        );
    }
}

fn check_field(refusals: &mut Refusals, field: &FieldDefinition, path: &str) {
    if !is_identifier(&field.id) {
        refusals.add(
            ErrorCode::FieldId,
            &format!("{path}.id"),
            format!("field id `{}` is not an identifier", field.id),
        );
    }
    check_text(
        refusals,
        &field.label,
        &format!("{path}.label"),
        MAX_LABEL_CHARS,
    );

    if field.repeats() && field.field_type.shape() == FieldShape::Record {
        refusals.add(
            ErrorCode::Multiple,
            &format!("{path}.multiple"),
            "record-shaped fields cannot repeat",
        );
    }
    check_options(refusals, field, path);

    // A definition is shared and synced. A default on a concealed field would
    // put a secret into the shared artefact, so it is refused outright rather
    // than stripped (ADR 0087 §5).
    if field.default.is_some() && field.field_type.concealed() {
        refusals.add(
            ErrorCode::ConcealedDefault,
            &format!("{path}.default"),
            format!(
                "`{}` is concealed and cannot carry a default",
                field.field_type.as_str()
            ),
        );
    }
}

fn check_options(refusals: &mut Refusals, field: &FieldDefinition, path: &str) {
    let is_select = field.field_type == FieldTypeId::Select;
    let options_path = format!("{path}.options");
    match &field.options {
        None if is_select => {
            refusals.add(
                ErrorCode::Options,
                &options_path,
                "`select` requires options",
            );
        }
        None => {}
        Some(options) => {
            if !is_select {
                refusals.add(
                    ErrorCode::Options,
                    &options_path,
                    "only `select` takes options",
                );
            }
            if options.is_empty() || options.len() > MAX_OPTIONS {
                refusals.add(
                    ErrorCode::Options,
                    &options_path,
                    format!("between 1 and {MAX_OPTIONS} options"),
                );
            }
            let unique: BTreeSet<&String> = options.iter().collect();
            if unique.len() != options.len() {
                refusals.add(ErrorCode::Options, &options_path, "options must be unique");
            }
        }
    }
}

fn check_sections(refusals: &mut Refusals, definition: &ItemTypeDefinition) {
    let sections = &definition.spec.sections;
    if sections.is_empty() || sections.len() > MAX_SECTIONS {
        refusals.add(
            ErrorCode::Sections,
            "spec.sections",
            format!("between 1 and {MAX_SECTIONS} sections"),
        );
    }
    let mut seen_sections: BTreeSet<&str> = BTreeSet::new();
    let mut seen_fields: BTreeSet<&str> = BTreeSet::new();
    let mut field_count = 0usize;
    for (index, section) in sections.iter().enumerate() {
        let path = format!("spec.sections[{index}]");
        if !is_lower_slug(&section.id, 1) || section.id.len() > 48 {
            refusals.add(
                ErrorCode::Sections,
                &format!("{path}.id"),
                format!("section id `{}` is not a slug", section.id),
            );
        }
        if !seen_sections.insert(section.id.as_str()) {
            refusals.add(
                ErrorCode::Sections,
                &format!("{path}.id"),
                format!("duplicate section id `{}`", section.id),
            );
        }
        check_text(
            refusals,
            &section.title,
            &format!("{path}.title"),
            MAX_LABEL_CHARS,
        );
        if section.fields.is_empty() {
            refusals.add(
                ErrorCode::Sections,
                &format!("{path}.fields"),
                "a section needs a field",
            );
        }
        for (field_index, field) in section.fields.iter().enumerate() {
            field_count += 1;
            check_field(refusals, field, &format!("{path}.fields[{field_index}]"));
            if !seen_fields.insert(field.id.as_str()) {
                refusals.add(
                    ErrorCode::DuplicateField,
                    &format!("{path}.fields[{field_index}].id"),
                    format!("duplicate field id `{}`", field.id),
                );
            }
        }
    }
    if field_count > MAX_FIELDS {
        refusals.add(
            ErrorCode::Sections,
            "spec.sections",
            format!("a definition may declare at most {MAX_FIELDS} fields"),
        );
    }
}

fn check_native(refusals: &mut Refusals, definition: &ItemTypeDefinition) {
    let native = &definition.spec.native;
    if let Some(secret) = native.secret.as_deref() {
        match definition.field(secret) {
            None => refusals.add(
                ErrorCode::NativeSecret,
                "spec.native.secret",
                format!("no field `{secret}`"),
            ),
            Some(field) if field.field_type.shape() == FieldShape::Record => refusals.add(
                ErrorCode::NativeSecret,
                "spec.native.secret",
                "line one holds one value; a record-shaped field cannot be the secret",
            ),
            Some(field) if field.repeats() => refusals.add(
                ErrorCode::NativeSecret,
                "spec.native.secret",
                "line one holds one value; a repeating field cannot be the secret",
            ),
            Some(_) => {}
        }
    }
    if native.trailer.len() > MAX_FIELDS {
        refusals.add(
            ErrorCode::Trailer,
            "spec.native.trailer",
            format!("at most {MAX_FIELDS} mappings"),
        );
    }
    let mut seen: BTreeSet<&str> = BTreeSet::new();
    for (index, mapping) in native.trailer.iter().enumerate() {
        let path = format!("spec.native.trailer[{index}]");
        if !is_trailer_key(&mapping.key) {
            refusals.add(
                ErrorCode::Trailer,
                &format!("{path}.key"),
                format!("trailer key `{}` is not a slug", mapping.key),
            );
        }
        if !seen.insert(mapping.key.as_str()) {
            refusals.add(
                ErrorCode::Trailer,
                &format!("{path}.key"),
                format!("duplicate trailer key `{}`", mapping.key),
            );
        }
        if definition.field(&mapping.field).is_none() {
            refusals.add(
                ErrorCode::Trailer,
                &format!("{path}.field"),
                format!("no field `{}`", mapping.field),
            );
        }
        if native.secret.as_deref() == Some(mapping.field.as_str()) {
            refusals.add(
                ErrorCode::Trailer,
                &format!("{path}.field"),
                "the secret field is line one and cannot repeat in the trailer",
            );
        }
    }
}

fn check_preview(
    refusals: &mut Refusals,
    definition: &ItemTypeDefinition,
    ids: &[String],
    path: &str,
) {
    for id in ids {
        let Some(field) = definition.field(id) else {
            refusals.add(
                ErrorCode::ConcealedPreview,
                path,
                format!("no field `{id}`"),
            );
            continue;
        };
        // The item list, the search haystack and the VFS filename all render
        // with no reveal gesture. Filtering silently would leave the author
        // believing it worked (ADR 0087 §5).
        if field.field_type.concealed() {
            refusals.add(
                ErrorCode::ConcealedPreview,
                path,
                format!("`{id}` is concealed and cannot appear in {path}"),
            );
        }
    }
}

fn check_spec_text(refusals: &mut Refusals, definition: &ItemTypeDefinition) {
    let spec = &definition.spec;
    check_text(refusals, &spec.title, "spec.title", MAX_LABEL_CHARS);
    check_text(refusals, &spec.plural, "spec.plural", MAX_LABEL_CHARS);
    check_text(refusals, &spec.summary, "spec.summary", MAX_SUMMARY_CHARS);
    if !is_extension(&spec.extension) {
        refusals.add(
            ErrorCode::Extension,
            "spec.extension",
            "extension must be a leading dot and up to 12 lowercase characters",
        );
    }
    for category in &spec.categories {
        if !is_lower_slug(category, 1) || category.len() > 32 {
            refusals.add(
                ErrorCode::Text,
                "spec.categories",
                format!("`{category}` is not a slug"),
            );
        }
    }
}

fn check_handler(refusals: &mut Refusals, definition: &ItemTypeDefinition, trust: Trust) {
    if definition.spec.handler.is_none() {
        return;
    }
    if trust != Trust::Platform || definition.metadata.publisher != PLATFORM_PUBLISHER {
        refusals.add(
            ErrorCode::Handler,
            "spec.handler",
            "only a platform-published definition may name a ceremony handler",
        );
    }
}

/// Parse and validate a definition from JSON text.
///
/// # Errors
///
/// Returns every refusal the definition drew: a size or syntax failure on its
/// own, or the full list of semantic rules it broke.
pub fn parse_definition(text: &str, trust: Trust) -> Result<ItemTypeDefinition, DefinitionErrors> {
    if text.len() > MAX_DEFINITION_BYTES {
        return Err(DefinitionErrors(vec![DefinitionError {
            code: ErrorCode::TooLarge,
            path: String::new(),
            message: format!("definition exceeds {MAX_DEFINITION_BYTES} bytes"),
        }]));
    }
    let definition: ItemTypeDefinition = match serde_json::from_str(text) {
        Ok(parsed) => parsed,
        Err(error) => {
            // Serde reports an unrecognised key and a malformed document
            // through the same channel; the message distinguishes them, and
            // both are a refusal either way.
            let code = if error.to_string().contains("unknown field") {
                ErrorCode::UnknownField
            } else {
                ErrorCode::Syntax
            };
            return Err(DefinitionErrors(vec![DefinitionError {
                code,
                path: String::new(),
                message: error.to_string(),
            }]));
        }
    };
    validate(&definition, trust)?;
    Ok(definition)
}

/// Apply the rejection table to an already-deserialised definition.
///
/// # Errors
///
/// Returns every semantic rule the definition breaks.
pub fn validate(definition: &ItemTypeDefinition, trust: Trust) -> Result<(), DefinitionErrors> {
    let mut refusals = Refusals(Vec::new());
    check_metadata(&mut refusals, definition);
    check_spec_text(&mut refusals, definition);
    check_sections(&mut refusals, definition);
    check_native(&mut refusals, definition);
    check_preview(
        &mut refusals,
        definition,
        &definition.spec.subtitle,
        "spec.subtitle",
    );
    check_preview(
        &mut refusals,
        definition,
        &definition.spec.search,
        "spec.search",
    );
    check_handler(&mut refusals, definition, trust);
    if refusals.0.is_empty() {
        Ok(())
    } else {
        Err(DefinitionErrors(refusals.0))
    }
}
