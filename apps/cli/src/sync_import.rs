//! Bounded, resumable restore of the paginated ciphertext export format.
use anyhow::Context;
use base64::{engine::general_purpose::STANDARD, Engine};
use std::{
    io::{BufRead, BufReader, Read},
    path::Path,
};

const LINE_LIMIT: u64 = 8 * 1024 * 1024;

fn line(reader: &mut impl BufRead) -> anyhow::Result<Option<serde_json::Value>> {
    let mut bytes = Vec::new();
    let size = reader.take(LINE_LIMIT + 1).read_until(b'\n', &mut bytes)?;
    if size == 0 {
        return Ok(None);
    }
    anyhow::ensure!(
        u64::try_from(size)? <= LINE_LIMIT,
        "sync export line exceeds limit"
    );
    Ok(Some(serde_json::from_slice(&bytes)?))
}

/// Returns false for legacy single-document input, leaving that bounded reader authoritative.
pub async fn try_push(
    client: &reqwest::Client,
    base: &str,
    token: &str,
    input: &Path,
) -> anyhow::Result<bool> {
    let mut reader = BufReader::new(std::fs::File::open(input)?);
    let header = match line(&mut reader) {
        Ok(Some(header)) => header,
        Ok(None) => anyhow::bail!("empty sync input"),
        Err(_) => return Ok(false),
    };
    if header["format"] != "opensesame-sync-export" {
        return Ok(false);
    }
    anyhow::ensure!(
        header["version"] == 2 && header["framing"] == "jsonl",
        "unsupported sync export"
    );
    let mut completed_page = false;
    for _ in 0..4097 {
        let page = line(&mut reader)?.context("incomplete sync export")?;
        if page["complete"] == true {
            anyhow::ensure!(
                completed_page && line(&mut reader)?.is_none(),
                "invalid export completion"
            );
            return Ok(true);
        }
        anyhow::ensure!(
            !completed_page && page["format"] == "opensesame-sync-page" && page["version"] == 2,
            "invalid sync export page"
        );
        let blobs = page["blobs"]
            .as_array()
            .filter(|rows| rows.len() <= 64)
            .context("invalid sync export blobs")?;
        for blob in blobs {
            push_blob(client, base, token, blob).await?;
        }
        completed_page = !page["has_more"].as_bool().context("invalid continuation")?;
    }
    anyhow::bail!("sync export page limit exceeded")
}

async fn push_blob(
    client: &reqwest::Client,
    base: &str,
    token: &str,
    blob: &serde_json::Value,
) -> anyhow::Result<()> {
    let id = blob["id"]
        .as_str()
        .filter(|id| !id.is_empty() && id.len() <= 128)
        .context("invalid sync id")?;
    let epoch = blob["ciphertext_epoch"]
        .as_u64()
        .context("missing ciphertext revision")?;
    let encoded = blob["ciphertext_b64"]
        .as_str()
        .filter(|bytes| bytes.len() <= 2_796_204)
        .context("invalid ciphertext length")?;
    let ciphertext = STANDARD.decode(encoded)?;
    anyhow::ensure!(
        ciphertext.len() <= 2 * 1024 * 1024,
        "ciphertext exceeds write limit"
    );
    let mut response = client
        .post(format!("{base}/api/v1/sync/push"))
        .bearer_auth(token)
        .json(&serde_json::json!({"blobs":[{"id":id,"epoch":epoch,"ciphertext":ciphertext}]}))
        .send()
        .await?
        .error_for_status()?;
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        anyhow::ensure!(
            body.len() + chunk.len() <= 16 * 1024,
            "sync write response exceeds limit"
        );
        body.extend_from_slice(&chunk);
    }
    let result: serde_json::Value = serde_json::from_slice(&body)?;
    anyhow::ensure!(
        result["accepted"] == 1,
        "sync restore refused a revision; earlier accepted ciphertext remains saved"
    );
    Ok(())
}
