//! The request as the runner intercepted it, and the destination it names.
//!
//! Parsing here is deliberately narrower than a URL library: the only
//! question is whether the request goes to the one origin and path the recipe
//! declared, and anything this parser does not understand is an answer of no.

use std::fmt;

/// One request the page sent, as the runner's egress hook saw it before it
/// left the sandbox (CDP `Fetch.requestPaused`, or the equivalent).
///
/// `url` is the full request URL; `headers` are every header the page set;
/// `body` is the complete, reassembled body. Content type and encoding are
/// read from `headers` rather than passed beside them, so the two can never
/// disagree about what the body is.
#[derive(Clone, Copy)]
pub struct LoginRequest<'a> {
    pub method: &'a str,
    pub url: &'a str,
    pub headers: &'a [(String, String)],
    pub body: &'a [u8],
}

/// Method, header names and the body's length. Not the URL, a header value or
/// the body: each is page-chosen, and a page that moved the surrogate into
/// one of them would otherwise have it printed by whatever logged the refusal.
impl fmt::Debug for LoginRequest<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let names: Vec<&str> = self.headers.iter().map(|(name, _)| name.as_str()).collect();
        f.debug_struct("LoginRequest")
            .field("method", &self.method)
            .field("headers", &names)
            .field("body_len", &self.body.len())
            .finish_non_exhaustive()
    }
}

/// An https origin: host and effective port. The scheme is not stored because
/// only https is ever declared — a login credential is not substituted into a
/// request anyone on the path can read.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LoginOrigin {
    host: String,
    port: u16,
}

impl LoginOrigin {
    /// Parse `https://host` or `https://host:port`, and nothing else: no path,
    /// no trailing slash, no user information, no other scheme. `None` for
    /// anything outside that shape.
    #[must_use]
    pub fn parse(origin: &str) -> Option<Self> {
        let (scheme, authority) = origin.split_once("://")?;
        if !scheme.eq_ignore_ascii_case("https") || authority.contains(['/', '?', '#']) {
            return None;
        }
        let (host, port) = split_authority(authority, 443)?;
        Some(Self { host, port })
    }

    #[must_use]
    pub fn host(&self) -> &str {
        &self.host
    }

    #[must_use]
    pub const fn port(&self) -> u16 {
        self.port
    }
}

impl fmt::Display for LoginOrigin {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.port == 443 {
            write!(f, "https://{}", self.host)
        } else {
            write!(f, "https://{}:{}", self.host, self.port)
        }
    }
}

/// A parsed request URL. `path` is empty when the URL had none; the fragment
/// is dropped, since it never reaches the wire.
pub(super) struct Target<'a> {
    pub(super) scheme: String,
    pub(super) host: String,
    pub(super) port: u16,
    pub(super) path: &'a str,
    pub(super) query: Option<&'a str>,
}

impl Target<'_> {
    /// `host` or `host:port`, for a refusal's detail.
    pub(super) fn authority(&self) -> String {
        format!("{}://{}:{}", self.scheme, self.host, self.port)
    }

    /// Whether this is exactly `origin`: https, the same host, the same
    /// effective port.
    pub(super) fn is_origin(&self, origin: &LoginOrigin) -> bool {
        self.scheme == "https" && self.host == origin.host && self.port == origin.port
    }
}

pub(super) fn parse_url(url: &str) -> Option<Target<'_>> {
    let (scheme, rest) = url.split_once("://")?;
    if scheme.is_empty() || !scheme.bytes().all(|b| b.is_ascii_alphabetic()) {
        return None;
    }
    let scheme = scheme.to_ascii_lowercase();
    let default_port = match scheme.as_str() {
        "https" => 443,
        "http" => 80,
        _ => return None,
    };
    let rest = rest.split_once('#').map_or(rest, |(before, _)| before);
    let authority_end = rest.find(['/', '?']).unwrap_or(rest.len());
    let (authority, path_and_query) = rest.split_at(authority_end);
    let (host, port) = split_authority(authority, default_port)?;
    let (path, query) = match path_and_query.split_once('?') {
        Some((path, query)) => (path, Some(query)),
        None => (path_and_query, None),
    };
    Some(Target {
        scheme,
        host,
        port,
        path,
        query,
    })
}

/// Host and effective port. User information is refused outright: a login
/// action URL never carries it, and `https://login.example@attacker.example`
/// is the oldest lookalike there is.
fn split_authority(authority: &str, default_port: u16) -> Option<(String, u16)> {
    if authority.contains('@') {
        return None;
    }
    let (host, port) = if let Some(rest) = authority.strip_prefix('[') {
        let (inner, after) = rest.split_once(']')?;
        if inner.is_empty() || !inner.bytes().all(|b| b.is_ascii_hexdigit() || b == b':') {
            return None;
        }
        let port = if after.is_empty() {
            None
        } else {
            Some(after.strip_prefix(':')?)
        };
        (format!("[{inner}]"), port)
    } else {
        let (host, port) = match authority.split_once(':') {
            Some((host, port)) => (host, Some(port)),
            None => (authority, None),
        };
        let valid = !host.is_empty()
            && host
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'.');
        if !valid {
            return None;
        }
        (host.to_string(), port)
    };
    let port = match port {
        None => default_port,
        Some(digits) if !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()) => {
            digits.parse().ok()?
        }
        Some(_) => return None,
    };
    Some((host.to_ascii_lowercase(), port))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origins_normalise_case_and_the_default_port() {
        let origin = LoginOrigin::parse("https://Login.Example").unwrap();
        assert_eq!(
            origin,
            LoginOrigin::parse("https://login.example:443").unwrap()
        );
        assert_eq!(origin.to_string(), "https://login.example");
        let other = LoginOrigin::parse("https://login.example:8443").unwrap();
        assert_eq!(other.to_string(), "https://login.example:8443");
    }

    #[test]
    fn an_origin_is_nothing_but_an_origin() {
        for bad in [
            "http://login.example",
            "https://login.example/",
            "https://login.example/login",
            "https://user@login.example",
            "https://login.example:",
            "https://login.example:x",
            "ftp://login.example",
            "login.example",
            "https://",
            "https://bad_host.example",
        ] {
            assert!(LoginOrigin::parse(bad).is_none(), "{bad}");
        }
        assert!(LoginOrigin::parse("https://[::1]:8443").is_some());
    }

    #[test]
    fn urls_split_into_path_and_query_without_the_fragment() {
        let target = parse_url("https://a.example/login?next=%2F#frag").unwrap();
        assert_eq!(target.path, "/login");
        assert_eq!(target.query, Some("next=%2F"));
        assert_eq!(target.port, 443);
        let bare = parse_url("http://a.example").unwrap();
        assert_eq!((bare.path, bare.query, bare.port), ("", None, 80));
    }
}
