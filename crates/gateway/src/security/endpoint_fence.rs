//! Where a hook may be delivered.
//!
//! The fence parses an endpoint with the same WHATWG parser reqwest sends
//! with, so a spelling one parser reads as a public name and the other as
//! `127.0.0.1` (`https://127.0.0.1\hook`, `%31%32%37.0.0.1`, full-width digits)
//! cannot slip between them. A name is resolved at send time and every answer
//! vetted, and the client is pinned to the vetted addresses so the connection
//! cannot land on a different answer than the one that was checked.
use std::net::SocketAddr;
use std::time::Duration;

use opensesame_connector_host::is_blocked_host;
use url::{Host, Url};

const NOT_HTTPS: &str = "endpoint is not an absolute https URL";
const BLOCKED: &str = "endpoint resolves to a private or metadata address";

/// Why a delivery client could not be built.
#[derive(Debug)]
pub enum Refusal {
    /// The destination is never deliverable.
    Blocked(String),
    /// The name did not resolve now; it may later.
    Unresolved(String),
}

/// The endpoint as reqwest will read it, when it is a legal destination.
///
/// # Errors
///
/// Returns the reason when the URL is not absolute HTTPS, carries
/// credentials, or names a loopback, private, link-local or metadata address.
pub fn parse_deliverable(endpoint: &str) -> Result<Url, String> {
    // `https:///path` is a host of `path` to a WHATWG parser; a delivery URL
    // that needs that reading is not one anybody meant.
    let after = endpoint.strip_prefix("https://").ok_or(NOT_HTTPS)?;
    if after.is_empty() || after.starts_with(['/', '\\']) {
        return Err(NOT_HTTPS.into());
    }
    let url = Url::parse(endpoint).map_err(|_| NOT_HTTPS.to_string())?;
    // Credentials in a delivery URL are a footgun and a secret in a column.
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
        return Err(NOT_HTTPS.into());
    }
    let blocked = match url.host() {
        Some(Host::Ipv4(ip)) => is_blocked_host(&ip.to_string()),
        Some(Host::Ipv6(ip)) => is_blocked_host(&ip.to_string()),
        Some(Host::Domain(name)) => is_blocked_host(name),
        None => return Err(NOT_HTTPS.into()),
    };
    if blocked {
        return Err(BLOCKED.into());
    }
    Ok(url)
}

/// Refuses when any resolved address is private or metadata.
fn vet(addrs: &[SocketAddr]) -> Result<(), Refusal> {
    if addrs.is_empty() {
        return Err(Refusal::Unresolved("endpoint did not resolve".into()));
    }
    if addrs
        .iter()
        .any(|addr| is_blocked_host(&addr.ip().to_string()))
    {
        return Err(Refusal::Blocked(BLOCKED.into()));
    }
    Ok(())
}

/// A client that can only reach the vetted addresses of `url`'s host.
///
/// # Errors
///
/// [`Refusal::Blocked`] when the endpoint or any address it resolves to is
/// not deliverable; [`Refusal::Unresolved`] when the name does not resolve.
pub async fn pinned_client(url: &Url, timeout: Duration) -> Result<reqwest::Client, Refusal> {
    let builder = reqwest::Client::builder()
        .timeout(timeout)
        // A redirect is a response, never a chase: following one would let an
        // allowed host hand us an address the fence already refused.
        .redirect(reqwest::redirect::Policy::none())
        // An environment proxy resolves the name itself, which would bypass
        // the addresses pinned below.
        .no_proxy();
    let builder = match url.host() {
        Some(Host::Domain(name)) => {
            let port = url.port_or_known_default().unwrap_or(443);
            let addrs: Vec<SocketAddr> = tokio::net::lookup_host((name, port))
                .await
                .map_err(|error| Refusal::Unresolved(format!("endpoint did not resolve: {error}")))?
                .collect();
            vet(&addrs)?;
            builder.resolve_to_addrs(name, &addrs)
        }
        Some(_) => builder,
        None => return Err(Refusal::Blocked(NOT_HTTPS.into())),
    };
    builder
        .build()
        .map_err(|error| Refusal::Unresolved(format!("http client: {error}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spellings_another_parser_reads_as_loopback_are_refused() {
        for refused in [
            "https://127.0.0.1\\hook",
            "https://%31%32%37.0.0.1/hook",
            "https://\u{ff11}\u{ff12}\u{ff17}.0.0.1/hook",
            "https://169.254.169.254\\latest",
            "https://0x7f.1/hook",
            "https:\\\\127.0.0.1/hook",
            "https:///127.0.0.1/hook",
        ] {
            assert!(
                parse_deliverable(refused).is_err(),
                "{refused} must be refused"
            );
        }
    }

    #[test]
    fn a_resolved_private_answer_is_refused() {
        let private: SocketAddr = "10.0.0.5:443".parse().unwrap();
        let public: SocketAddr = "93.184.216.34:443".parse().unwrap();
        assert!(matches!(vet(&[public, private]), Err(Refusal::Blocked(_))));
        assert!(matches!(vet(&[]), Err(Refusal::Unresolved(_))));
        assert!(vet(&[public]).is_ok());
    }

    #[test]
    fn the_pinned_client_never_uses_an_environment_proxy() {
        let src = include_str!("endpoint_fence.rs");
        let body = &src[src.find("pub async fn pinned_client").unwrap()..];
        assert!(body.contains(".no_proxy()"));
    }

    #[tokio::test]
    async fn a_name_that_resolves_to_loopback_gets_no_client() {
        // `localhost` never passes `parse_deliverable`; building the client for
        // it directly shows the resolver check stands on its own.
        let url = Url::parse("https://localhost/hook").unwrap();
        let refusal = pinned_client(&url, Duration::from_secs(1)).await;
        assert!(matches!(refusal, Err(Refusal::Blocked(_))), "{refusal:?}");
    }
}
