//! Exact-origin matching for fill by reference (ADR 0150 §6.4).
//!
//! A stored entry declares where it belongs with `url:` lines in its trailer,
//! the `pass` convention browserpass and gopass already read. A page is
//! offered an entry only when one of those lines has exactly the page's
//! origin: the same scheme, the same host and the same port. There is no
//! suffix, subdomain, "registrable domain" or substring rule, because each of
//! those is a way for `example.com.evil.test` or `evil.example.com` to be
//! handed `example.com`'s password. An entry whose `url:` names no scheme
//! names no origin and matches nothing.
//!
//! Everything here is pure: no store, no I/O, no clock.

use url::Url;

/// Longest origin a caller may name; real origins are far shorter.
pub(crate) const MAX_ORIGIN_LEN: usize = 512;

/// Longest store path a caller may name as a reference.
pub(crate) const MAX_REFERENCE_LEN: usize = 256;

/// A web origin, held in the browser's ASCII serialization
/// (`https://example.com`, `http://127.0.0.1:8080`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct WebOrigin(String);

impl WebOrigin {
    /// The origin a caller asks for. It must already be the canonical
    /// serialization `location.origin` produces — lower-case host, no default
    /// port, no path, query, fragment or credentials — so the string the
    /// extension compared on the page and the string compared here are the
    /// same bytes. Only `http` and `https` have origins worth filling.
    pub(crate) fn parse_request(raw: &str) -> Option<Self> {
        if raw.is_empty() || raw.len() > MAX_ORIGIN_LEN {
            return None;
        }
        let origin = Self::of(&Url::parse(raw).ok()?)?;
        (origin.0 == raw).then_some(origin)
    }

    /// The origin of a URL an entry declares, which may carry a path.
    fn from_declared(raw: &str) -> Option<Self> {
        if raw.len() > MAX_ORIGIN_LEN * 4 {
            return None;
        }
        Self::of(&Url::parse(raw).ok()?)
    }

    fn of(url: &Url) -> Option<Self> {
        if !matches!(url.scheme(), "http" | "https") {
            return None;
        }
        let origin = url.origin();
        origin
            .is_tuple()
            .then(|| Self(origin.ascii_serialization()))
    }
}

/// The value of the first trailer line whose key is one of `keys`
/// (case-insensitive), trimmed. `key: value`, one per line.
fn trailer_values<'a>(trailer: &'a str, keys: &'a [&str]) -> impl Iterator<Item = &'a str> + 'a {
    trailer.lines().filter_map(move |line| {
        let (key, value) = line.split_once(':')?;
        let key = key.trim();
        keys.iter()
            .any(|wanted| key.eq_ignore_ascii_case(wanted))
            .then(|| value.trim())
    })
}

/// The metadata object an `OpenSesame` account entry's trailer carries (the
/// vault writes its sites and username there, ADR 0172), if it carries one: the
/// first non-`otpauth://` text, when it is a JSON object.
fn account_meta(trailer: &str) -> Option<serde_json::Value> {
    let kept: Vec<&str> = trailer
        .lines()
        .filter(|line| {
            !line
                .trim_start()
                .to_ascii_lowercase()
                .starts_with("otpauth://")
        })
        .collect();
    let text = kept.join("\n");
    let text = text.trim();
    text.starts_with('{')
        .then(|| serde_json::from_str(text).ok())
        .flatten()
}

/// Whether any site an entry declares has exactly `origin`: a `url:` line, or
/// one of the `uris` of an account the vault wrote. Both are compared as
/// origins, never as suffixes.
pub(crate) fn entry_matches(trailer: &str, origin: &WebOrigin) -> bool {
    let from_lines = trailer_values(trailer, &["url"]).filter_map(WebOrigin::from_declared);
    let sites: Vec<String> = account_meta(trailer)
        .and_then(|meta| meta.get("uris").cloned())
        .and_then(|uris| serde_json::from_value::<Vec<String>>(uris).ok())
        .unwrap_or_default();
    from_lines
        .chain(
            sites
                .iter()
                .filter_map(|site| WebOrigin::from_declared(site)),
        )
        .any(|declared| declared == *origin)
}

/// The account name for an entry: an explicit `login:`/`username:`/`user:`
/// line, else the last path segment (the `pass`/gopass convention).
pub(crate) fn login_of(name: &str, trailer: &str) -> String {
    let declared = account_meta(trailer)
        .and_then(|meta| {
            meta.get("username")
                .and_then(|v| v.as_str())
                .map(str::to_owned)
        })
        .filter(|username| !username.is_empty());
    if let Some(username) = declared {
        return username;
    }
    trailer_values(trailer, &["login", "username", "user"])
        .find(|value| !value.is_empty())
        .map_or_else(
            || name.rsplit('/').next().unwrap_or_default().to_string(),
            str::to_string,
        )
}

/// A reference is a logical store path: slash-separated, relative, with no
/// empty, `.` or `..` segment and no control character or backslash. The
/// store confines paths itself; this refuses the shapes before they reach it.
pub(crate) fn valid_reference(reference: &str) -> bool {
    !reference.is_empty()
        && reference.len() <= MAX_REFERENCE_LEN
        && !reference.contains('\\')
        && !reference.chars().any(char::is_control)
        && reference
            .split('/')
            .all(|segment| !segment.is_empty() && segment != "." && segment != "..")
}

#[cfg(test)]
#[path = "origin_tests.rs"]
mod tests;
