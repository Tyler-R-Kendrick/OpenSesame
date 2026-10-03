use super::*;
use base64::Engine as _;
use opensesame_plugin_settings::PAIRING_CODE_PREFIX;

const PAGES: &str = "https://tyler-r-kendrick.github.io";

fn settings() -> (tempfile::TempDir, std::path::PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("plugins.json");
    (dir, path)
}

fn decode(code: &str) -> Value {
    let body = code.strip_prefix(PAIRING_CODE_PREFIX).unwrap();
    let json = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(body)
        .unwrap();
    serde_json::from_slice(&json).unwrap()
}

#[test]
fn pair_prints_a_code_for_the_origin_and_keeps_only_its_digest() {
    let (_dir, path) = settings();
    let printed = pair(&path, PAGES, "https://desk.tail4c2e.ts.net/", "Desk").unwrap();
    let wire = decode(printed["pairing_code"].as_str().unwrap());
    assert_eq!(wire["origin"], PAGES);
    assert_eq!(wire["url"], "https://desk.tail4c2e.ts.net");
    assert_eq!(wire["label"], "Desk");
    let secret = wire["code"].as_str().unwrap();
    assert_eq!(secret.len(), 43);
    let pairings = PluginPairings::beside(&path);
    let file = std::fs::read_to_string(pairings.path()).unwrap();
    assert!(!file.contains(secret));
    let issued = pairings.exchange(secret, PAGES, unix_now()).unwrap();
    assert!(pairings.authorizes(&issued.token, PAGES));
    let listed = listing(&path).unwrap().to_string();
    assert!(listed.contains(PAGES));
    assert!(!listed.contains(&issued.token) && !listed.contains("sha256"));
}

#[test]
fn pair_refuses_an_origin_a_browser_would_never_send() {
    let (_dir, path) = settings();
    for origin in [
        "https://tyler-r-kendrick.github.io/",
        "https://tyler-r-kendrick.github.io/OpenSesame",
        "http://tyler-r-kendrick.github.io",
        "*",
    ] {
        let error = pair(&path, origin, DEFAULT_DAEMON_URL, "Desk").unwrap_err();
        assert!(error.to_string().contains("--origin"), "{origin}");
    }
    assert!(!PluginPairings::beside(&path).path().exists());
}

#[test]
fn pair_refuses_a_daemon_address_off_the_tailnet() {
    let (_dir, path) = settings();
    for url in [
        "https://attacker.example",
        "http://desk.tail4c2e.ts.net",
        "http://100.101.102.103:18790",
        "https://desk.tail4c2e.ts.net/app",
        "https://user@desk.tail4c2e.ts.net",
    ] {
        let error = pair(&path, PAGES, url, "Desk").unwrap_err();
        assert!(error.to_string().contains("--url"), "{url}");
    }
    for url in [
        DEFAULT_DAEMON_URL,
        "http://localhost:18790",
        "http://[::1]:18790",
        "https://desk.tail4c2e.ts.net",
        "https://100.101.102.103",
        "https://desk",
        "https://[fd7a:115c:a1e0::1]",
    ] {
        assert!(is_daemon_url(url), "{url}");
    }
}

#[test]
fn unpair_revokes_one_origin_or_all() {
    let (_dir, path) = settings();
    let pairings = PluginPairings::beside(&path);
    let mut tokens = Vec::new();
    for origin in [PAGES, "http://localhost:5180"] {
        let printed = pair(&path, origin, DEFAULT_DAEMON_URL, "Desk").unwrap();
        let wire = decode(printed["pairing_code"].as_str().unwrap());
        let code = wire["code"].as_str().unwrap();
        tokens.push(pairings.exchange(code, origin, unix_now()).unwrap().token);
    }
    assert_eq!(unpair(&path, Some(PAGES)).unwrap()["revoked"], 1);
    assert!(!pairings.authorizes(&tokens[0], PAGES));
    assert!(pairings.authorizes(&tokens[1], "http://localhost:5180"));
    assert_eq!(unpair(&path, None).unwrap()["revoked"], 1);
    assert!(!pairings.authorizes(&tokens[1], "http://localhost:5180"));
}
