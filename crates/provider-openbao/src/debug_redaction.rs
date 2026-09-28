use super::*;

#[test]
fn the_authority_token_never_prints() {
    let authority = OpenBaoHttpAuthority::new("http://127.0.0.1:8200", "s.hvs.CAESIJlHUQ");
    let shown = format!("{authority:?}");
    assert!(!shown.contains("hvs"), "{shown}");
    assert!(shown.contains("127.0.0.1"));
}
