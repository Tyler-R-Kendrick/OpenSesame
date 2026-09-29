//! One test per way a page could try to be taken for a site it is not.
//! Every one of these would pass a host-suffix or "contains" match, which is
//! what browser password managers have repeatedly shipped and then fixed.
use super::*;

fn entry(url: &str) -> String {
    format!("login: alice\nurl: {url}\n")
}

fn page(origin: &str) -> WebOrigin {
    WebOrigin::parse_request(origin).expect("a canonical page origin")
}

#[test]
fn the_exact_origin_matches() {
    assert!(entry_matches(
        &entry("https://example.com/login"),
        &page("https://example.com")
    ));
}

#[test]
fn a_lookalike_host_is_refused() {
    // Suffix, prefix and homoglyph-in-punycode lookalikes.
    for lookalike in [
        "https://example.com.evil.test",
        "https://evilexample.com",
        "https://example.co",
        "https://xn--exmple-cua.com",
    ] {
        assert!(
            !entry_matches(&entry("https://example.com/login"), &page(lookalike)),
            "{lookalike} must not be taken for example.com"
        );
    }
}

#[test]
fn a_subdomain_is_refused() {
    assert!(!entry_matches(
        &entry("https://example.com/"),
        &page("https://login.example.com")
    ));
    // …and the other way round: an entry for a subdomain is not the parent's.
    assert!(!entry_matches(
        &entry("https://login.example.com/"),
        &page("https://example.com")
    ));
}

#[test]
fn another_port_is_refused() {
    assert!(!entry_matches(
        &entry("https://example.com/"),
        &page("https://example.com:8443")
    ));
    // The default port written out is the same origin, as the browser says.
    assert!(entry_matches(
        &entry("https://example.com:443/"),
        &page("https://example.com")
    ));
}

#[test]
fn another_scheme_is_refused() {
    assert!(!entry_matches(
        &entry("https://example.com/"),
        &page("http://example.com")
    ));
    assert!(!entry_matches(
        &entry("http://example.com/"),
        &page("https://example.com")
    ));
}

#[test]
fn a_host_only_entry_matches_nothing() {
    // `url: example.com` names no scheme, so it names no origin.
    assert!(!entry_matches(
        &entry("example.com"),
        &page("https://example.com")
    ));
}

#[test]
fn a_non_canonical_request_origin_is_refused() {
    for raw in [
        "https://EXAMPLE.com",
        "https://example.com/",
        "https://example.com/login",
        "https://example.com?x=1",
        "https://example.com#x",
        "https://user@example.com",
        "https://example.com:443",
        " https://example.com",
        "file:///etc/passwd",
        "data:text/html,hi",
        "javascript:alert(1)",
        "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
        "",
    ] {
        assert!(
            WebOrigin::parse_request(raw).is_none(),
            "{raw:?} is not a canonical web origin"
        );
    }
}

#[test]
fn any_declared_url_line_may_match() {
    let trailer = "url: https://example.com/\nURL: https://accounts.example.net/signin\n";
    assert!(entry_matches(
        trailer,
        &page("https://accounts.example.net")
    ));
    assert!(!entry_matches(trailer, &page("https://example.net")));
}

#[test]
fn a_url_in_another_field_is_not_a_declaration() {
    let trailer = "notes: https://example.com/\nurl-old: https://example.com/\n";
    assert!(!entry_matches(trailer, &page("https://example.com")));
}

#[test]
fn login_comes_from_the_trailer_then_the_path() {
    assert_eq!(login_of("Web/example.com", "username: bob\n"), "bob");
    assert_eq!(
        login_of("Web/example.com/carol", "url: https://x.test\n"),
        "carol"
    );
}

#[test]
fn references_are_logical_paths_only() {
    for good in ["Web/example.com", "a", "Personal/bank-01/alice"] {
        assert!(valid_reference(good), "{good}");
    }
    for bad in [
        "",
        "/Web/example.com",
        "Web/example.com/",
        "Web//x",
        "Web/../etc",
        "./x",
        "a\\b",
        "a\u{0}b",
        &"x".repeat(MAX_REFERENCE_LEN + 1),
    ] {
        assert!(!valid_reference(bad), "{bad:?}");
    }
}
