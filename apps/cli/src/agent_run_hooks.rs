//! `opensesame access connectors rotate hooks <run>` — a Host-run agent's hook records (ADR 0159).
//!
//! A run the Host opened has no viewer key to seal a log to: ADR 0081 §9 puts
//! that key in the owner's client, and the Host never invents one, so the
//! sealed log `rotate watch` reads is empty by construction. What such a run
//! *does* have is the payload-free record of every agent-hooks verdict its
//! interceptors gave — interception point, decision, a machine reason, digests.
//! This verb reads it, and `rotate watch` falls back to it for those runs.
//!
//! Everything printed is value-blind by the shape of the route: there is no
//! member for a message, a target or a transform's value to print.

use anyhow::{bail, Context, Result};
use serde_json::Value;

use crate::connect;

/// Records a page asks for. The Host caps it at 256.
const PAGE: usize = 64;
/// How long `--follow` waits between empty pages.
const FOLLOW_INTERVAL: std::time::Duration = std::time::Duration::from_millis(750);
/// Consecutive empty pages before `--follow` gives the terminal back.
const FOLLOW_IDLE_LIMIT: u32 = 240;

fn field<'a>(row: &'a Value, key: &str) -> &'a str {
    row.get(key).and_then(Value::as_str).unwrap_or("-")
}

fn count(value: &Value, key: &str) -> i64 {
    value.get(key).and_then(Value::as_i64).unwrap_or(0)
}

/// One record as a table row.
fn row(record: &Value) -> String {
    format!(
        "{:<6} {:<15} {:<10} {:<4} {:<34} {:<7} {}",
        record.get("sequence").and_then(Value::as_i64).unwrap_or(-1),
        field(record, "interception_point"),
        field(record, "decision"),
        if record.get("escalated").and_then(Value::as_bool) == Some(true) {
            "yes"
        } else {
            "-"
        },
        field(record, "reason"),
        record
            .get("policy_version")
            .and_then(Value::as_i64)
            .map_or_else(|| "-".to_owned(), |version| format!("v{version}")),
        field(record, "recorded_at"),
    )
}

const HEADER: &str =
    "SEQ    POINT           DECISION   ESC  REASON                             POLICY  RECORDED";

/// `N records: a allow, d deny, t transform, e escalated` — counts only.
fn summary_line(summary: &Value) -> String {
    format!(
        "{} records: {} allow, {} deny, {} transform, {} escalated",
        count(summary, "count"),
        count(summary, "allow"),
        count(summary, "deny"),
        count(summary, "transform"),
        count(summary, "escalated"),
    )
}

/// A run id is a path segment. Refuse anything that would change the route.
fn checked(run_id: &str) -> Result<&str> {
    if run_id.is_empty() || run_id.contains(['/', '?', '#', '%', ' ']) {
        bail!(
            "`{run_id}` is not a run id; take one from `opensesame access connectors rotate runs`"
        );
    }
    Ok(run_id)
}

async fn page(server: &str, run_id: &str, after: i64) -> Result<Value> {
    let path = format!("/api/v1/agent/runs/{run_id}/hook-records?after={after}&limit={PAGE}");
    connect::api(server, reqwest::Method::GET, &path, None)
        .await
        .context("reading the run's hook records")
}

/// What the table has already said: the notice (once, however many polls it
/// takes for a first record) and the header (with the first record).
#[derive(Default)]
struct Said {
    notice: bool,
    header: bool,
}

/// Say what has not been said yet before a page's rows.
fn preface(said: &mut Said, notice: Option<&str>, has_records: bool, out: &mut dyn FnMut(String)) {
    if !said.notice {
        if let Some(notice) = notice {
            out(notice.to_owned());
        }
        said.notice = true;
    }
    if !said.header && has_records {
        out(HEADER.to_owned());
        said.header = true;
    }
}

