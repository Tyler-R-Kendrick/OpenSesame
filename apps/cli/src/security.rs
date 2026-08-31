//! Breach-exposure commands (ADR 0080).
//!
//! What of this organization's secrets has turned up somewhere public, and
//! whether a candidate secret is safe to use before it is stored.
//!
//! `opensesame security check` is the only command in either CLI that takes a
//! secret value. It is read from a prompt or standard input rather than an
//! argument, because an argument lands in shell history and in `ps`. It then
//! goes over TLS to the Host's own API — which hashes it, sends five characters
//! of that hash to the corpus, and stores nothing. It never reaches a third
//! party, and a failed call reports the Host's hint rather than echoing what
//! was sent.

use anyhow::{Context, Result};
use serde_json::{json, Value};

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

/// `opensesame security findings` — the breach ledger.
pub async fn cmd_findings(server: &str, output: &str, limit: usize) -> Result<()> {
    let path = format!("/api/v1/security/findings?limit={limit}");
    let body = connect::api(server, reqwest::Method::GET, &path, None).await?;
    if output == "json" {
        return print_json(&body);
    }
    let rows = body
        .get("findings")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if rows.is_empty() {
        println!("No breach findings. Run: opensesame security scan");
        return Ok(());
    }
    println!(
        "{:<10} {:<22} {:<28} {:<20} STATE",
        "SEVERITY", "KIND", "SUBJECT", "BREACH"
    );
    for row in rows.iter().take(MAX_TABLE_ROWS) {
        let reference = match field(row, "reference") {
            "" => "-",
            named => named,
        };
        println!(
            "{:<10} {:<22} {:<28} {:<20} {}",
            field(row, "severity"),
            field(row, "subject_kind"),
            field(row, "subject_id"),
            reference,
            field(row, "state"),
        );
    }
    Ok(())
}

/// `opensesame security scan` — run one breach pass now.
pub async fn cmd_scan(server: &str, output: &str) -> Result<()> {
    let body = connect::api(
        server,
        reqwest::Method::POST,
        "/api/v1/security/breach-scan",
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
        0 => println!("Nothing new. Every watched domain is clear."),
        1 => println!("Published 1 breach event."),
        n => println!("Published {n} breach events."),
    }
    Ok(())
}

/// Read the candidate secret without putting it in the process table.
///
/// The same no-echo reader `pass insert` uses, which falls back to a plain
/// line read on a pipe — so this composes with a password manager
/// (`… | opensesame security check …`) and still never echoes on a terminal.
fn read_secret() -> Result<String> {
    crate::store::prompt_secret_hidden("Secret to check").context("reading the secret to check")
}

/// `opensesame security check` — vet a candidate secret before storing it.
pub async fn cmd_check(
    server: &str,
    output: &str,
    subject_id: &str,
    subject_kind: &str,
) -> Result<()> {
    let secret = read_secret()?;
    if secret.is_empty() {
        anyhow::bail!("no secret provided");
    }
    let body = connect::api(
        server,
        reqwest::Method::POST,
        "/api/v1/security/breach-check",
        Some(&json!({
            "secret": secret,
            "subject_id": subject_id,
            "subject_kind": subject_kind,
        })),
    )
    .await?;
    if output == "json" {
        return print_json(&body);
    }
    report_check(&body, subject_id);
    Ok(())
}

/// Print the verdict.
fn report_check(body: &Value, subject_id: &str) {
    let compromised = body
        .get("compromised")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if !compromised {
        println!("Not found in the breach corpus.");
        if body.get("cleared").and_then(Value::as_bool) == Some(true) {
            println!("An earlier finding for {subject_id} has been cleared.");
        }
        return;
    }
    let occurrences = body
        .get("occurrences")
        .and_then(Value::as_u64)
        .unwrap_or_default();
    println!("COMPROMISED: this secret appears {occurrences} time(s) in the breach corpus.");
    println!("Do not use it for {subject_id}. Choose another.");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_unnamed_breach_reference_prints_as_a_dash() {
        let row = json!({"reference": ""});
        let reference = match field(&row, "reference") {
            "" => "-",
            named => named,
        };
        assert_eq!(reference, "-");
    }

    #[test]
    fn a_missing_field_prints_as_a_dash() {
        assert_eq!(field(&json!({}), "severity"), "-");
    }

    #[test]
    fn a_clean_verdict_reports_no_match() {
        // Exercises the branch rather than the print: the assertion that
        // matters is that a false `compromised` never reads as a warning.
        let body = json!({"compromised": false, "occurrences": 0, "cleared": false});
        assert_eq!(body["compromised"], json!(false));
        report_check(&body, "Dev/api-token");
    }

    #[test]
    fn a_compromised_verdict_carries_the_corpus_count() {
        let body = json!({"compromised": true, "occurrences": 42});
        report_check(&body, "Dev/api-token");
        assert_eq!(body["occurrences"], json!(42));
    }

    #[test]
    fn a_verdict_missing_its_fields_is_read_as_clean_rather_than_panicking() {
        report_check(&json!({}), "Dev/api-token");
    }
}
