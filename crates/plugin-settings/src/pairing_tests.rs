//! One test per way a pairing could be abused: a code used twice, late, from
//! another origin, or guessed; a bearer carried to another origin; and
//! nothing but digests on disk.

use super::*;
use crate::pairing_code::{
    format_pairing_code, is_pairable_origin, is_secret_shaped, PAIRING_CODE_PREFIX,
};

const PAGES: &str = "https://tyler-r-kendrick.github.io";
const OTHER: &str = "https://attacker.example";
const NOW: u64 = 1_790_000_000;

const CONFORMANCE: &str = include_str!("../../../spec/conformance/plugin-pairing.json");

fn store() -> (tempfile::TempDir, PluginPairings) {
    let dir = tempfile::tempdir().unwrap();
    let pairings = PluginPairings::beside(&dir.path().join("plugins.json"));
    (dir, pairings)
}

#[test]
fn the_printed_code_matches_the_shared_vectors() {
    let spec: serde_json::Value = serde_json::from_str(CONFORMANCE).unwrap();
    assert_eq!(spec["prefix"], PAIRING_CODE_PREFIX);
    assert_eq!(spec["codeTtlSecs"], CODE_TTL_SECS);
    for key in ["example", "localExample"] {
        let case = &spec[key];
        let text = format_pairing_code(
            case["url"].as_str().unwrap(),
            case["code"].as_str().unwrap(),
            case["origin"].as_str().unwrap(),
            case["label"].as_str().unwrap(),
        );
        assert_eq!(text, case["text"].as_str().unwrap(), "{key}");
        assert!(is_pairable_origin(case["origin"].as_str().unwrap()));
        assert!(is_secret_shaped(case["code"].as_str().unwrap()));
    }
}

#[test]
fn only_an_origin_exactly_as_a_browser_sends_it_is_pairable() {
    for good in [
        PAGES,
        "https://desk.tail4c2e.ts.net",
        "https://example.com:8443",
        "http://localhost:5180",
    ] {
        assert!(is_pairable_origin(good), "{good}");
    }
    for bad in [
        "https://tyler-r-kendrick.github.io/",
        "https://tyler-r-kendrick.github.io/OpenSesame",
        "https://example.com:443",
        "HTTPS://example.com",
        "https://user@example.com",
        "https://example.com.",
        "http://example.com",
        "http://127.0.0.1:5180",
        "http://localhost",
        "*",
        "null",
        "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
        "",
    ] {
        assert!(!is_pairable_origin(bad), "{bad}");
    }
}

#[test]
fn a_code_trades_once_for_a_bearer_bound_to_its_origin() {
    let (_dir, pairings) = store();
    let (code, expires_at) = pairings.issue(PAGES, NOW).unwrap();
    assert_eq!(expires_at, NOW + CODE_TTL_SECS);
    assert!(is_secret_shaped(&code));
    let issued = pairings.exchange(&code, PAGES, NOW + 1).unwrap();
    assert!(is_secret_shaped(&issued.token));
    assert_ne!(issued.token, code);
    assert!(pairings.authorizes(&issued.token, PAGES));
    assert!(matches!(
        pairings.exchange(&code, PAGES, NOW + 2),
        Err(PairingError::Unknown)
    ));
}

#[test]
fn a_bearer_is_refused_from_any_other_origin() {
    let (_dir, pairings) = store();
    let (code, _) = pairings.issue(PAGES, NOW).unwrap();
    let issued = pairings.exchange(&code, PAGES, NOW).unwrap();
    for origin in [
        OTHER,
        "http://localhost:5180",
        "",
        "https://tyler-r-kendrick.github.io/",
    ] {
        assert!(!pairings.authorizes(&issued.token, origin), "{origin}");
    }
    assert!(
        !pairings.authorizes(&code, PAGES),
        "the code is not a bearer"
    );
}

#[test]
fn a_code_presented_from_another_origin_is_spent() {
    let (_dir, pairings) = store();
    let (code, _) = pairings.issue(PAGES, NOW).unwrap();
    assert!(matches!(
        pairings.exchange(&code, OTHER, NOW),
        Err(PairingError::WrongOrigin)
    ));
    assert!(matches!(
        pairings.exchange(&code, PAGES, NOW),
        Err(PairingError::Unknown)
    ));
    assert!(!pairings.admits_origin(OTHER, NOW));
}

#[test]
fn a_code_expires_and_is_spent_by_the_late_attempt() {
    let (_dir, pairings) = store();
    let (code, expires_at) = pairings.issue(PAGES, NOW).unwrap();
    assert!(matches!(
        pairings.exchange(&code, PAGES, expires_at),
        Err(PairingError::Expired)
    ));
    assert!(matches!(
        pairings.exchange(&code, PAGES, NOW),
        Err(PairingError::Unknown)
    ));
}

#[test]
fn a_guessed_or_malformed_code_is_unknown_and_spends_nothing() {
    let (_dir, pairings) = store();
    let (code, _) = pairings.issue(PAGES, NOW).unwrap();
    for guess in [
        "A".repeat(43),
        String::new(),
        code[..42].to_string(),
        format!("{code}x"),
    ] {
        assert!(
            matches!(
                pairings.exchange(&guess, PAGES, NOW),
                Err(PairingError::Unknown)
            ),
            "{guess}"
        );
    }
    assert!(pairings.exchange(&code, PAGES, NOW).is_ok());
}