/// Read a run's hook records from `after`, handing each line to `out`: one
/// page, or — with `follow` — every page as it lands.
///
/// `notice` is emitted once, before the first row, in table mode only; it is
/// how `rotate watch` says why it is showing these instead of a sealed log.
pub async fn observe_into(
    server: &str,
    output: &str,
    run_id: &str,
    (after, follow): (i64, bool),
    notice: Option<&str>,
    out: &mut dyn FnMut(String),
) -> Result<()> {
    let run_id = checked(run_id)?;
    let mut cursor = after;
    let mut idle = 0u32;
    let mut said = Said::default();
    loop {
        let body = page(server, run_id, cursor).await?;
        if output == "json" {
            out(serde_json::to_string_pretty(&body)?);
            return Ok(());
        }
        let records = body
            .get("records")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        preface(&mut said, notice, !records.is_empty(), out);
        for record in &records {
            out(row(record));
        }
        cursor = body
            .get("next_after")
            .and_then(Value::as_i64)
            .unwrap_or(cursor);
        if body.get("has_more").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        idle = if records.is_empty() { idle + 1 } else { 0 };
        if !follow || idle >= FOLLOW_IDLE_LIMIT {
            if !said.header {
                out("No hook records for this run yet.".to_owned());
            }
            if let Some(summary) = body.get("summary") {
                out(summary_line(summary));
            }
            return Ok(());
        }
        tokio::time::sleep(FOLLOW_INTERVAL).await;
    }
}

/// [`observe_into`], to standard output.
pub async fn observe(
    server: &str,
    output: &str,
    run_id: &str,
    position: (i64, bool),
    notice: Option<&str>,
) -> Result<()> {
    observe_into(server, output, run_id, position, notice, &mut |line| {
        println!("{line}");
    })
    .await
}

/// `opensesame access connectors rotate hooks <run>`.
pub async fn cmd_hooks(
    server: &str,
    output: &str,
    run_id: &str,
    after: i64,
    follow: bool,
) -> Result<()> {
    observe(server, output, run_id, (after, follow), None).await
}

