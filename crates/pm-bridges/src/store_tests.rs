//! Unit tests for [`super`]: the pure URL/name predicates, and
//! [`super::StoreAccess`] against a real tempdir store.

use super::*;

#[test]
fn host_of_handles_the_shapes_a_browser_sends() {
    assert_eq!(
        host_of("https://example.com/login"),
        Some("example.com".into())
    );
    assert_eq!(host_of("http://Example.COM"), Some("example.com".into()));
    assert_eq!(host_of("example.com"), Some("example.com".into()));
    assert_eq!(host_of("example.com:8443/x"), Some("example.com".into()));
    assert_eq!(
        host_of("https://user:pw@example.com:443/path?q=1#f"),
        Some("example.com".into())
    );
    assert_eq!(host_of("https://[::1]:8080/x"), Some("::1".into()));
    assert_eq!(host_of("https://example.com./"), Some("example.com".into()));
}

#[test]
fn host_of_rejects_junk() {
    assert_eq!(host_of(""), None);
    assert_eq!(host_of("   "), None);
    assert_eq!(host_of("https://"), None);
    assert_eq!(host_of("/just/a/path"), None);
    assert_eq!(host_of("https://:8080/x"), None);
}

#[test]
fn trailer_urls_collects_every_url_key_in_order() {
    let trailer =
        "login: a\nurl: https://one.example\nnotes: x\nURI: https://two.example\nwebsite:  \n";
    assert_eq!(
        trailer_urls(trailer),
        vec!["https://one.example", "https://two.example"]
    );
}

#[test]
fn trailer_value_is_case_insensitive_and_skips_blanks() {
    let trailer = "Login:   \nUserName: alice\nuser: bob\n";
    assert_eq!(
        trailer_value(trailer, &["login", "username", "user"]),
        Some("alice".into())
    );
    assert_eq!(trailer_value(trailer, &["nope"]), None);
    assert_eq!(trailer_value("no colon here\n", &["login"]), None);
}

#[test]
fn host_matches_covers_subdomains_and_www() {
    assert!(host_matches("example.com", "example.com"));
    assert!(host_matches("www.example.com", "example.com"));
    assert!(host_matches("example.com", "login.example.com"));
    assert!(host_matches("login.example.com", "example.com"));
    assert!(!host_matches("example.com", "notexample.com"));
    assert!(!host_matches("example.com", "example.org"));
    assert!(!host_matches("", "example.com"));
    assert!(!host_matches("example.com", ""));
}

#[test]
fn name_matches_walks_every_path_segment() {
    assert!(name_matches("Web/example.com/alice", "example.com"));
    assert!(name_matches("example.com", "www.example.com"));
    assert!(name_matches("Web/example.com", "login.example.com"));
    assert!(name_matches("Web/login.example.com/a", "example.com"));
    assert!(name_matches("Web/github.com/a", "gist.github.com"));
    assert!(!name_matches("Dev/gitlab/token", "github.com"));
    // A bare label is not a domain: no lookalike or shared-hosting tenant.
    assert!(!name_matches("Dev/github/token", "github.com"));
    assert!(!name_matches("Dev/github/token", "attacker.github.io"));
    assert!(!name_matches("Dev/github/token", "github.lol"));
    assert!(!name_matches("Web/github.com", "evilgithub.com"));
    assert!(!name_matches("Web/github.com", "github.com.evil.example"));
    // A bare public suffix must not suffix-match the whole store.
    assert!(!name_matches("Web/example.com/alice", "com"));
    // …but a single-label host that really is the host still matches.
    assert!(name_matches("Web/localhost/alice", "localhost"));
    assert!(!name_matches("", "example.com"));
    assert!(!name_matches("Web/example.com", ""));
}

#[test]
fn name_matches_never_crosses_to_a_sibling_under_a_shared_suffix() {
    // Siblings under a public suffix are different tenants: neither is a
    // parent nor a child of the other, so no path name crosses between them.
    for (name, host) in [
        ("Web/victim.github.io", "attacker.github.io"),
        ("Web/victim.github.io", "login.attacker.github.io"),
        ("Web/bank.co.uk", "attacker.co.uk"),
        ("Web/app.herokuapp.com", "evil.herokuapp.com"),
        ("Web/app.vercel.app", "evil.vercel.app"),
        ("Web/site.pages.dev", "evil.pages.dev"),
    ] {
        assert!(!name_matches(name, host), "{name} vs {host}");
    }
    // The tenant's own host and its subdomains still resolve by name.
    assert!(name_matches("Web/victim.github.io", "victim.github.io"));
    assert!(name_matches(
        "Web/victim.github.io",
        "login.victim.github.io"
    ));
    assert!(name_matches("Web/bank.co.uk", "www.bank.co.uk"));
}

#[test]
fn entry_uuid_is_stable_and_path_scoped() {
    assert_eq!(entry_uuid("Web/example.com"), entry_uuid("Web/example.com"));
    assert_ne!(entry_uuid("Web/example.com"), entry_uuid("Web/example.org"));
    assert_eq!(entry_uuid("x").len(), 32);
}

// ——— StoreAccess against a real tempdir store ————————————————————

fn fixture() -> (tempfile::TempDir, StoreAccess) {
    let dir = tempfile::tempdir().expect("tempdir");
    crate::testing::init_store_fixture(dir.path());
    let access = StoreAccess::open(dir.path(), Some(b"correct horse")).expect("open");
    (dir, access)
}

