//! Where a request says it is going, and whether its three statements of that
//! agree.
//!
//! A tunnelled request names its destination three times: the CONNECT
//! authority, the TLS server name, and the inner `Host` header (plus the
//! request target, when a client sends it in absolute form). ADR 0150 §6.1
//! requires them to agree. A disagreement is a request shaped to make the
//! proxy check one host and the upstream serve another, so it is refused
//! before anything reads the request, let alone a ledger.

use std::net::IpAddr;

use hyper::http::request::Parts;
use hyper::Uri;

const HTTPS_PORT: u16 = 443;
const HTTP_PORT: u16 = 80;

/// A destination: a lowercased DNS name or an IP literal (no brackets), and
/// a port.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Target {
    pub(crate) host: String,
    pub(crate) port: u16,
}

impl Target {
    /// The authority of a `CONNECT host:port`. A missing port is 443.
    pub(crate) fn parse_connect(uri: &Uri) -> Option<Self> {
        if uri.scheme().is_some() || uri.path_and_query().is_some_and(|p| p.as_str() != "/") {
            return None;
        }
        Self::from_authority(uri.authority()?.as_str(), HTTPS_PORT)
    }

    /// The authority of an absolute-form `http://…` request to the proxy.
    pub(crate) fn parse_absolute_http(uri: &Uri) -> Option<Self> {
        if !uri.scheme_str()?.eq_ignore_ascii_case("http") {
            return None;
        }
        Self::from_authority(uri.authority()?.as_str(), HTTP_PORT)
    }

    fn from_authority(authority: &str, default_port: u16) -> Option<Self> {
        // Userinfo is never honoured: it is a credential in a string.
        if authority.contains('@') {
            return None;
        }
        let (host, port) = split_host_port(authority)?;
        let port = match port {
            Some(port) => port.parse::<u16>().ok().filter(|p| *p != 0)?,
            None => default_port,
        };
        let host = normalize_host(host)?;
        Some(Self { host, port })
    }

    fn is_ip(&self) -> bool {
        self.host.parse::<IpAddr>().is_ok()
    }

    /// The port as [`RequestView`](opensesame_invoke_through::RequestView)
    /// wants it: `None` for the scheme's default.
    pub(crate) fn view_port(&self, default_port: u16) -> Option<u16> {
        (self.port != default_port).then_some(self.port)
    }

    /// `host[:port]` for a URL, bracketing an IPv6 literal.
    pub(crate) fn authority(&self) -> String {
        let host = if self.host.contains(':') {
            format!("[{}]", self.host)
        } else {
            self.host.clone()
        };
        if self.port == HTTPS_PORT {
            host
        } else {
            format!("{host}:{}", self.port)
        }
    }

    /// The host as a URL writes it, bracketing an IPv6 literal.
    pub(crate) fn authority_host(&self) -> String {
        if self.host.contains(':') {
            format!("[{}]", self.host)
        } else {
            self.host.clone()
        }
    }

    /// The TLS server name must name the CONNECT host. An IP literal is never
    /// a server name (RFC 6066 §3), so for one the name must be absent.
    pub(crate) fn sni_agrees(&self, sni: Option<&str>) -> bool {
        match sni {
            Some(name) => !self.is_ip() && name.eq_ignore_ascii_case(&self.host),
            None => self.is_ip(),
        }
    }

    /// The inner request's `Host` (required, exactly one) and any absolute
    /// request target must name this host and port.
    pub(crate) fn request_agrees(&self, parts: &Parts) -> bool {
        let mut hosts = parts.headers.get_all(hyper::header::HOST).iter();
        let (Some(host), None) = (hosts.next(), hosts.next()) else {
            return false;
        };
        let named = host
            .to_str()
            .ok()
            .and_then(|value| Self::from_authority(value, HTTPS_PORT));
        if named.as_ref() != Some(self) {
            return false;
        }
        match parts.uri.authority() {
            None => true,
            Some(authority) => {
                parts.uri.scheme_str() == Some("https")
                    && Self::from_authority(authority.as_str(), HTTPS_PORT).as_ref() == Some(self)
            }
        }
    }
}

fn split_host_port(authority: &str) -> Option<(&str, Option<&str>)> {
    if let Some(rest) = authority.strip_prefix('[') {
        let (host, after) = rest.split_once(']')?;
        return match after {
            "" => Some((host, None)),
            _ => Some((host, Some(after.strip_prefix(':')?))),
        };
    }
    match authority.split_once(':') {
        Some((host, port)) => Some((host, Some(port))),
        None => Some((authority, None)),
    }
}

/// A lowercased DNS name of letters, digits and hyphens in 1–63 character
/// labels (at most 253 in all), or an IP literal. Anything else — an empty
/// label, an underscore, a trailing dot, non-ASCII — is not a host this proxy
/// will mint a certificate for or name upstream.
pub(crate) fn normalize_host(host: &str) -> Option<String> {
    if let Ok(ip) = host.parse::<IpAddr>() {
        return Some(ip.to_string());
    }
    let host = host.to_ascii_lowercase();
    let valid = !host.is_empty()
        && host.len() <= 253
        && host.split('.').all(|label| {
            (1..=63).contains(&label.len())
                && label
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        });
    valid.then_some(host)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn connect(authority: &str) -> Option<Target> {
        Target::parse_connect(&authority.parse::<Uri>().ok()?)
    }

    fn parts(uri: &str, hosts: &[&str]) -> Parts {
        let mut builder = hyper::Request::builder().uri(uri);
        for host in hosts {
            builder = builder.header("host", *host);
        }
        builder.body(()).unwrap().into_parts().0
    }

    #[test]
    fn connect_authorities_parse_to_a_lowercased_host_and_port() {
        let target = connect("API.GitHub.com:443").unwrap();
        assert_eq!((target.host.as_str(), target.port), ("api.github.com", 443));
        assert_eq!(target.view_port(443), None);
        assert_eq!(connect("h.test:8443").unwrap().view_port(443), Some(8443));
        assert_eq!(connect("[::1]:443").unwrap().authority(), "[::1]");
        assert!(connect("user:pw@h.test:443").is_none());
        assert!(connect("h_x.test:443").is_none());
        assert!(connect("h.test:0").is_none());
    }

    #[test]
    fn sni_must_name_the_connect_host_and_is_absent_for_an_ip() {
        let named = connect("api.github.com:443").unwrap();
        assert!(named.sni_agrees(Some("API.github.com")));
        assert!(!named.sni_agrees(Some("evil.test")));
        assert!(!named.sni_agrees(None));
        let ip = connect("127.0.0.1:443").unwrap();
        assert!(ip.sni_agrees(None));
        assert!(!ip.sni_agrees(Some("127.0.0.1")));
    }

    #[test]
    fn the_host_header_must_name_the_connect_host_once() {
        let target = connect("api.github.com:443").unwrap();
        assert!(target.request_agrees(&parts("/user", &["api.github.com"])));
        assert!(target.request_agrees(&parts("/user", &["api.github.com:443"])));
        assert!(!target.request_agrees(&parts("/user", &["evil.test"])));
        assert!(!target.request_agrees(&parts("/user", &["api.github.com:8443"])));
        assert!(!target.request_agrees(&parts("/user", &[])));
        assert!(!target.request_agrees(&parts("/user", &["api.github.com", "api.github.com"])));
        assert!(!target.request_agrees(&parts("https://evil.test/user", &["api.github.com"])));
    }
}
