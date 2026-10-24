//! One `AssumeRole` call through invoke-through.
//!
//! The fences are invoke-through's: the single-host egress rule from
//! [`super::endpoint`], no redirect followed (a 3xx is refused here as an
//! answer that cannot be trusted), a capped body, a timeout, and the response
//! scrubbed of the source secret. There is no retry: an `AccessDenied` is
//! final, and a throttled or unreachable STS is the caller's to try again.

use std::time::Duration;

use bytes::Bytes;
use chrono::{DateTime, Utc};
use opensesame_invoke_through::{InvokeError, InvokeRequest, Invoker};

use super::endpoint::{StsEndpoint, STS_PROVIDER};
use super::request::AssumeRoleRequest;
use super::response::{self, StsCredentials};
use super::signer::SigV4Signer;
use super::StsFailure;

/// STS's answers are a few kilobytes; a larger body is not one of them.
pub const RESPONSE_CAP: usize = 16 * 1024;
/// The whole call, connect to last byte.
pub const TIMEOUT: Duration = Duration::from_secs(10);

/// What a successful mint obtained.
#[derive(Debug)]
pub struct AssumedRole {
    pub credentials: StsCredentials,
    pub request_id: String,
}

/// The invoker for one endpoint: its single rule, the STS caps, and loopback
/// HTTP only when the endpoint is a test override.
#[must_use]
pub fn invoker_for(endpoint: &StsEndpoint) -> Invoker {
    let invoker = Invoker::with_rules(vec![endpoint.rule])
        .with_caps(
            opensesame_invoke_through::DEFAULT_REQUEST_BODY_CAP,
            RESPONSE_CAP,
        )
        .with_timeout(TIMEOUT);
    if endpoint.loopback {
        invoker.allow_http_for_tests()
    } else {
        invoker
    }
}

/// Assume the role: sign, send, read, check.
///
/// # Errors
///
/// One [`StsFailure`] per way it can fail; none carries the response.
pub async fn assume_role(
    invoker: &Invoker,
    endpoint: &StsEndpoint,
    signer: &SigV4Signer,
    request: &AssumeRoleRequest,
    now: DateTime<Utc>,
) -> Result<AssumedRole, StsFailure> {
    let body = request.form_body();
    let prepared = invoker
        .preflight(InvokeRequest {
            provider_id: STS_PROVIDER.into(),
            method: "POST".into(),
            url: endpoint.url.clone(),
            headers: vec![(
                "content-type".into(),
                "application/x-www-form-urlencoded; charset=utf-8".into(),
            )],
            body: Some(Bytes::copy_from_slice(body.as_bytes())),
            subject: None,
            actor: None,
        })
        .map_err(|_| StsFailure::Unreachable)?;
    drop(body);
    let response = invoker
        .execute_signed(signer, prepared)
        .await
        .map_err(|error| match error {
            InvokeError::ResponseTooLarge { .. } => StsFailure::MalformedResponse,
            InvokeError::MalformedToken => StsFailure::ExpiredSource,
            _ => StsFailure::Unreachable,
        })?;
    if response.receipt.credential_reflected {
        return Err(StsFailure::MalformedResponse);
    }
    match response.status {
        200 => {}
        // A redirect is never followed, and no other non-error status is an
        // answer to AssumeRole.
        status if status < 400 => return Err(StsFailure::MalformedResponse),
        status => {
            let code = response::error_code(&response.body);
            return Err(response::classify(status, code.as_deref()));
        }
    }
    let answer = response::parse_assume_role(&response.body)?;
    response::check_expiration(answer.credentials.expiration, now, request.duration_seconds)?;
    Ok(AssumedRole {
        credentials: answer.credentials,
        request_id: answer.request_id,
    })
}

#[cfg(test)]
#[path = "client_tests.rs"]
mod tests;
