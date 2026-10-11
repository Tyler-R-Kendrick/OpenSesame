//! How a hosted model API is spoken to (ADR 0192 §2): the closed set of
//! protocols an `ai_model_provider` catalog row may name, and the load-time
//! check that keeps a row's endpoint inside its own egress.
//!
//! A child module of [`crate::catalog`], which re-exports [`ModelApiSpec`] and
//! [`ModelProtocol`] — the catalog stays the one place a caller reads them from.

use serde::{Deserialize, Serialize};

use super::{provider_error, validate_provider_url, AuthMethod, CatalogError, Category, Provider};

/// The closed set of request shapes a hosted model API speaks (ADR 0192 §2).
/// A row names one of these; it never supplies a path or a header, so a
/// catalog row cannot teach the broker a new way to reach a host.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelProtocol {
    /// `POST {base_url}/chat/completions`, `Authorization: Bearer`.
    OpenaiChat,
    /// `POST {base_url}/messages`, `x-api-key` and `anthropic-version`.
    AnthropicMessages,
    /// `POST {base_url}/models/{model}:generateContent`.
    GeminiGenerateContent,
    /// Provider-native REST with no shape the broker can read a model from.
    /// A key for such a row narrows by path and method, never by model.
    RestJson,
}

impl ModelProtocol {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::OpenaiChat => "openai_chat",
            Self::AnthropicMessages => "anthropic_messages",
            Self::GeminiGenerateContent => "gemini_generate_content",
            Self::RestJson => "rest_json",
        }
    }
}

/// How an `ai_model_provider` row is spoken to. `base_url` is absent when the
/// endpoint is the person's own (a `configuration` row such as a self-hosted
/// gateway), and present, inside the row's egress, when it is fixed.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ModelApiSpec {
    pub protocol: ModelProtocol,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
}

/// An `ai_model_provider` row says how it is spoken to; no other row may. A
/// fixed `base_url` must sit inside the row's own egress, so naming one can
/// never reach a host the egress rule does not already allow.
pub(super) fn validate_model_api(provider: &Provider) -> Result<(), CatalogError> {
    let is_model_row = provider.category == Category::AiModelProvider;
    let Some(api) = &provider.model_api else {
        if is_model_row {
            return Err(provider_error(
                provider,
                "an ai_model_provider row needs model_api",
            ));
        }
        return Ok(());
    };
    if !is_model_row {
        return Err(provider_error(
            provider,
            "model_api is only valid on ai_model_provider rows",
        ));
    }
    let fixed = !matches!(provider.auth, AuthMethod::Configuration);
    match (&api.base_url, fixed) {
        (Some(url), true) => {
            validate_provider_url(provider, url, "model_api.base_url")?;
            if url.ends_with('/') {
                return Err(provider_error(
                    provider,
                    "model_api.base_url must not end with /",
                ));
            }
            // The trailing slash puts the base on a segment boundary, which is
            // how a `/v1/` prefix names the directory it contains.
            provider
                .egress
                .binding()
                .allows_url(&format!("{url}/"))
                .map_err(|_| {
                    provider_error(
                        provider,
                        "model_api.base_url must sit inside the provider egress".to_string(),
                    )
                })?;
        }
        (None, true) => {
            return Err(provider_error(
                provider,
                "a model row with a fixed endpoint needs model_api.base_url",
            ));
        }
        (Some(_), false) => {
            return Err(provider_error(
                provider,
                "a configuration model row names its endpoint at connect time",
            ));
        }
        (None, false) => {}
    }
    Ok(())
}

#[cfg(test)]
#[path = "model_api_tests.rs"]
mod tests;
