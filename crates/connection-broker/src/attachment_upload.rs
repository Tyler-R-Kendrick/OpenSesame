//! Load-time check on a catalog row's `attachment_upload` descriptor (ADR 0032
//! §3): the shape a storage provider receives sealed ciphertext in.
//!
//! A child module of [`crate::catalog`], split out of it so the catalog loader
//! stays under the structural size budget; the descriptor's types stay there.

use super::{provider_error, validate_provider_url, CatalogError, PathPlacement, Provider};

pub(super) fn validate_attachment_upload(provider: &Provider) -> Result<(), CatalogError> {
    let Some(shape) = &provider.attachment_upload else {
        return Ok(());
    };
    validate_provider_url(provider, &shape.url, "attachment_upload.url")?;
    // A descriptor can never widen egress: its URL must already be inside
    // the row's egress binding.
    provider
        .egress
        .binding()
        .allows_url(&shape.url)
        .map_err(|_| {
            provider_error(
                provider,
                "attachment_upload.url must sit inside the provider egress".to_string(),
            )
        })?;
    match &shape.path_placement {
        PathPlacement::HeaderJson { header, template } => {
            if header.is_empty()
                || header.len() > 64
                || !header
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-')
            {
                return Err(provider_error(
                    provider,
                    "attachment_upload header must be an HTTP token".to_string(),
                ));
            }
            if !template.contains("{path}") {
                return Err(provider_error(
                    provider,
                    "attachment_upload template must contain {path}".to_string(),
                ));
            }
            let rendered = template.replace("{path}", "probe");
            if serde_json::from_str::<serde_json::Value>(&rendered).is_err() {
                return Err(provider_error(
                    provider,
                    "attachment_upload template must render to JSON".to_string(),
                ));
            }
        }
        PathPlacement::UrlPath { prefix } => {
            if !prefix.starts_with('/') {
                return Err(provider_error(
                    provider,
                    "attachment_upload prefix must start with /".to_string(),
                ));
            }
        }
        PathPlacement::Query { param } => {
            if param.is_empty() || !param.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
                return Err(provider_error(
                    provider,
                    "attachment_upload query param must be alphanumeric".to_string(),
                ));
            }
        }
    }
    for (name, _) in &shape.extra_headers {
        if name.eq_ignore_ascii_case("authorization") || name.eq_ignore_ascii_case("cookie") {
            return Err(provider_error(
                provider,
                "attachment_upload may not carry credential headers".to_string(),
            ));
        }
    }
    Ok(())
}
