//! Errors in the two shapes Bitwarden clients read.
//!
//! The API speaks ASP.NET's `ErrorResponseModel`; the identity endpoint speaks
//! OAuth's `{error, error_description}` with an `ErrorModel` beside it. Clients
//! print `ValidationErrors` first and `Message` otherwise, so the text here is
//! what a person sees in `bw` or the web vault.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

/// A failed API call.
#[derive(Debug)]
pub struct ApiError {
    status: StatusCode,
    message: String,
    /// `Some` for an OAuth-shaped identity error: (`error`, `error_description`).
    oauth: Option<(&'static str, &'static str)>,
}

impl ApiError {
    #[must_use]
    pub fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
            oauth: None,
        }
    }

    #[must_use]
    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, message)
    }

    #[must_use]
    pub fn not_found() -> Self {
        Self::new(StatusCode::NOT_FOUND, "Resource not found.")
    }

    #[must_use]
    pub fn unauthorized() -> Self {
        Self::new(StatusCode::UNAUTHORIZED, "Unauthorized.")
    }

    /// The one answer for a wrong password *and* an unknown email.
    #[must_use]
    pub fn invalid_grant() -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message: "Username or password is incorrect. Try again.".into(),
            oauth: Some(("invalid_grant", "invalid_username_or_password")),
        }
    }

    /// An identity-endpoint refusal other than a bad credential.
    #[must_use]
    pub fn oauth(error: &'static str, message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message: message.into(),
            oauth: Some((error, error)),
        }
    }

    /// The password the caller proved does not match.
    #[must_use]
    pub fn invalid_password() -> Self {
        Self::bad_request("Invalid password.")
    }

    #[must_use]
    pub fn status(&self) -> StatusCode {
        self.status
    }

    /// Log an internal failure and answer with a message that discloses nothing.
    #[must_use]
    pub fn internal(error: &anyhow::Error) -> Self {
        tracing::error!(error = %error, "bitwarden-compat request failed");
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, "An error has occurred.")
    }
}

impl From<anyhow::Error> for ApiError {
    fn from(error: anyhow::Error) -> Self {
        Self::internal(&error)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let body = match self.oauth {
            Some((error, description)) => json!({
                "error": error,
                "error_description": description,
                "ErrorModel": { "Message": self.message, "Object": "error" },
            }),
            // A 400 is a model-state failure in ASP.NET's words; clients
            // show the first validation error, which carries the real text.
            None if self.status == StatusCode::BAD_REQUEST => json!({
                "message": "The model state is invalid.",
                "validationErrors": { "": [self.message] },
                "exceptionMessage": null,
                "exceptionStackTrace": null,
                "innerExceptionMessage": null,
                "object": "error",
            }),
            None => json!({
                "message": self.message,
                "validationErrors": null,
                "exceptionMessage": null,
                "exceptionStackTrace": null,
                "innerExceptionMessage": null,
                "object": "error",
            }),
        };
        (self.status, Json(body)).into_response()
    }
}

pub type ApiResult<T> = Result<T, ApiError>;
