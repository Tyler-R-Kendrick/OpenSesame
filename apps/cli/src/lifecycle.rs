//! Expiry lifecycle hook commands (ADR 0074).
//!
//! Every deadline the Host tracks, the subscriptions receiving them, and the
//! ledger showing whether those deliveries landed. All metadata: no command
//! here prints credential material, and the one secret that exists — a hook's
//! Standard Webhooks signing key — is shown once, at registration, because the
//! Host seals it and never returns it again.

use anyhow::{Context, Result};
use serde_json::{json, Value};

use crate::connect;

/// Rows printed before the table truncates. Long inventories are for `--output
/// json`, not for a terminal.
const MAX_TABLE_ROWS: usize = 50;

fn field<'a>(row: &'a Value, key: &str) -> &'a str {
    row.get(key).and_then(Value::as_str).unwrap_or("-")
}

fn print_json(body: &Value) -> Result<()> {
    println!("{}", serde_json::to_string_pretty(body)?);
    Ok(())
}

/// Human-readable "in 3d 4h" / "2h ago" for a seconds-remaining count.
fn humanize(seconds: i64) -> String {
    let overdue = seconds < 0;
    let magnitude = seconds.unsigned_abs();
    let (days, hours) = (magnitude / 86_400, (magnitude % 86_400) / 3_600);
    let span = if days > 0 {
        format!("{days}d {hours}h")
    } else if hours > 0 {
        format!("{hours}h")
    } else {
        format!("{}m", (magnitude % 3_600) / 60)
    };
    if overdue {
        format!("{span} ago")
    } else {
        format!("in {span}")
    }
}

/// `opensesame lifecycle expiring` — every tracked deadline.
pub async fn cmd_expiring(server: &str, output: &str) -> Result<()> {
    let body = connect::api(
        server,
        reqwest::Method::GET,
        "/api/v1/lifecycle/expiring",
        None,
    )
    .await?;
    if output == "json" {
        return print_json(&body);
    }
    let rows = body
        .get("subjects")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if rows.is_empty() {
        println!("Nothing with a tracked deadline on this Host.");
        return Ok(());
    }
    println!(
        "{:<22} {:<26} {:<14} {:<9} RESPONDER",
        "KIND", "SUBJECT", "EXPIRES", "AUTO"
    );
    for row in rows.iter().take(MAX_TABLE_ROWS) {
        let remaining = row
            .get("remaining_seconds")
            .and_then(Value::as_i64)
            .unwrap_or_default();
        println!(
            "{:<22} {:<26} {:<14} {:<9} {}",
            field(row, "subject_kind"),
            field(row, "subject_id"),
            humanize(remaining),
            if row.get("auto_respond").and_then(Value::as_bool) == Some(true) {
                "yes"
            } else {
                "no"
            },
            row.get("responder")
                .and_then(Value::as_str)
                .unwrap_or("subscriber"),
        );
    }
    if rows.len() > MAX_TABLE_ROWS {
        println!("… {} more (use --output json)", rows.len() - MAX_TABLE_ROWS);
    }
    Ok(())
}

/// `opensesame lifecycle hooks` — registered subscriptions.
pub async fn cmd_hooks(server: &str, output: &str) -> Result<()> {
    let body = connect::api(
        server,
        reqwest::Method::GET,
        "/api/v1/lifecycle/hooks",
        None,
    )
    .await?;
    if output == "json" {
        return print_json(&body);
    }
    let rows = body
        .get("hooks")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if rows.is_empty() {
        println!("No lifecycle hooks registered.");
        println!("Register one with: opensesame lifecycle hook add --name <n> --url <https://…>");
        return Ok(());
    }
    println!("{:<24} {:<10} {:<38} EVENTS", "NAME", "ENABLED", "ENDPOINT");
    for row in &rows {
        let events = row
            .get("event_types")
            .and_then(Value::as_array)
            .map(|list| {
                list.iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(",")
            })
            .unwrap_or_default();
        println!(
            "{:<24} {:<10} {:<38} {}",
            field(row, "name"),
            if row.get("enabled").and_then(Value::as_bool) == Some(true) {
                "yes"
            } else {
                "no"
            },
            field(row, "endpoint_url"),
            events,
        );
        if let Some(error) = row.get("last_error").and_then(Value::as_str) {
            println!("  last error: {error}");
        }
    }
    Ok(())
}

/// Registration inputs for [`cmd_hook_add`].
#[derive(Debug)]
pub struct HookOptions {
    pub name: String,
    pub url: String,
    pub events: Vec<String>,
    pub subject_kinds: Vec<String>,
}