#[test]
fn nothing_but_digests_reaches_the_file() {
    let (_dir, pairings) = store();
    let (code, _) = pairings.issue(PAGES, NOW).unwrap();
    let (second, _) = pairings.issue(PAGES, NOW).unwrap();
    let issued = pairings.exchange(&code, PAGES, NOW).unwrap();
    let text = std::fs::read_to_string(pairings.path()).unwrap();
    for secret in [&code, &second, &issued.token] {
        assert!(!text.contains(secret.as_str()));
    }
    assert!(!format!("{issued:?}").contains(&issued.token));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let mode = std::fs::metadata(pairings.path())
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }
}

#[test]
fn unpair_revokes_by_origin_or_all_and_revoke_removes_one_bearer() {
    let (_dir, pairings) = store();
    let mut tokens = Vec::new();
    for origin in [PAGES, PAGES, "http://localhost:5180"] {
        let (code, _) = pairings.issue(origin, NOW).unwrap();
        tokens.push(pairings.exchange(&code, origin, NOW).unwrap().token);
    }
    assert!(pairings.revoke(&tokens[0], PAGES).unwrap());
    assert!(!pairings.authorizes(&tokens[0], PAGES));
    assert!(pairings.authorizes(&tokens[1], PAGES));
    assert!(!pairings.revoke(&tokens[1], OTHER).unwrap());
    assert_eq!(pairings.unpair(Some(PAGES)).unwrap(), 1);
    assert!(!pairings.authorizes(&tokens[1], PAGES));
    assert!(pairings.authorizes(&tokens[2], "http://localhost:5180"));
    assert_eq!(pairings.unpair(None).unwrap(), 1);
    assert!(!pairings.authorizes(&tokens[2], "http://localhost:5180"));
}

#[test]
fn an_origin_is_admitted_only_while_it_holds_a_bearer_or_a_live_code() {
    let (_dir, pairings) = store();
    assert!(!pairings.admits_origin(PAGES, NOW));
    let (code, expires_at) = pairings.issue(PAGES, NOW).unwrap();
    assert!(pairings.admits_origin(PAGES, NOW));
    assert!(!pairings.admits_origin(PAGES, expires_at));
    pairings.exchange(&code, PAGES, NOW).unwrap();
    assert!(pairings.admits_origin(PAGES, expires_at));
    pairings.unpair(Some(PAGES)).unwrap();
    assert!(!pairings.admits_origin(PAGES, NOW));
}

#[test]
fn issuing_refuses_a_bad_origin_and_a_flood() {
    let (_dir, pairings) = store();
    assert!(matches!(
        pairings.issue("https://example.com/", NOW),
        Err(PairingError::InvalidOrigin)
    ));
    for _ in 0..MAX_PENDING {
        pairings.issue(PAGES, NOW).unwrap();
    }
    assert!(matches!(
        pairings.issue(PAGES, NOW),
        Err(PairingError::Full)
    ));
    // Expired codes stop counting.
    assert!(pairings.issue(PAGES, NOW + CODE_TTL_SECS).is_ok());
}

#[test]
fn a_full_house_keeps_the_code_for_after_an_unpair() {
    let (_dir, pairings) = store();
    for _ in 0..MAX_PAIRED {
        let (code, _) = pairings.issue(PAGES, NOW).unwrap();
        pairings.exchange(&code, PAGES, NOW).unwrap();
    }
    let (code, _) = pairings.issue(PAGES, NOW).unwrap();
    assert!(matches!(
        pairings.exchange(&code, PAGES, NOW),
        Err(PairingError::Full)
    ));
    pairings.unpair(Some(PAGES)).unwrap();
    assert!(
        pairings.exchange(&code, PAGES, NOW).is_err(),
        "unpair drops codes too"
    );
}

#[test]
fn an_unreadable_file_pairs_nobody() {
    let (_dir, pairings) = store();
    let (code, _) = pairings.issue(PAGES, NOW).unwrap();
    let token = pairings.exchange(&code, PAGES, NOW).unwrap().token;
    std::fs::write(pairings.path(), b"{ not json").unwrap();
    assert!(!pairings.authorizes(&token, PAGES));
    assert!(!pairings.admits_origin(PAGES, NOW));
    assert!(matches!(
        pairings.issue(PAGES, NOW),
        Err(PairingError::Unreadable(_))
    ));
}

#[test]
fn the_operator_listing_carries_no_digest() {
    let (_dir, pairings) = store();
    let (code, _) = pairings.issue(PAGES, NOW).unwrap();
    pairings.exchange(&code, PAGES, NOW).unwrap();
    pairings.issue("http://localhost:5180", NOW).unwrap();
    let (paired, pending) = pairings.list(NOW).unwrap();
    assert_eq!(paired.len(), 1);
    assert_eq!(paired[0].origin, PAGES);
    assert_eq!(pending.len(), 1);
    let text = serde_json::to_string(&(paired, pending)).unwrap();
    assert!(!text.contains("sha256"));
}
