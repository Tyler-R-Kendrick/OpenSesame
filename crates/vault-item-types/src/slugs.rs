//! The shapes a definition's identifiers must take (ADR 0087 §5). The
//! TypeScript parser states the same rules as regular expressions in
//! `packages/vault-item-types/src/validate.ts`;
//! `spec/conformance/item-type-cases.json` holds the two together.

pub(crate) fn is_lower_slug(value: &str, min_len: usize) -> bool {
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

pub(crate) fn is_identifier(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    value.len() <= 48
        && first.is_ascii_alphabetic()
        && value.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

pub(crate) fn is_trailer_key(value: &str) -> bool {
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

pub(crate) fn is_semver(value: &str) -> bool {
    let parts: Vec<&str> = value.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_digit()))
}

pub(crate) fn is_extension(value: &str) -> bool {
    let Some(rest) = value.strip_prefix('.') else {
        return false;
    };
    !rest.is_empty()
        && rest.len() <= 12
        && rest
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
}
