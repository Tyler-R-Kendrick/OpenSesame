use super::*;
use crate::human_proof::TEST_HUMAN_PROOF;
use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionCase {
    id: String,
    terminal_session_id: String,
    other_terminal_session_id: Option<String>,
    action: String,
    idle_past_seconds: Option<u64>,
    hard_past_seconds: Option<u64>,
    pending_past_seconds: Option<u64>,
    query_as: Option<String>,
    expect_ensure: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
    session_cases: Vec<SessionCase>,
}

#[test]
fn tcp_transport_consumes_approval_once() {
    let mut store = CliAppIntegrationStore::new();
    store.set_now_ms(1_000);
    let id = "tcp-attempt-1";
    let (_, req) = store.ensure(id, "read", None, false);
    let request_id = req.expect("pending");
    let nonce = store
        .pending
        .get(&request_id)
        .map(|r| r.respond_nonce.clone())
        .unwrap_or_default();
    assert_eq!(
        store.approve(&request_id, id, &nonce, TEST_HUMAN_PROOF),
        "approved"
    );
    let (status, _) = store.ensure(id, "read", None, false);
    assert_eq!(status, "approved");
    let (status, _) = store.ensure(id, "read", None, false);
    assert_eq!(status, "pending");
}

#[test]
fn conformance_session_cases() {
    let raw: Fixture = serde_json::from_str(SOURCE).unwrap();
    for case in raw.session_cases {
        let mut store = CliAppIntegrationStore::new();
        store.set_now_ms(1_000_000);
        let pending = store.ensure(&case.terminal_session_id, "read", None, true);
        assert_eq!(pending.0, "pending", "case {}", case.id);
        let request_id = pending.1.expect("request id");
        if case.action == "approve" {
            let nonce = store
                .pending
                .get(&request_id)
                .map(|r| r.respond_nonce.clone())
                .expect("nonce");
            assert_eq!(
                store.approve(
                    &request_id,
                    &case.terminal_session_id,
                    &nonce,
                    TEST_HUMAN_PROOF,
                ),
                "approved"
            );
            if let Some(seconds) = case.idle_past_seconds {
                store.set_now_ms(1_000_000 + seconds * 1000);
            }
            if let Some(seconds) = case.hard_past_seconds {
                store.set_now_ms(1_000_000 + seconds * 1000);
            }
            let query_id = if case.query_as.as_deref() == Some("other") {
                case.other_terminal_session_id.as_deref().unwrap_or("missing")
            } else {
                case.terminal_session_id.as_str()
            };
            let (status, _) = store.ensure(query_id, "read", None, true);
            assert_eq!(
                status,
                case.expect_ensure.as_deref().expect("expectEnsure"),
                "case {}",
                case.id
            );
        } else if case.action == "pendingExpire" {
            if let Some(seconds) = case.pending_past_seconds {
                store.set_now_ms(1_000_000 + seconds * 1000);
            }
            assert!(store.list_pending().is_empty(), "case {}", case.id);
            let (status, _) = store.ensure(&case.terminal_session_id, "read", None, true);
            assert_eq!(status, "pending", "case {}", case.id);
        } else if case.action == "deny" {
            let nonce = store
                .pending
                .get(&request_id)
                .map(|r| r.respond_nonce.clone())
                .unwrap_or_default();
            assert_eq!(
                store.deny(&request_id, &case.terminal_session_id, &nonce),
                "denied"
            );
            let (status, _) = store.ensure(&case.terminal_session_id, "read", None, true);
            assert_eq!(status, "denied", "case {}", case.id);
        }
    }
}
