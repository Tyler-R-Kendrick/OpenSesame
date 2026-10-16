use super::*;
use crate::test_support::{mint_test_human_proof, test_paired_binding};
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
    let (respond_nonce, verb) = {
        let row = store.pending.get(&request_id).expect("pending row");
        (row.respond_nonce.clone(), row.verb.clone())
    };
    let proof = mint_test_human_proof(&request_id, id, &respond_nonce, &verb);
    let binding = test_paired_binding();
    assert_eq!(
        store
            .approve(&request_id, id, &respond_nonce, &proof, &binding)
            .0,
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
    for scenario in raw.session_cases {
        let mut store = CliAppIntegrationStore::new();
        store.set_now_ms(1_000_000);
        let pending = store.ensure(&scenario.terminal_session_id, "read", None, true);
        assert_eq!(pending.0, "pending", "case {}", scenario.id);
        let request_id = pending.1.expect("request id");
        if scenario.action == "approve" {
            let (respond_nonce, verb) = {
                let pending_row = store.pending.get(&request_id).expect("nonce");
                (pending_row.respond_nonce.clone(), pending_row.verb.clone())
            };
            let proof = mint_test_human_proof(
                &request_id,
                &scenario.terminal_session_id,
                &respond_nonce,
                &verb,
            );
            let binding = test_paired_binding();
            assert_eq!(
                store
                    .approve(
                        &request_id,
                        &scenario.terminal_session_id,
                        &respond_nonce,
                        &proof,
                        &binding,
                    )
                    .0,
                "approved"
            );
            if let Some(seconds) = scenario.idle_past_seconds {
                store.set_now_ms(1_000_000 + seconds * 1000);
            }
            if let Some(seconds) = scenario.hard_past_seconds {
                store.set_now_ms(1_000_000 + seconds * 1000);
            }
            let query_id = if scenario.query_as.as_deref() == Some("other") {
                scenario
                    .other_terminal_session_id
                    .as_deref()
                    .unwrap_or("missing")
            } else {
                scenario.terminal_session_id.as_str()
            };
            let (status, _) = store.ensure(query_id, "read", None, true);
            assert_eq!(
                status,
                scenario.expect_ensure.as_deref().expect("expectEnsure"),
                "case {}",
                scenario.id
            );
        } else if scenario.action == "pendingExpire" {
            if let Some(seconds) = scenario.pending_past_seconds {
                store.set_now_ms(1_000_000 + seconds * 1000);
            }
            assert!(store.list_pending().is_empty(), "case {}", scenario.id);
            let (status, _) = store.ensure(&scenario.terminal_session_id, "read", None, true);
            assert_eq!(status, "pending", "case {}", scenario.id);
        } else if scenario.action == "deny" {
            let nonce = store
                .pending
                .get(&request_id)
                .map(|r| r.respond_nonce.clone())
                .unwrap_or_default();
            assert_eq!(
                store.deny(&request_id, &scenario.terminal_session_id, &nonce),
                "denied"
            );
            let (status, _) = store.ensure(&scenario.terminal_session_id, "read", None, true);
            assert_eq!(status, "denied", "case {}", scenario.id);
        }
    }
}
