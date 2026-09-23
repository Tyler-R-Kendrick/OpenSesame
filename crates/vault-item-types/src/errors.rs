//! The refusal vocabulary (ADR 0087 §5): the codes a definition or an install
//! is turned away with, spelled as the TypeScript parser spells them so the
//! two rejection tables compare row for row.

use std::fmt;

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
    Name,
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
            Self::Name => "name",
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
