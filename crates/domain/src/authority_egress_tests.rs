use super::*;

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
        .allows_url("https://api.github.com:8443/repos/acme/x")
        .is_err());
    assert!(e
        .allows_redirect(
            "https://api.github.com/repos/x",
            "https://evil.example/steal",
        )
        .is_err());
    assert!(e
        .allows_url("https://user:pass@api.github.com/repos/x")
        .is_err());
}
