//! Talking to the trusted corpora.
//!
//! The only I/O in the breach plane. [`opensesame_breach_intel`] decides what a
//! response means; this module fetches it, and is deliberately the *whole*
//! network surface so that "what leaves the host" is one file to read.
//!
//! Two requests exist, and neither one carries anything about a tenant:
//!
//! - [`password_occurrences`] sends five hexadecimal characters of a SHA-1 and
//!   asks for padding, so the response size reveals nothing either.
//! - [`catalogue`] fetches a public, unauthenticated list and asks nothing.
//!
//! Redirects are never followed. A corpus that starts redirecting is a corpus
//! whose operator changed, and chasing one would let today's trusted host hand
//! us tomorrow's untrusted one.

use std::time::Duration;

use opensesame_breach_intel::{
    catalogue as intel_catalogue, occurrences, range_url, Breach, PwnedDigest, PADDING_HEADER,
    PADDING_VALUE,
};

/// Per-request timeout.
pub const REQUEST_TIMEOUT_SECONDS: u64 = 15;

/// `User-Agent` the corpora see. Both publishers ask for an identifying one.
pub const USER_AGENT: &str = "OpenSesame-breach-scanner";

/// Largest catalogue body we will parse.
///
/// The published catalogue is a few hundred kilobytes. The cap is not a
/// performance guard: it is what stops a compromised or impersonated source
/// from making a scan pass allocate without bound.
pub const MAX_CATALOGUE_BYTES: usize = 16 * 1024 * 1024;

fn client() -> anyhow::Result<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECONDS))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(USER_AGENT)
        .build()
        .map_err(|error| anyhow::anyhow!("breach http client: {error}"))
}

/// How many times a secret appears in the Pwned Passwords corpus.
///
/// Zero means not found. The digest's suffix never leaves this process: the
/// URL is built from the prefix alone, and the match is done here against the
/// bucket the service returned.
///
/// # Errors
///
/// Returns an error when the request fails or the service answers with a
/// non-success status. A failure is never reported as "not breached" — the
/// caller publishes `breach.scan.failed` instead, because silently downgrading
/// an unreachable corpus to a clean bill of health is the one outcome this
/// whole subsystem exists to prevent.
pub async fn password_occurrences(digest: &PwnedDigest) -> anyhow::Result<u64> {
    let response = client()?
        .get(range_url(digest))
        .header(PADDING_HEADER, PADDING_VALUE)
        .send()
        .await
        .map_err(|error| anyhow::anyhow!("range request failed: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        anyhow::bail!("range endpoint returned {status}");
    }
    let body = response
        .text()
        .await
        .map_err(|error| anyhow::anyhow!("range response unreadable: {error}"))?;
    Ok(occurrences(&body, digest))
}

/// The published breach catalogue.
///
/// # Errors
///
/// Returns an error when the request fails, the body exceeds
/// [`MAX_CATALOGUE_BYTES`], or the body is not a catalogue.
pub async fn catalogue() -> anyhow::Result<Vec<Breach>> {
    let response = client()?
        .get(intel_catalogue::CATALOGUE_URL)
        .header("accept", "application/json")
        .send()
        .await
        .map_err(|error| anyhow::anyhow!("catalogue request failed: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        anyhow::bail!("catalogue endpoint returned {status}");
    }
    let body = response
        .text()
        .await
        .map_err(|error| anyhow::anyhow!("catalogue response unreadable: {error}"))?;
    if body.len() > MAX_CATALOGUE_BYTES {
        anyhow::bail!(
            "catalogue response is {} bytes, over the {MAX_CATALOGUE_BYTES} byte cap",
            body.len(),
        );
    }
    intel_catalogue::parse_catalogue(&body)
        .map_err(|error| anyhow::anyhow!("catalogue did not parse: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_range_url_carries_the_prefix_and_never_the_suffix() {
        let digest = PwnedDigest::of_secret("password");
        let url = range_url(&digest);
        assert!(url.starts_with("https://api.pwnedpasswords.com/range/"));
        assert!(url.ends_with(digest.prefix()));
        assert!(!url.contains(digest.suffix()));
    }

    #[test]
    fn the_catalogue_url_is_the_public_unauthenticated_one() {
        assert_eq!(
            intel_catalogue::CATALOGUE_URL,
            "https://haveibeenpwned.com/api/v3/breaches",
        );
    }

    #[test]
    fn the_client_builds_with_the_fences_this_module_promises() {
        assert!(client().is_ok());
    }

    #[test]
    fn padding_is_requested_by_name_the_service_understands() {
        assert_eq!(PADDING_HEADER, "Add-Padding");
        assert_eq!(PADDING_VALUE, "true");
    }
}
