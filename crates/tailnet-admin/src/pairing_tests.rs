use super::*;

const ORIGIN: &str = "https://ops.example.com";

fn store() -> (tempfile::TempDir, RolePairings) {
    let tmp = tempfile::tempdir().unwrap();
    let pairings = RolePairings::at(tmp.path());
    (tmp, pairings)
}

#[test]
fn a_code_is_traded_once_for_a_bearer_with_its_role() {
    let (tmp, pairings) = store();
    let (code, expires) = pairings.issue(ORIGIN, Role::Manage, "ops", 100).unwrap();
    assert_eq!(expires, 100 + CODE_TTL_SECS);
    let (paired, token) = pairings.exchange(&code, ORIGIN, 101).unwrap();
    assert_eq!(paired.role, Role::Manage);
    assert_eq!(paired.label, "ops");
    assert_eq!(pairings.authorize(&token, ORIGIN), Some(paired));
    assert!(matches!(
        pairings.exchange(&code, ORIGIN, 102),
        Err(AdminError::PairingRefused)
    ));
    let file = std::fs::read_to_string(tmp.path().join(PAIRINGS_FILE)).unwrap();
    assert!(
        !file.contains(&code) && !file.contains(&token),
        "digests only"
    );
}

#[test]
fn a_bearer_opens_nothing_from_another_origin() {
    let (_tmp, pairings) = store();
    let (code, _) = pairings.issue(ORIGIN, Role::Read, "", 0).unwrap();
    let (_, token) = pairings.exchange(&code, ORIGIN, 1).unwrap();
    assert_eq!(pairings.authorize(&token, "https://evil.example"), None);
    assert_eq!(pairings.authorize("short", ORIGIN), None);
}

#[test]
fn a_code_from_the_wrong_origin_is_spent() {
    let (_tmp, pairings) = store();
    let (code, _) = pairings.issue(ORIGIN, Role::Manage, "", 0).unwrap();
    assert!(matches!(
        pairings.exchange(&code, "https://evil.example", 1),
        Err(AdminError::PairingRefused)
    ));
    assert!(matches!(
        pairings.exchange(&code, ORIGIN, 2),
        Err(AdminError::PairingRefused)
    ));
}

#[test]
fn an_expired_code_is_refused_and_spent() {
    let (_tmp, pairings) = store();
    let (code, _) = pairings.issue(ORIGIN, Role::Read, "", 0).unwrap();
    assert!(matches!(
        pairings.exchange(&code, ORIGIN, CODE_TTL_SECS + 1),
        Err(AdminError::PairingRefused)
    ));
    assert!(!pairings.admits_origin(ORIGIN, CODE_TTL_SECS + 1));
}

#[test]
fn only_an_origin_with_a_bearer_or_a_waiting_code_is_admitted() {
    let (_tmp, pairings) = store();
    assert!(!pairings.admits_origin(ORIGIN, 0));
    let (code, _) = pairings.issue(ORIGIN, Role::Read, "", 0).unwrap();
    assert!(pairings.admits_origin(ORIGIN, 1));
    pairings.exchange(&code, ORIGIN, 2).unwrap();
    assert!(pairings.admits_origin(ORIGIN, CODE_TTL_SECS * 10));
    assert!(!pairings.admits_origin("https://other.example", 3));
}

#[test]
fn origins_a_browser_never_sends_are_refused() {
    let (_tmp, pairings) = store();
    for origin in [
        "http://ops.example.com",
        "https://ops.example.com/",
        "*",
        "",
    ] {
        assert!(matches!(
            pairings.issue(origin, Role::Read, "", 0),
            Err(AdminError::Invalid("invalid_origin"))
        ));
    }
}

#[test]
fn codes_waiting_are_capped() {
    let (_tmp, pairings) = store();
    for _ in 0..MAX_PENDING {
        pairings.issue(ORIGIN, Role::Read, "", 0).unwrap();
    }
    assert!(matches!(
        pairings.issue(ORIGIN, Role::Read, "", 0),
        Err(AdminError::Full)
    ));
    assert!(pairings
        .issue(ORIGIN, Role::Read, "", CODE_TTL_SECS + 1)
        .is_ok());
}

#[test]
fn revoke_and_unpair_remove_bearers() {
    let (_tmp, pairings) = store();
    let pair = |role| {
        let (code, _) = pairings.issue(ORIGIN, role, "", 0).unwrap();
        pairings.exchange(&code, ORIGIN, 1).unwrap()
    };
    let (_, first) = pair(Role::Read);
    let (second, second_token) = pair(Role::Manage);
    assert!(pairings.revoke(&first, ORIGIN).unwrap());
    assert!(!pairings.revoke(&first, ORIGIN).unwrap());
    assert_eq!(pairings.authorize(&first, ORIGIN), None);
    let (listed, _) = pairings.list(2).unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(pairings.unpair(None, Some(&second.id)).unwrap(), 1);
    assert_eq!(pairings.authorize(&second_token, ORIGIN), None);
    pair(Role::Read);
    pair(Role::Read);
    assert_eq!(pairings.unpair(Some(ORIGIN), None).unwrap(), 2);
    pair(Role::Read);
    assert_eq!(pairings.unpair(None, None).unwrap(), 1);
}

#[test]
fn an_unreadable_file_pairs_nobody() {
    let (tmp, pairings) = store();
    std::fs::write(tmp.path().join(PAIRINGS_FILE), b"{\"v\":9}").unwrap();
    assert!(matches!(pairings.list(0), Err(AdminError::Unreadable(_))));
    assert!(!pairings.admits_origin(ORIGIN, 0));
    assert_eq!(pairings.authorize(&"a".repeat(43), ORIGIN), None);
}
