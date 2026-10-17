//! Signed requests: a credential that is a signature over the request.
//!
//! AWS Signature Version 4 never sends the secret key. The client computes an
//! HMAC over the method, path, query, a chosen set of headers and the body's
//! digest, and sends the result. So the broker cannot hand a signer a request
//! and then change it: whatever is signed must be exactly what goes on the
//! wire. [`Invoker::execute_signed`] builds the request first — method, URI,
//! the cleared caller headers, the default user agent, the body — shows those
//! parts to the [`RequestSigner`], adds the headers it returns, and sends
//! that, through the same response fences as a bearer call.
//!
//! The signer is supplied by the caller, so this crate gains no dependency;
//! the daemon never links one (ADR 0048 D5).

use std::time::Instant;

use http_body_util::Full;
use hyper::header::{HeaderName, HeaderValue};
use secrecy::{ExposeSecret, SecretString};

use crate::egress::AuthStyle;
use crate::error::InvokeError;
use crate::fence::PreparedRequest;
use crate::invoke::{InvokeResponse, Invoker};
use crate::scrub::Needles;

/// The parts of a cleared request a signer covers, exactly as they will be
/// sent.
pub struct SignableParts<'a> {
    pub method: &'a str,
    pub uri: String,
    /// Every header the request carries before signing, `host` excluded:
    /// the client derives it from the URI, and so does a `SigV4` signer.
    pub headers: Vec<(&'a str, &'a str)>,
    pub body: &'a [u8],
}

/// Computes the credential headers for one request.
///
/// Implementations hold the key and must keep it out of every error and log
/// line: the failure surface is [`InvokeError::MalformedToken`], which carries
/// nothing.
pub trait RequestSigner: Send + Sync {
    /// The headers to add — for `SigV4`, `authorization`, `x-amz-date` and,
    /// with a session credential, `x-amz-security-token`.
    ///
    /// # Errors
    ///
    /// [`InvokeError::MalformedToken`] when the request cannot be signed.
    fn sign(&self, parts: &SignableParts<'_>) -> Result<Vec<(String, String)>, InvokeError>;

    /// Every secret the upstream must never echo back. The response is
    /// scrubbed of each, exactly as a bearer call is scrubbed of its token.
    fn reflection_secrets(&self) -> Vec<&SecretString>;
}

impl Invoker {
    /// Execute a preflighted request whose rule signs rather than bears.
    ///
    /// # Errors
    ///
    /// `UnsupportedProvider` when the cleared rule is not [`AuthStyle::SigV4`],
    /// `MalformedToken` when the signer refuses or returns an unusable header,
    /// and every failure [`Invoker::execute`] can return on the wire.
    pub async fn execute_signed(
        &self,
        signer: &dyn RequestSigner,
        prepared: PreparedRequest,
    ) -> Result<InvokeResponse, InvokeError> {
        if prepared.auth != AuthStyle::SigV4 {
            return Err(InvokeError::UnsupportedProvider(prepared.provider_id));
        }
        let started = Instant::now();
        let builder = Self::request_builder(&prepared);
        let unsigned = builder
            .body(Full::new(prepared.body.clone()))
            .map_err(|_| InvokeError::InvalidUrl)?;
        let headers: Vec<(&str, &str)> = unsigned
            .headers()
            .iter()
            .filter_map(|(name, value)| Some((name.as_str(), value.to_str().ok()?)))
            .collect();
        let added = signer.sign(&SignableParts {
            method: prepared.method.as_str(),
            uri: prepared.uri.to_string(),
            headers,
            body: &prepared.body,
        })?;
        let (mut parts, body) = unsigned.into_parts();
        for (name, value) in added {
            let name =
                HeaderName::from_bytes(name.as_bytes()).map_err(|_| InvokeError::MalformedToken)?;
            let mut value =
                HeaderValue::from_str(&value).map_err(|_| InvokeError::MalformedToken)?;
            value.set_sensitive(true);
            parts.headers.insert(name, value);
        }
        let request = hyper::Request::from_parts(parts, body);
        let needles: Vec<Needles> = signer
            .reflection_secrets()
            .into_iter()
            .map(|secret| Needles::new(secret.expose_secret()))
            .collect();
        self.dispatch(request, &needles, prepared, started).await
    }
}

#[cfg(test)]
#[path = "signed_tests.rs"]
mod tests;