/// What `rotate watch` says before it shows a keyless run's hook records.
pub const NO_SEALED_LOG: &str = "No sealed log: the Host opened this run and holds no viewer key \
     to seal one to (ADR 0081 §9). Its observation is the hook record:";

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_row_shows_the_verdict_and_nothing_else() {
        let line = row(&json!({
            "sequence": 2,
            "interception_point": "pre_tool_call",
            "decision": "deny",
            "escalated": true,
            "reason": "opensesame:tool_requires_approval",
            "policy_version": 3,
            "recorded_at": "2026-09-28T00:00:00+00:00",
            "input_identity": "sha256:aa",
        }));
        assert!(line.contains("pre_tool_call"), "{line}");
        assert!(line.contains("deny"), "{line}");
        assert!(line.contains("yes"), "{line}");
        assert!(line.contains("opensesame:tool_requires_approval"), "{line}");
        assert!(line.contains("v3"), "{line}");
        assert!(!line.contains("sha256"), "digests are for --output json");
        // A record with holes still prints a row.
        assert!(row(&json!({})).starts_with("-1"));
    }

    #[test]
    fn the_summary_line_is_counts_only() {
        let line = summary_line(&json!({
            "count": 5, "allow": 3, "deny": 1, "transform": 1, "escalated": 1,
            "last_sequence": 4,
        }));
        assert_eq!(line, "5 records: 3 allow, 1 deny, 1 transform, 1 escalated");
        assert_eq!(
            summary_line(&json!({})),
            "0 records: 0 allow, 0 deny, 0 transform, 0 escalated"
        );
    }

    #[test]
    fn a_run_id_cannot_change_the_route() {
        assert_eq!(checked("run_0190a1b2").unwrap(), "run_0190a1b2");
        for bad in ["", "run/../x", "run?after=1", "run#x", "run%2f", "run x"] {
            assert!(checked(bad).is_err(), "{bad}");
        }
    }

    /// What the stub Host was asked: request paths with their queries.
    type Seen = std::sync::Arc<std::sync::Mutex<Vec<String>>>;

    /// The stub Host's answer to `target`, noting that it was asked.
    fn answer(target: &str, seen: &Seen) -> http_body_util::Full<hyper::body::Bytes> {
        seen.lock().unwrap().push(target.to_owned());
        let record = |n: i64| {
            json!({
                "sequence": n, "interception_point": "pre_tool_call",
                "decision": "allow", "escalated": false, "reason": null,
                "policy_version": 1, "recorded_at": "2026-09-28T00:00:00+00:00",
            })
        };
        let summary = json!({
            "count": 3, "allow": 3, "deny": 0, "transform": 0, "escalated": 0,
            "last_sequence": 2,
        });
        let body = if target.contains("/log") {
            json!({"run_id": "run:1", "entries": [], "next_after": -1,
                   "sealed": true, "observation": "hook_records_only"})
        } else if target.contains("after=1&") {
            json!({"records": [record(2)], "next_after": 2, "has_more": false,
                   "summary": summary, "observation": "hook_records_only"})
        } else {
            json!({"records": [record(0), record(1)], "next_after": 1, "has_more": true,
                   "summary": summary, "observation": "hook_records_only"})
        };
        http_body_util::Full::new(hyper::body::Bytes::from(body.to_string()))
    }

    fn serve(stream: tokio::net::TcpStream, seen: Seen) {
        let service = hyper::service::service_fn(move |request: hyper::Request<_>| {
            let body = answer(&request.uri().to_string(), &seen);
            async move { Ok::<_, std::convert::Infallible>(hyper::Response::new(body)) }
        });
        let io = hyper_util::rt::TokioIo::new(stream);
        tokio::spawn(hyper::server::conn::http1::Builder::new().serve_connection(io, service));
    }

    async fn stub_host() -> (String, Seen) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let server = format!("http://{}", listener.local_addr().unwrap());
        let seen = Seen::default();
        let shared = seen.clone();
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                serve(stream, shared.clone());
            }
        });
        (server, seen)
    }

    #[tokio::test]
    async fn every_page_is_read_and_the_summary_closes_the_table() {
        std::env::set_var("OPENSESAME_OPERATOR_TOKEN", "t".repeat(40));
        let (server, seen) = stub_host().await;
        let mut lines = Vec::new();
        observe_into(
            &server,
            "table",
            "run:1",
            (-1, false),
            Some("notice"),
            &mut |line| lines.push(line),
        )
        .await
        .unwrap();
        assert_eq!(lines[0], "notice");
        assert_eq!(lines[1], HEADER);
        assert_eq!(lines.len(), 6, "{lines:?}");
        assert!(lines[2].starts_with('0') && lines[4].starts_with('2'));
        assert_eq!(
            lines[5],
            "3 records: 3 allow, 0 deny, 0 transform, 0 escalated"
        );
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 2, "{seen:?}");
        assert!(seen[0].contains("/api/v1/agent/runs/run:1/hook-records?after=-1"));
        assert!(seen[1].contains("after=1"), "the cursor moved: {seen:?}");
    }

    #[test]
    fn the_notice_is_said_once_however_long_the_first_record_takes() {
        let mut said = Said::default();
        let mut lines = Vec::new();
        for has_records in [false, false, true, true] {
            preface(&mut said, Some("notice"), has_records, &mut |l| {
                lines.push(l);
            });
        }
        assert_eq!(lines, ["notice", HEADER]);
    }

    #[tokio::test]
    async fn json_prints_the_page_as_the_host_sent_it() {
        std::env::set_var("OPENSESAME_OPERATOR_TOKEN", "t".repeat(40));
        let (server, _) = stub_host().await;
        let mut lines = Vec::new();
        observe_into(&server, "json", "run:1", (-1, false), None, &mut |line| {
            lines.push(line);
        })
        .await
        .unwrap();
        let page: Value = serde_json::from_str(&lines[0]).unwrap();
        assert_eq!(page["has_more"], json!(true));
        assert_eq!(page["observation"], json!("hook_records_only"));
    }

    /// `rotate watch` on a run with no sealed log reads its hook records.
    #[tokio::test]
    async fn watch_shows_hook_records_for_a_run_with_no_viewer_key() {
        std::env::set_var("OPENSESAME_OPERATOR_TOKEN", "t".repeat(40));
        let (server, seen) = stub_host().await;
        crate::agent_runs::cmd_watch(&server, "table", "run:1", -1, false)
            .await
            .unwrap();
        let seen = seen.lock().unwrap();
        assert!(seen[0].contains("/run:1/log?after=-1"), "{seen:?}");
        assert!(
            seen[1..].iter().all(|path| path.contains("/hook-records?")),
            "{seen:?}"
        );
        assert!(seen.len() >= 2);
    }
}