/// `opensesame lifecycle hook add` — register a subscription.
///
/// The signing secret is printed once because the Host will not return it
/// again: it is sealed at rest and no route reads it back.
pub async fn cmd_hook_add(server: &str, output: &str, options: HookOptions) -> Result<()> {
    let mut body = json!({
        "name": options.name,
        "endpoint_url": options.url,
        "event_types": if options.events.is_empty() {
            vec!["lifecycle.*".to_string()]
        } else {
            options.events
        },
    });
    if !options.subject_kinds.is_empty() {
        body["subject_kinds"] = json!(options.subject_kinds);
    }
    let response = connect::api(
        server,
        reqwest::Method::PUT,
        "/api/v1/lifecycle/hooks",
        Some(&body),
    )
    .await?;
    if output == "json" {
        return print_json(&response);
    }
    println!("registered {}", field(&response, "id"));
    let secret = response
        .get("signing_secret")
        .and_then(Value::as_str)
        .context("the Host did not return a signing secret")?;
    println!("signing secret: {secret}");
    eprintln!(
        "Store this now — it is shown once and cannot be read back. Verify deliveries with any \
         Standard Webhooks library."
    );
    Ok(())
}

/// `opensesame lifecycle hook rm` — remove a subscription.
pub async fn cmd_hook_rm(server: &str, output: &str, id: &str) -> Result<()> {
    let path = format!("/api/v1/lifecycle/hooks/{id}");
    let body = connect::api(server, reqwest::Method::DELETE, &path, None).await?;
    if output == "json" {
        return print_json(&body);
    }
    println!("removed {id}");
    Ok(())
}

/// `opensesame lifecycle deliveries` — the outbound ledger.
pub async fn cmd_deliveries(server: &str, output: &str, limit: usize) -> Result<()> {
    let path = format!("/api/v1/lifecycle/deliveries?limit={limit}");
    let body = connect::api(server, reqwest::Method::GET, &path, None).await?;
    if output == "json" {
        return print_json(&body);
    }
    let rows = body
        .get("deliveries")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if rows.is_empty() {
        println!("No lifecycle deliveries yet.");
        return Ok(());
    }
    println!(
        "{:<30} {:<16} {:<26} {:<6} STATE",
        "EVENT", "KIND", "SUBJECT", "TRIES"
    );
    for row in rows.iter().take(MAX_TABLE_ROWS) {
        println!(
            "{:<30} {:<16} {:<26} {:<6} {}",
            field(row, "event_type"),
            field(row, "subject_kind"),
            field(row, "subject_id"),
            row.get("attempts").and_then(Value::as_i64).unwrap_or(0),
            field(row, "state"),
        );
        if let Some(error) = row.get("last_error").and_then(Value::as_str) {
            println!("  {error}");
        }
    }
    Ok(())
}

/// `opensesame lifecycle scan` — run one pass now.
pub async fn cmd_scan(server: &str, output: &str) -> Result<()> {
    let body = connect::api(
        server,
        reqwest::Method::POST,
        "/api/v1/lifecycle/scan",
        Some(&json!({})),
    )
    .await?;
    if output == "json" {
        return print_json(&body);
    }
    let published = body
        .get("published")
        .and_then(Value::as_i64)
        .unwrap_or_default();
    match published {
        0 => println!("Nothing newly crossed a threshold."),
        1 => println!("Published 1 lifecycle event."),
        n => println!("Published {n} lifecycle events."),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn humanize_reads_forwards_and_backwards() {
        assert_eq!(humanize(3 * 86_400 + 4 * 3_600), "in 3d 4h");
        assert_eq!(humanize(7_200), "in 2h");
        assert_eq!(humanize(600), "in 10m");
        assert_eq!(humanize(-7_200), "2h ago");
        assert_eq!(humanize(0), "in 0m");
    }

    #[test]
    fn humanize_survives_an_extreme_deadline() {
        // A never-run rotation schedule sits at the epoch, which is a very
        // large negative remaining count. Formatting it must not overflow.
        let rendered = humanize(i64::MIN);
        assert!(rendered.ends_with("ago"), "{rendered}");
    }

    #[test]
    fn a_missing_field_renders_as_a_dash_not_a_panic() {
        assert_eq!(field(&json!({}), "name"), "-");
        assert_eq!(field(&json!({"name": 7}), "name"), "-");
        assert_eq!(field(&json!({"name": "x"}), "name"), "x");
    }
}
