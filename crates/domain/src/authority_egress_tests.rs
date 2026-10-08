use super::{DomainError, EgressBinding};

#[test]
fn egress_blocks_evil_destination() {
    let e = EgressBinding {
        scheme: "https".into(),
        authorities: vec!["api.github.com".into()],
        path_prefixes: vec!["/repos/".into()],
        allow_redirects_cross_authority: false,
    };
    assert!(e
        .allows_url("https://api.github.com/repos/acme/x/pulls")
        .is_ok());
    assert!(e.allows_url("https://evil.example/foo").is_err());
    assert!(e
        .allows_redirect(
            "https://api.github.com/repos/x",
            "https://evil.example/steal"
        )
        .is_err());
    assert!(e
        .allows_url("https://user:pass@api.github.com/repos/x")
        .is_err());
}

#[test]
fn path_prefixes_stop_at_a_segment_boundary() {
    let e = EgressBinding {
        scheme: "https".into(),
        authorities: vec!["api.github.com".into()],
        path_prefixes: vec!["/repos/acme".into()],
        allow_redirects_cross_authority: false,
    };
    assert!(e.allows_url("https://api.github.com/repos/acme").is_ok());
    assert!(e
        .allows_url("https://api.github.com/repos/acme/catalog")
        .is_ok());
    assert!(e
        .allows_url("https://api.github.com/repos/acme-private/secrets")
        .is_err());
}

#[test]
fn encoded_path_traversals_fail_the_prefix_gate() {
    let e = EgressBinding {
        scheme: "https".into(),
        authorities: vec!["api.doppler.com".into()],
        path_prefixes: vec![
            "/v3/projects".into(),
            "/v3/configs/config/secrets/names".into(),
        ],
        allow_redirects_cross_authority: false,
    };
    assert!(e
        .allows_url("https://api.doppler.com/v3/projects/%2e%2e/%2fconfigs/config/secrets")
        .is_err());
    assert!(e
        .allows_url("https://api.doppler.com/v3/projects/foo%2f..%2fbar")
        .is_err());
    assert!(e
        .allows_url("https://api.doppler.com/v3/projects/x%5csecrets")
        .is_err());
    assert!(e
        .allows_url("https://api.doppler.com/v3/projects/legit/names")
        .is_ok());
}
