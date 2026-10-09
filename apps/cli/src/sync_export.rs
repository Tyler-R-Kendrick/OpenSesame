//! Stream bounded ciphertext pages into one owner-only JSON export.
use anyhow::Context;
use serde::Deserialize;
use std::{io::Write, path::Path};

#[derive(Deserialize, serde::Serialize)]
struct Cursor {
    epoch: u64,
    id: String,
}
#[derive(Deserialize, serde::Serialize)]
struct Blob {
    id: String,
    epoch: u64,
    ciphertext_epoch: u64,
    ciphertext_b64: String,
}
#[derive(Deserialize, serde::Serialize)]
struct Page {
    format: String,
    version: u32,
    blobs: Vec<Blob>,
    next_after: Option<Cursor>,
    has_more: bool,
}

pub async fn pull(
    client: &reqwest::Client,
    base: &str,
    token: &str,
    output: &Path,
    since_epoch: u64,
    device: Option<String>,
) -> anyhow::Result<()> {
    let mut after = Cursor {
        epoch: since_epoch.checked_add(1).context("invalid sync cursor")?,
        id: String::new(),
    };
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(output)?;
    file.write_all(
        b"{\"format\":\"opensesame-sync-export\",\"version\":2,\"framing\":\"jsonl\",\"plaintext\":null}\n",
    )?;
    for _ in 0..4096 {
        let response = client
            .post(format!("{base}/api/v1/sync/pull-page"))
            .bearer_auth(token)
            .json(&serde_json::json!({"after":after,"limit":32,"device_id":device}))
            .send()
            .await?
            .error_for_status()?;
        let page =
            tokio::time::timeout(std::time::Duration::from_secs(10), read_page(response)).await??;
        anyhow::ensure!(
            page.format == "opensesame-sync-page" && page.version == 2 && page.blobs.len() <= 64,
            "invalid sync page"
        );
        let mut previous = (after.epoch, after.id.as_str());
        for blob in &page.blobs {
            anyhow::ensure!(
                !blob.id.is_empty()
                    && blob.id.len() <= 128
                    && blob.ciphertext_b64.len() <= 2_796_204,
                "invalid sync blob"
            );
            anyhow::ensure!(
                (blob.epoch, blob.id.as_str()) > previous,
                "sync page did not advance"
            );
            previous = (blob.epoch, &blob.id);
        }
        if let Some(next) = &page.next_after {
            anyhow::ensure!(
                (next.epoch, next.id.as_str()) == previous
                    && previous > (after.epoch, after.id.as_str()),
                "invalid sync continuation"
            );
        }
        serde_json::to_writer(&mut file, &page)?;
        file.write_all(b"\n")?;
        if !page.has_more {
            file.write_all(b"{\"complete\":true}\n")?;
            file.sync_all()?;
            println!(
                "{}",
                serde_json::json!({"written":output,"plaintext":false,"version":2})
            );
            return Ok(());
        }
        after = page.next_after.context("missing sync continuation")?;
    }
    anyhow::bail!("sync page count exceeded; incomplete ciphertext export retained")
}

async fn read_page(mut response: reqwest::Response) -> anyhow::Result<Page> {
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        anyhow::ensure!(
            bytes.len() + chunk.len() <= 8 * 1024 * 1024,
            "sync response exceeds byte limit"
        );
        bytes.extend_from_slice(&chunk);
    }
    Ok(serde_json::from_slice(&bytes)?)
}
