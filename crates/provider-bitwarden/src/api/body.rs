//! Admit response bytes before retaining them, regardless of HTTP framing.

use url::Url;

use crate::error::{Error, Result};

pub(super) async fn read(
    url: &Url,
    mut response: reqwest::Response,
    limit: usize,
    description: &str,
    context: &str,
) -> Result<Vec<u8>> {
    let exceeded = || Error::MalformedResponse {
        path: context.to_owned(),
        message: format!("{description} exceeded {limit} bytes"),
    };
    // A declared length can reject early, but cannot authorize retention:
    // chunked/decoded bodies may have no length, and headers are untrusted.
    let declared_limit = u64::try_from(limit).unwrap_or(u64::MAX);
    if response
        .content_length()
        .is_some_and(|length| length > declared_limit)
    {
        return Err(exceeded());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| super::transport(url, error))?
    {
        // Check before extending. Subtraction also avoids length overflow for
        // a caller-supplied limit near usize::MAX; never preallocate that cap.
        if chunk.len() > limit.saturating_sub(body.len()) {
            return Err(exceeded());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}
