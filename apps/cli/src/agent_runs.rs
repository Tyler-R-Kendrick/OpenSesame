//! Watching a sandboxed agent run from the terminal (ADR 0078).
//!
//! Everything here is metadata or ciphertext. `watch` streams the sealed
//! observation log and deliberately does **not** decrypt it: the log is sealed
//! to the owner's viewer key, which lives in the client plane, and a host CLI
//! that could open it would be a second place plaintext exists. What the
//! terminal shows is the shape of a run — which lane moved, when, and how far
//! along it is — which is what a person watching from a shell actually needs
//! before deciding to open the vault client and take the page.

use anyhow::{Context, Result};
use serde_json::Value;

use crate::connect;

/// Rows printed before the table truncates.
const MAX_TABLE_ROWS: usize = 50;

fn field<'a>(row: &'a Value, key: &str) -> &'a str {
    row.get(key).and_then(Value::as_str).unwrap_or("-")
}

fn print_json(body: &Value) -> Result<()> {
    println!("{}", serde_json::to_string_pretty(body)?);
    Ok(())
}

/// `opensesame rotate runs` — sandboxed runs and where each one is.
pub async fn cmd_runs(server: &str, output: &str) -> Result<()> {
    let body = connect::api(server, reqwest::Method::GET, "/api/v1/agent/runs", None).await?;
    if output == "json" {
        return print_json(&body);
    }
    let rows = body
        .get("runs")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if rows.is_empty() {
        println!("No sandboxed runs on this Host.");
        return Ok(());
    }
    println!(
        "{:<26} {:<30} {:<6} {:<18} {:<7} BLOCKED",
        "RUN", "ORIGIN", "TIER", "STATE", "DRIVER"
    );
    for row in rows.iter().take(MAX_TABLE_ROWS) {
        println!(
            "{:<26} {:<30} {:<6} {:<18} {:<7} {}",
            field(row, "id"),
            field(row, "origin"),
            field(row, "tier"),
            field(row, "control_state"),
            field(row, "driver"),
            field(row, "blocked_reason"),
        );
    }
    if rows.len() > MAX_TABLE_ROWS {
        println!(
            "... {} more; use --output json",
            rows.len() - MAX_TABLE_ROWS
        );
    }
    Ok(())
}

/// `opensesame rotate watch <run>` — read the observation log.
///
/// Reads the paged JSON view rather than the SSE stream: a stream that stays
/// open until it times out is a hang rather than a result, and a shell wants a
/// result. `--follow` polls that same page.
///
/// Prints position, lane, timestamp and ciphertext size — not content. See the
/// module docs for why a host CLI does not hold the viewer key.
pub async fn cmd_watch(
    server: &str,
    output: &str,
    run_id: &str,
    after: i64,
    follow: bool,
) -> Result<()> {
    let mut cursor = after;
    let mut idle = 0u32;
    let mut printed_header = false;
    loop {
        let path = format!("/api/v1/agent/runs/{run_id}/log?after={cursor}");
        let body = connect::api(server, reqwest::Method::GET, &path, None)
            .await
            .context("reading the observation log")?;
        if output == "json" {
            print_json(&body)?;
            return Ok(());
        }
        let entries = body
            .get("entries")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if entries.is_empty() {
            if !wait_for_more(follow, printed_header, &mut idle).await {
                return Ok(());
            }
            continue;
        }
        idle = 0;
        if !printed_header {
            println!("{:<8} {:<8} {:<26} SEALED BYTES", "SEQ", "LANE", "RECORDED");
            printed_header = true;
        }
        for entry in &entries {
            let sealed = entry
                .get("sealed_payload")
                .and_then(Value::as_str)
                .unwrap_or_default();
            println!(
                "{:<8} {:<8} {:<26} {}",
                entry.get("seq").and_then(Value::as_i64).unwrap_or(-1),
                field(entry, "lane"),
                field(entry, "recorded_at"),
                sealed.len(),
            );
        }
        cursor = body
            .get("next_after")
            .and_then(Value::as_i64)
            .unwrap_or(cursor);
        if !follow {
            return Ok(());
        }
    }
}

/// Handle an empty page. Returns whether to keep polling.
///
/// Split out because the alternative is three levels of branching inside the
/// read loop for what is one decision: is there more coming, and are we still
/// willing to wait for it.
async fn wait_for_more(follow: bool, printed_header: bool, idle: &mut u32) -> bool {
    if !follow {
        if !printed_header {
            println!("Nothing recorded for this run yet.");
        }
        return false;
    }
    *idle += 1;
    if *idle >= FOLLOW_IDLE_LIMIT {
        return false;
    }
    tokio::time::sleep(FOLLOW_INTERVAL).await;
    true
}

/// How long `--follow` waits between empty pages.
const FOLLOW_INTERVAL: std::time::Duration = std::time::Duration::from_millis(750);
/// Consecutive empty pages before `--follow` gives the terminal back.
const FOLLOW_IDLE_LIMIT: u32 = 240;

/// `opensesame rotate attach <run>` — ask the agent for the page.
///
/// Asking is all this does. Driving the page needs the viewer key and a client
/// that holds it, so the CLI's job ends at getting the run parked and telling
/// the operator where to go (ADR 0078 §8).
pub async fn cmd_attach(server: &str, output: &str, run_id: &str) -> Result<()> {
    let path = format!("/api/v1/agent/runs/{run_id}/handoff");
    let body = connect::api(server, reqwest::Method::POST, &path, None).await?;
    if output == "json" {
        return print_json(&body);
    }
    match body.get("status").and_then(Value::as_str) {
        Some("queued") => {
            println!("Queued. The agent is mid-submit; it will park when it finishes.");
        }
        Some("accepted") => {
            println!("Requested. The agent will park at its next step.");
        }
        _ => print_json(&body)?,
    }
    println!("Open the run in a client holding your vault key to take the page.");
    Ok(())
}