#[test]
fn store_access_lists_shows_and_puts() {
    let (_dir, access) = fixture();
    let mut names = access.list("").unwrap();
    names.sort();
    assert_eq!(names, vec!["Dev/github", "Web/example.com"]);

    let entry = access.show("Web/example.com").unwrap();
    assert_eq!(entry.secret, "hunter2");

    access
        .put(
            "Web/new.example",
            &Entry {
                secret: "s".into(),
                trailer: "login: n\n".into(),
                otp: None,
            },
        )
        .unwrap();
    assert_eq!(access.show("Web/new.example").unwrap().secret, "s");
}

#[test]
fn find_by_url_prefers_a_trailer_match() {
    let (_dir, access) = fixture();
    let found = access
        .find_by_url("https://login.example.com/signin")
        .unwrap();
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].name, "Web/example.com");
    assert_eq!(found[0].login(), "alice");
}

fn put(access: &StoreAccess, name: &str, trailer: &str) {
    let entry = Entry {
        secret: "s".into(),
        trailer: trailer.into(),
        otp: None,
    };
    access.put(name, &entry).unwrap();
}

#[test]
fn find_by_url_falls_back_to_name_heuristics() {
    let (_dir, access) = fixture();
    put(&access, "Web/github.com/octo", "");
    let found = access.find_by_url("https://gist.github.com/login").unwrap();
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].name, "Web/github.com/octo");
    // No login trailer on that entry → last path segment.
    assert_eq!(found[0].login(), "octo");
    // `Dev/github` is a bare label, not a domain: never a name match.
    assert!(access.find_by_url("https://github.io/").unwrap().is_empty());
}

#[test]
fn find_by_url_never_serves_lookalikes_or_overrides_a_url_trailer() {
    let (_dir, access) = fixture();
    put(&access, "Dev/github/token", "url: https://github.com\n");
    put(&access, "Web/github.lol", "url: https://github.com\n");
    for url in [
        "https://github.lol/",
        "https://attacker.github.io/",
        "https://github.com.evil.example/",
    ] {
        assert!(access.find_by_url(url).unwrap().is_empty(), "{url}");
    }
    let found = access.find_by_url("https://github.com/").unwrap();
    let mut names: Vec<_> = found.iter().map(|m| m.name.as_str()).collect();
    names.sort_unstable();
    assert_eq!(names, vec!["Dev/github/token", "Web/github.lol"]);
}

#[test]
fn find_by_url_never_serves_a_url_less_entry_to_a_shared_suffix_neighbour() {
    let (_dir, access) = fixture();
    put(&access, "Web/victim.github.io", "");
    put(&access, "Web/bank.co.uk", "");
    for url in [
        "https://attacker.github.io/",
        "https://login.attacker.github.io/",
        "https://attacker.co.uk/",
    ] {
        assert!(access.find_by_url(url).unwrap().is_empty(), "{url}");
    }
    for (url, name) in [
        ("https://victim.github.io/", "Web/victim.github.io"),
        ("https://login.victim.github.io/", "Web/victim.github.io"),
        ("https://www.bank.co.uk/", "Web/bank.co.uk"),
    ] {
        let found = access.find_by_url(url).unwrap();
        let names: Vec<_> = found.iter().map(|m| m.name.as_str()).collect();
        assert_eq!(names, vec![name], "{url}");
    }
}

#[test]
fn find_by_url_returns_empty_for_an_unknown_host() {
    let (_dir, access) = fixture();
    assert!(access
        .find_by_url("https://nowhere.invalid/")
        .unwrap()
        .is_empty());
}

#[test]
fn find_by_url_rejects_a_url_without_a_host() {
    let (_dir, access) = fixture();
    assert!(access.find_by_url("   ").is_err());
}

#[test]
fn totp_reads_the_otpauth_trailer() {
    let (_dir, access) = fixture();
    let code = access.totp("Web/example.com", 59).unwrap();
    assert_eq!(code.len(), 6);
    assert!(code.chars().all(|c| c.is_ascii_digit()));
    assert!(access.totp("Dev/github", 59).is_err());
}

#[test]
fn locking_refuses_every_later_read() {
    let (_dir, mut access) = fixture();
    assert!(!access.is_locked());
    access.lock();
    assert!(access.is_locked());
    assert!(matches!(
        access.show("Web/example.com"),
        Err(BridgeError::Locked)
    ));
    assert!(matches!(
        access.totp("Web/example.com", 0),
        Err(BridgeError::Locked)
    ));
    // A locked store reports *locked*, never a misleading empty result.
    assert!(matches!(
        access.find_by_url("https://example.com/"),
        Err(BridgeError::Locked)
    ));
    // Listing names is not a plaintext read and stays available.
    assert!(!access.list("").unwrap().is_empty());
}

#[test]
fn open_without_a_passphrase_on_a_keyed_store_is_unconfigured() {
    let dir = tempfile::tempdir().unwrap();
    crate::testing::init_store_fixture(dir.path());
    assert!(matches!(
        StoreAccess::open(dir.path(), None),
        Err(BridgeError::Unconfigured(_))
    ));
}

#[test]
fn database_hash_is_stable_and_store_scoped() {
    let (_dir_a, a) = fixture();
    let (_dir_b, b) = fixture();
    assert_eq!(a.database_hash(), a.database_hash());
    assert_ne!(a.database_hash(), b.database_hash());
    assert_eq!(a.database_hash().len(), 64);
}

#[test]
fn resolve_root_prefers_the_explicit_path() {
    assert_eq!(
        resolve_root(Some(PathBuf::from("/tmp/explicit"))),
        PathBuf::from("/tmp/explicit")
    );
}
