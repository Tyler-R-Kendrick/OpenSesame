use super::*;

const EXT: &str = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const OTHER: &str = "chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba";
const TOKEN: &str = "k7Q2mB9xR4tW8vN1cZ6yH3jL5pS0aD7fG2eU9iO4qT1";

fn code_of(outcome: PairOutcome) -> String {
    match outcome {
        PairOutcome::Pending { code, .. } => code,
        other => panic!("expected a pending request, got {other:?}"),
    }
}

#[test]
fn a_request_is_not_a_pairing_until_a_person_approves_it() {
    let pairings = Pairings::load(None);
    let now = Utc::now();
    let code = code_of(pairings.request(EXT, TOKEN, now));
    assert_eq!(code.len(), CODE_LEN);
    assert!(!pairings.verify(EXT, TOKEN), "pending is not paired");
    assert_eq!(pairings.approve(&code, now).unwrap().as_deref(), Some(EXT));
    assert!(pairings.verify(EXT, TOKEN));
    assert_eq!(pairings.request(EXT, TOKEN, now), PairOutcome::Paired);
}

#[test]
fn the_token_is_bound_to_its_origin() {
    let pairings = Pairings::load(None);
    let now = Utc::now();
    let code = code_of(pairings.request(EXT, TOKEN, now));
    pairings.approve(&code, now).unwrap();
    assert!(
        !pairings.verify(OTHER, TOKEN),
        "a copied token from another origin"
    );
    assert!(!pairings.verify(EXT, "another-token-another-token-another-token-1"));
}

#[test]
fn a_forger_gets_its_own_code() {
    let pairings = Pairings::load(None);
    let now = Utc::now();
    let mine = code_of(pairings.request(EXT, TOKEN, now));
    let forged = code_of(pairings.request(OTHER, TOKEN, now));
    assert_ne!(mine, forged);
    pairings.approve(&mine, now).unwrap();
    assert!(
        !pairings.verify(OTHER, TOKEN),
        "approving my code admits only me"
    );
}

#[test]
fn an_expired_code_approves_nothing() {
    let pairings = Pairings::load(None);
    let now = Utc::now();
    let code = code_of(pairings.request(EXT, TOKEN, now));
    let later = now + chrono::Duration::seconds(PENDING_TTL_SECS + 1);
    assert_eq!(pairings.approve(&code, later).unwrap(), None);
    assert!(!pairings.verify(EXT, TOKEN));
}

#[test]
fn a_code_approves_once_and_reads_loosely() {
    let pairings = Pairings::load(None);
    let now = Utc::now();
    let code = code_of(pairings.request(EXT, TOKEN, now));
    let typed = format!("{}-{}", &code[..4], &code[4..]).to_ascii_lowercase();
    assert!(pairings.approve(&typed, now).unwrap().is_some());
    assert_eq!(pairings.approve(&code, now).unwrap(), None, "spent");
}

#[test]
fn a_flood_of_requests_is_capped() {
    let pairings = Pairings::load(None);
    let now = Utc::now();
    for i in 0..MAX_PENDING {
        let origin = format!("moz-extension://00000000-0000-4000-8000-{i:012}");
        code_of(pairings.request(&origin, TOKEN, now));
    }
    assert_eq!(pairings.request(EXT, TOKEN, now), PairOutcome::Full);
}

#[test]
fn revoke_forgets_the_caller() {
    let pairings = Pairings::load(None);
    let now = Utc::now();
    let code = code_of(pairings.request(EXT, TOKEN, now));
    pairings.approve(&code, now).unwrap();
    assert!(pairings.revoke(EXT).unwrap());
    assert!(!pairings.verify(EXT, TOKEN));
    assert!(!pairings.revoke(EXT).unwrap());
}

#[test]
fn pairings_survive_a_restart_as_digests_only() {
    let dir = tempfile::tempdir().unwrap();
    let now = Utc::now();
    {
        let pairings = Pairings::load(Some(dir.path()));
        let code = code_of(pairings.request(EXT, TOKEN, now));
        pairings.approve(&code, now).unwrap();
    }
    let written = std::fs::read_to_string(dir.path().join(PAIRINGS_FILE)).unwrap();
    assert!(
        !written.contains(TOKEN),
        "the token itself is never written"
    );
    assert!(written.contains(&digest_hex(TOKEN)));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let mode = std::fs::metadata(dir.path().join(PAIRINGS_FILE))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o077, 0, "owner-only");
    }
    let reloaded = Pairings::load(Some(dir.path()));
    assert!(reloaded.verify(EXT, TOKEN));
}

#[test]
fn a_malformed_file_pairs_nobody() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join(PAIRINGS_FILE), b"{not json").unwrap();
    let pairings = Pairings::load(Some(dir.path()));
    assert!(pairings.snapshot(Utc::now()).0.is_empty());
}

#[test]
fn the_operator_snapshot_carries_no_digest() {
    let pairings = Pairings::load(None);
    let now = Utc::now();
    let code = code_of(pairings.request(EXT, TOKEN, now));
    pairings.approve(&code, now).unwrap();
    code_of(pairings.request(OTHER, TOKEN, now));
    let (paired, pending) = pairings.snapshot(now);
    let text = serde_json::to_string(&(paired, pending)).unwrap();
    assert!(!text.contains(&digest_hex(TOKEN)));
    assert!(text.contains(EXT) && text.contains(OTHER));
}
