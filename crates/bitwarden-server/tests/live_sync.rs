//! Live sync and the web vault (ADR 0148 §7), in process: a client holding
//! the hub open hears "sync now" when its vault changes and "sign out" when
//! its security stamp does, and nothing without a current token; a
//! configured web vault is served beside the API, and never in place of it.
mod common;

use common::orgs::account;
use common::Harness;
use futures::{SinkExt as _, StreamExt as _};
use serde_json::json;
use tokio_tungstenite::tungstenite::Message;

type Socket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn connect(
    harness: &Harness,
    token: &str,
) -> Result<Socket, tokio_tungstenite::tungstenite::Error> {
    let url = format!(
        "{}/notifications/hub?access_token={token}",
        harness.http_url.replacen("http", "ws", 1)
    );
    tokio_tungstenite::connect_async(url)
        .await
        .map(|(socket, _)| socket)
}

/// The next binary frame, skipping pings.
async fn next_update(socket: &mut Socket) -> Option<Vec<u8>> {
    loop {
        let message = tokio::time::timeout(std::time::Duration::from_secs(10), socket.next())
            .await
            .ok()??
            .ok()?;
        match message {
            Message::Binary(data) if data.as_ref() != [0x02, 0x91, 0x06] => {
                return Some(data.to_vec());
            }
            Message::Close(_) => return None,
            _ => {}
        }
    }
}

fn has(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|w| w == needle)
}

#[tokio::test]
async fn the_hub_says_sync_on_a_change_and_sign_out_on_a_new_stamp() {
    let harness = Harness::start().await;
    let (account, api) = account(&harness, "live@example.com").await;
    let user_id = api.user_id().await;
    let mut socket = connect(&harness, &api.token).await.unwrap();
    socket
        .send(Message::text(
            "{\"protocol\":\"messagepack\",\"version\":1}\u{1e}",
        ))
        .await
        .unwrap();
    assert_eq!(next_update(&mut socket).await.unwrap(), b"{}\x1e");

    api.ok(
        "POST",
        "/folders",
        Some(json!({"name": "2.aGk=|aGk=|aGk="})),
    )
    .await;
    let update = next_update(&mut socket).await.unwrap();
    assert!(has(&update, b"\xaeReceiveMessage"));
    assert!(has(&update, b"\xa4Type\x05"), "SyncVault");
    assert!(has(&update, user_id.as_bytes()));

    api.ok(
        "POST",
        "/accounts/security-stamp",
        Some(json!({"masterPasswordHash": account.password_hash()})),
    )
    .await;
    let update = next_update(&mut socket).await.unwrap();
    assert!(has(&update, b"\xa4Type\x0b"), "LogOut");
    assert!(next_update(&mut socket).await.is_none(), "the hub closes");
    // The old token opens nothing now.
    assert!(connect(&harness, &api.token).await.is_err());
}

#[tokio::test]
async fn the_hub_admits_only_a_current_token_and_tells_nobody_else() {
    let harness = Harness::start().await;
    let (_, api) = account(&harness, "live@example.com").await;
    let (_, other) = account(&harness, "other@example.com").await;
    assert!(connect(&harness, "not-a-token").await.is_err());
    let mut socket = connect(&harness, &other.token).await.unwrap();
    api.ok(
        "POST",
        "/folders",
        Some(json!({"name": "2.aGk=|aGk=|aGk="})),
    )
    .await;
    let quiet = tokio::time::timeout(std::time::Duration::from_millis(500), socket.next()).await;
    assert!(quiet.is_err(), "another account's change is not announced");
}

#[tokio::test]
async fn a_configured_web_vault_is_served_beside_the_api() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("index.html"), "<html>vault</html>").unwrap();
    std::fs::create_dir(dir.path().join("app")).unwrap();
    std::fs::write(dir.path().join("app/main.js"), "console.log(1)").unwrap();
    let path = dir.path().to_owned();
    let harness = Harness::start_with(move |mut config| {
        config.web_vault = Some(path);
        config
    })
    .await;
    let http = common::client::http();
    let get = |path: &str| http.get(format!("{}{path}", harness.http_url)).send();

    let page = get("/").await.unwrap();
    assert_eq!(page.status(), 200);
    assert!(page.headers()["content-security-policy"]
        .to_str()
        .unwrap()
        .contains("frame-ancestors 'self'"));
    assert_eq!(page.headers()["x-frame-options"], "SAMEORIGIN");
    assert_eq!(page.text().await.unwrap(), "<html>vault</html>");
    assert_eq!(
        get("/app/main.js").await.unwrap().text().await.unwrap(),
        "console.log(1)"
    );
    // A route of the app answers with the app.
    assert_eq!(get("/#/vault").await.unwrap().status(), 200);
    assert_eq!(
        get("/settings/account")
            .await
            .unwrap()
            .text()
            .await
            .unwrap(),
        "<html>vault</html>"
    );
    // The API's own paths never do.
    assert_eq!(get("/api/nothing-here").await.unwrap().status(), 404);
    assert_eq!(get("/identity/nothing-here").await.unwrap().status(), 404);
    assert_eq!(get("/api/alive").await.unwrap().status(), 200);
    // Nothing outside the directory is reachable.
    for escape in [
        "/..%2f..%2f..%2fetc%2fpasswd",
        "/app/%2e%2e/%2e%2e/%2e%2e/etc/passwd",
    ] {
        let body = get(escape).await.unwrap().text().await.unwrap();
        assert!(!body.contains("root:"), "{escape}");
    }
}

#[tokio::test]
async fn without_a_web_vault_only_the_api_is_served() {
    let harness = Harness::start().await;
    let page = common::client::http()
        .get(format!("{}/", harness.http_url))
        .send()
        .await
        .unwrap();
    assert_eq!(page.status(), 404);
}
