//! Attachments and Sends under the oracle (ADR 0148): the official `bw`
//! attaches, downloads and deletes a file, and makes, lists, reads and deletes
//! Sends, against this server.
//!
//! `#[ignore]`d like the other oracle suites; `pnpm test:bitwarden-oracle` runs
//! it with the pinned CLI and fails, never skips, without it.
mod common;

use common::bw::Bw;
use common::client::{Account, ARGON2ID};
use common::Harness;
use serde_json::json;

const PASSWORD: &str = "correct horse battery staple";

async fn signed_in(harness: &Harness, email: &str) -> Bw {
    Account::register(&harness.http_url, email, PASSWORD, ARGON2ID).await;
    let mut bw = Bw::new(harness).await;
    bw.login(email, PASSWORD).await;
    bw
}

#[tokio::test]
#[ignore = "needs the official bw CLI: pnpm test:bitwarden-oracle"]
async fn bw_attaches_downloads_and_deletes_a_file() {
    let harness = Harness::start().await;
    let bw = signed_in(&harness, "files@example.com").await;
    let item = bw
        .create(
            "item",
            &json!({"type": 2, "name": "Tax return", "secureNote": {"type": 0}}),
        )
        .await;
    let id = item["id"].as_str().unwrap();
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("return-2025.pdf");
    let contents: Vec<u8> = (0..70_000_u32).map(|i| (i % 251) as u8).collect();
    std::fs::write(&file, &contents).unwrap();

    let attached = bw
        .json(&[
            "create",
            "attachment",
            "--file",
            file.to_str().unwrap(),
            "--itemid",
            id,
        ])
        .await;
    let attachment = &attached["attachments"][0];
    assert_eq!(attachment["fileName"], "return-2025.pdf");
    let attachment_id = attachment["id"].as_str().unwrap();

    bw.ok(&["sync", "--force"]).await;
    let out = dir.path().join("out");
    std::fs::create_dir(&out).unwrap();
    bw.ok(&[
        "get",
        "attachment",
        "return-2025.pdf",
        "--itemid",
        id,
        "--output",
        &format!("{}/", out.display()),
    ])
    .await;
    assert_eq!(
        std::fs::read(out.join("return-2025.pdf")).unwrap(),
        contents
    );

    bw.ok(&["delete", "attachment", attachment_id, "--itemid", id])
        .await;
    bw.ok(&["sync", "--force"]).await;
    let after = bw.json(&["get", "item", id]).await;
    assert!(
        after["attachments"].as_array().is_none_or(Vec::is_empty),
        "{after}"
    );
    assert!(harness.unrouted().is_empty(), "{:?}", harness.unrouted());
}

#[tokio::test]
#[ignore = "needs the official bw CLI: pnpm test:bitwarden-oracle"]
async fn bw_makes_lists_receives_and_deletes_sends() {
    // bw trusts a Send link only from the web vault's own origin, so a
    // non-interactive receive needs the server at the root of one (behind a
    // dedicated host name); under a path it asks the person first.
    let harness = Harness::start_at_root().await;
    let bw = signed_in(&harness, "sender@example.com").await;

    // A text Send, then a stranger's bw receives it by its link.
    let sent = bw
        .json(&["send", "-n", "Wifi", "hunter2-wifi", "--hidden"])
        .await;
    let link = sent["accessUrl"].as_str().unwrap().to_owned();
    assert!(link.contains("#/send/"), "{sent}");
    let stranger = Bw::new(&harness).await;
    assert_eq!(
        stranger.ok(&["send", "receive", &link]).await,
        "hunter2-wifi"
    );

    // A file Send with a password.
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("keys.txt");
    std::fs::write(&file, "the spare key is under the mat").unwrap();
    let file_send = bw
        .json(&[
            "send",
            "-n",
            "Keys",
            "--file",
            file.to_str().unwrap(),
            "--password",
            "open sesame",
        ])
        .await;
    let file_link = file_send["accessUrl"].as_str().unwrap().to_owned();
    let out = dir.path().join("received.txt");
    stranger
        .fails(&[
            "send",
            "receive",
            &file_link,
            "--output",
            out.to_str().unwrap(),
        ])
        .await;
    stranger
        .ok(&[
            "send",
            "receive",
            &file_link,
            "--password",
            "open sesame",
            "--output",
            out.to_str().unwrap(),
        ])
        .await;
    assert_eq!(
        std::fs::read_to_string(&out).unwrap(),
        "the spare key is under the mat"
    );

    let listed = bw.json(&["send", "list"]).await;
    assert_eq!(listed.as_array().unwrap().len(), 2);
    assert!(harness.unrouted().is_empty(), "{:?}", harness.unrouted());
    // Once deleted, the link finds nothing: a 404 is the answer, not a gap.
    bw.ok(&["send", "delete", sent["id"].as_str().unwrap()])
        .await;
    let gone = stranger.run(&["send", "receive", &link]).await;
    assert_ne!(gone.status.code(), Some(0));
    assert_eq!(
        bw.json(&["send", "list"]).await.as_array().unwrap().len(),
        1
    );
}
