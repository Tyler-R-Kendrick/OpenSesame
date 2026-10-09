//! `opensesame hooks decisions` — the audit of every agent-hooks verdict the
//! Host's remote interceptor has answered for the organization (ADR 0159).
//!
//! Newest first, `--limit` at a time, filterable by exact match on the
//! decision, the interception point, who asked, the reason and the policy
//! version, and by the time it was answered. Each row is value-blind — never a
//! tool name, a target or a message — so printing them is safe anywhere.
//! Owner/admin or operator work, like the policy it audits.
//!
//! `--all` follows the Host's cursor until the trail (or the filter) is
//! exhausted and prints one document; without it a page and its
//! `next_cursor` are printed, to pass back as `--cursor`.

use anyhow::{bail, Context, Result};
use clap::Args;
use reqwest::StatusCode;
use serde_json::{json, Value};

/// The Host API route.
const DECISIONS_PATH: &str = "/api/v1/agent-hooks/decisions";

/// Pages `--all` will follow before it stops. A trail of 90 days can be long;
/// a bound turns a runaway into an error that names it.
const MAX_PAGES: usize = 1_000;

#[derive(Args, Debug, Default)]
pub struct DecisionsArgs {
    /// Rows per page (1 to 100; the Host defaults to 50).
    #[arg(long)]
    pub limit: Option<u32>,
    /// Resume after a page: the `next_cursor` it printed.
    #[arg(long)]
    pub cursor: Option<String>,
    /// Follow every page and print the whole trail.
    #[arg(long, conflicts_with = "cursor")]
    pub all: bool,
    /// Only `allow`, `deny` or `transform` decisions.
    #[arg(long)]
    pub decision: Option<String>,
    /// Only decisions at this interception point (`pre_tool_call`, `output`, …).
    #[arg(long = "point")]
    pub interception_point: Option<String>,
    /// Only decisions asked for by this caller (`operator` or a principal).
    #[arg(long)]
    pub caller: Option<String>,
    /// Only decisions with this reason (`opensesame:raw_secret`, …).
    #[arg(long)]
    pub reason: Option<String>,
    /// Only escalations (`true`) or only non-escalations (`false`).
    #[arg(long)]
    pub escalated: Option<bool>,
    /// Only decisions made under this policy version.
    #[arg(long)]
    pub policy_version: Option<u64>,
    /// Only decisions answered at or after this RFC 3339 time.
    #[arg(long)]
    pub since: Option<String>,
    /// Only decisions answered before this RFC 3339 time.
    #[arg(long)]
    pub until: Option<String>,
}

impl DecisionsArgs {
    /// The query string for one page, `cursor` overriding `--cursor`.
    fn query(&self, cursor: Option<&str>) -> Vec<(&'static str, String)> {
        let mut query = Vec::new();
        let mut put = |name: &'static str, value: Option<String>| {
            if let Some(value) = value {
                query.push((name, value));
            }
        };
        put("limit", self.limit.map(|limit| limit.to_string()));
        put(
            "cursor",
            cursor.map(str::to_owned).or_else(|| self.cursor.clone()),
        );
        put("decision", self.decision.clone());
        put("interception_point", self.interception_point.clone());
        put("caller", self.caller.clone());
        put("reason", self.reason.clone());
        put("escalated", self.escalated.map(|flag| flag.to_string()));
        put("policy_version", self.policy_version.map(|v| v.to_string()));
        put("since", self.since.clone());
        put("until", self.until.clone());
        query
    }
}

struct Reply {
    status: StatusCode,
    body: Value,
}

/// One page, trying each stored credential the way every Host command does: a
/// 401/403 moves on to the next, anything else is the answer.
async fn fetch(server: &str, query: &[(&'static str, String)]) -> Result<Reply> {
    let url = format!("{}{DECISIONS_PATH}", server.trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(30))
        .build()?;
    let mut last = Reply {
        status: StatusCode::UNAUTHORIZED,
        body: json!({"error": "unauthorized"}),
    };
    for auth in crate::connect::authorization_headers() {
        let response = client
            .get(&url)
            .query(query)
            .header("authorization", &auth)
            .send()
            .await
            .context("calling Host API")?;
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        last = Reply {
            status,
            body: serde_json::from_str(&text).unwrap_or_else(|_| json!({})),
        };
        if status != StatusCode::UNAUTHORIZED && status != StatusCode::FORBIDDEN {
            break;
        }
    }
    Ok(last)
}

/// Why a call failed, from the Host's own error shape.
fn failure(reply: &Reply) -> String {
    let hint = reply
        .body
        .get("hint")
        .or_else(|| reply.body.get("error"))
        .and_then(Value::as_str)
        .unwrap_or(reply.status.as_str());
    format!("Host API {}: {hint}", reply.status)
}

/// Every page from the first, folded into one document shaped like a page
/// with no `next_cursor`.
fn fold(pages: &[Value]) -> Value {
    let retention = pages
        .first()
        .map_or(Value::Null, |page| page["retention_days"].clone());
    let decisions: Vec<Value> = pages
        .iter()
        .flat_map(|page| page["decisions"].as_array().cloned().unwrap_or_default())
        .collect();
    json!({"decisions": decisions, "next_cursor": null, "retention_days": retention})
}

/// What `--all` hands back when it stops at [`MAX_PAGES`]: the pages read so
/// far, with the cursor to resume from. An error would throw them away.
fn truncated(pages: &[Value], cursor: Option<String>) -> Value {
    let mut folded = fold(pages);
    folded["next_cursor"] = cursor.map_or(Value::Null, Value::String);
    folded
}

/// The document `opensesame hooks decisions` prints: one page, or with `--all`
/// every page folded together.
async fn collect(server: &str, args: &DecisionsArgs) -> Result<Value> {
    if !args.all {
        let reply = fetch(server, &args.query(None)).await?;
        if !reply.status.is_success() {
            bail!(failure(&reply));
        }
        return Ok(reply.body);
    }
    let mut pages = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let reply = fetch(server, &args.query(cursor.as_deref())).await?;
        if !reply.status.is_success() {
            bail!(failure(&reply));
        }
        cursor = reply.body["next_cursor"].as_str().map(str::to_owned);
        pages.push(reply.body);
        if cursor.is_none() {
            return Ok(fold(&pages));
        }
        if pages.len() >= MAX_PAGES {
            return Ok(truncated(&pages, cursor));
        }
    }
}

/// `opensesame hooks decisions …`.
pub async fn run(server: &str, args: DecisionsArgs) -> Result<()> {
    println!(
        "{}",
        serde_json::to_string_pretty(&collect(server, &args).await?)?
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stopping_at_the_page_cap_keeps_the_pages_and_the_cursor() {
        let pages = [
            json!({"decisions": [{"id": 1}], "retention_days": 30, "next_cursor": "1"}),
            json!({"decisions": [{"id": 2}], "retention_days": 30, "next_cursor": "2"}),
        ];
        let out = truncated(&pages, Some("2".into()));
        assert_eq!(out["decisions"].as_array().map(Vec::len), Some(2));
        assert_eq!(out["next_cursor"], "2");
        assert_eq!(out["retention_days"], 30);
    }

    #[test]
    fn only_what_was_asked_for_reaches_the_query() {
        assert!(DecisionsArgs::default().query(None).is_empty());
        let args = DecisionsArgs {
            limit: Some(20),
            decision: Some("deny".into()),
            interception_point: Some("pre_tool_call".into()),
            escalated: Some(true),
            policy_version: Some(3),
            since: Some("2026-09-01T00:00:00Z".into()),
            cursor: Some("90".into()),
            ..Default::default()
        };
        let query = args.query(None);
        let names: Vec<_> = query.iter().map(|(name, _)| *name).collect();
        assert_eq!(
            names,
            [
                "limit",
                "cursor",
                "decision",
                "interception_point",
                "escalated",
                "policy_version",
                "since"
            ]
        );
        assert!(query.contains(&("escalated", "true".into())));
        // A followed cursor replaces the one on the command line.
        assert!(args.query(Some("41")).contains(&("cursor", "41".into())));
    }

    #[test]
    fn pages_fold_into_one_trail() {
        let pages = vec![
            json!({"decisions": [{"id": 3}, {"id": 2}], "next_cursor": "2", "retention_days": 90}),
            json!({"decisions": [{"id": 1}], "next_cursor": null, "retention_days": 90}),
        ];
        let whole = fold(&pages);
        assert_eq!(whole["decisions"], json!([{"id": 3}, {"id": 2}, {"id": 1}]));
        assert_eq!(whole["next_cursor"], Value::Null);
        assert_eq!(whole["retention_days"], 90);
        assert_eq!(fold(&[])["decisions"], json!([]));
    }

    #[test]
    fn a_refusal_carries_the_hosts_hint() {
        let reply = Reply {
            status: StatusCode::BAD_REQUEST,
            body: json!({"error": "invalid_request", "hint": "limit is 1 to 100"}),
        };
        assert_eq!(
            failure(&reply),
            "Host API 400 Bad Request: limit is 1 to 100"
        );
        let bare = Reply {
            status: StatusCode::FORBIDDEN,
            body: json!({}),
        };
        assert_eq!(failure(&bare), "Host API 403 Forbidden: 403");
    }

    /// What the stub Host was asked: the query string and whether a
    /// credential came with it.
    type Seen = std::sync::Arc<std::sync::Mutex<Vec<(String, bool)>>>;

    fn answer(
        request: &hyper::Request<hyper::body::Incoming>,
        seen: &Seen,
    ) -> hyper::Response<http_body_util::Full<hyper::body::Bytes>> {
        let query = request.uri().query().unwrap_or_default().to_owned();
        let credential = request.headers().contains_key("authorization");
        seen.lock().unwrap().push((query.clone(), credential));
        let (status, body) = if query.contains("limit=101") {
            (
                400,
                json!({"error": "invalid_request", "hint": "limit is 1 to 100"}),
            )
        } else if query.contains("cursor=2") {
            (
                200,
                json!({"decisions": [{"id": 1}], "next_cursor": null, "retention_days": 90}),
            )
        } else {
            (
                200,
                json!({"decisions": [{"id": 3}, {"id": 2}], "next_cursor": "2", "retention_days": 90}),
            )
        };
        hyper::Response::builder()
            .status(status)
            .body(http_body_util::Full::new(hyper::body::Bytes::from(
                body.to_string(),
            )))
            .unwrap()
    }

    async fn serve(listener: tokio::net::TcpListener, seen: Seen) {
        while let Ok((stream, _)) = listener.accept().await {
            let seen = seen.clone();
            let service = hyper::service::service_fn(move |request| {
                std::future::ready(Ok::<_, std::convert::Infallible>(answer(&request, &seen)))
            });
            let io = hyper_util::rt::TokioIo::new(stream);
            tokio::spawn(hyper::server::conn::http1::Builder::new().serve_connection(io, service));
        }
    }

    async fn stub_host() -> (String, Seen) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let server = format!("http://{}", listener.local_addr().unwrap());
        let seen = Seen::default();
        tokio::spawn(serve(listener, seen.clone()));
        (server, seen)
    }

    #[tokio::test]
    async fn all_follows_the_cursor_and_carries_the_filter_and_a_credential() {
        std::env::set_var("OPENSESAME_OPERATOR_TOKEN", "t".repeat(40));
        let (server, seen) = stub_host().await;
        let args = DecisionsArgs {
            all: true,
            limit: Some(2),
            decision: Some("deny".into()),
            ..Default::default()
        };
        let whole = collect(&server, &args).await.unwrap();
        assert_eq!(whole["decisions"], json!([{"id": 3}, {"id": 2}, {"id": 1}]));
        assert_eq!(whole["next_cursor"], Value::Null);

        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 2, "one request per page");
        assert!(seen[0].0.contains("limit=2") && seen[0].0.contains("decision=deny"));
        assert!(!seen[0].0.contains("cursor="));
        assert!(seen[1].0.contains("cursor=2") && seen[1].0.contains("decision=deny"));
        assert!(seen.iter().all(|(_, credential)| *credential));
    }

    #[tokio::test]
    async fn one_page_prints_its_cursor_and_a_refusal_names_its_hint() {
        std::env::set_var("OPENSESAME_OPERATOR_TOKEN", "t".repeat(40));
        let (server, _) = stub_host().await;
        let page = collect(&server, &DecisionsArgs::default()).await.unwrap();
        assert_eq!(
            page["next_cursor"], "2",
            "a page is printed as the Host sent it"
        );

        let refused = collect(
            &server,
            &DecisionsArgs {
                limit: Some(101),
                ..Default::default()
            },
        )
        .await
        .unwrap_err();
        assert!(
            refused.to_string().contains("limit is 1 to 100"),
            "{refused}"
        );
    }
}
